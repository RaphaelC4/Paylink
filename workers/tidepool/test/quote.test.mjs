/* Phase 3 tests: server-side quote creation, signature verification and
 * payment-intent records for the Tidepool Worker (POST /quote).
 *
 * Covers the Part 8 list end to end: routing/admission, request
 * validation, contract lookup (get_link), eligibility gates, FRESH
 * /v0/tokens (the cached discovery is never authorization), the 201 happy
 * path with its exact response shape and full payment-intent record,
 * idempotent reuse and duplicate/concurrent request handling, bad
 * signatures (wrong key + post-sign tamper), REAL Tidepool-signed
 * fixtures verified under the default maker key, the state machine
 * (unit + Durable-Object level), deadline-driven reconciliation against
 * /v0/status (no polling), ambiguous-creation cooldowns and the
 * 4xx-vs-5xx classification, persistence failures, the data-driven
 * depositMode MEMO retry, env-tunable bounds, plus three repo-standard
 * sweeps: no signature/upstream detail/stack ever leaves this Worker,
 * every log line carries the M-01 envelope, and no log line carries a
 * signature or a deposit address.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts
 * Tidepool or a NEAR node. Quote responses are signed by the test file
 * itself under a per-run Ed25519 key injected via TIDEPOOL_MAKER_KEY —
 * mocks only, clearly distinguished from the two REAL Tidepool captures
 * in section 9 (which verify under Tidepool's published maker key, the
 * default). INTENT_DO is a harness that instantiates the real
 * PaymentIntent class against structuredClone-backed memory storage
 * (a non-cloneable record field would throw, i.e. fail loudly) with a
 * per-invoice promise queue emulating Durable Object input gates; one
 * test runs WITHOUT the queue to prove the CREATING checkpoint holds
 * under true interleaving. Date.now is pinned so deadline arithmetic is
 * deterministic.
 */

import worker, {
  PaymentIntent,
  clearDiscoveryCache,
  verifyQuoteSignature,
  validateQuoteResponse,
  buildQuoteRequest,
  stableStringify,
  b58encode,
  canTransition,
  applyTransition,
  isTerminal,
  mapTidepoolStatus,
  SPEC_STATES,
  INTERNAL_STATES,
  quoteWindowMs,
  ambiguousCooldownMs,
  makerKey,
} from "../src/index.js";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

/* Global log capture: worker log lines are single-line JSON — swallow and
   keep them (for the M-01 sweeps at the end); anything else (ok/FAIL,
   summary) passes through to stdout. */
const logs = [];
const baseLog = console.log;
console.log = (...a) => {
  const line = a.join(" ");
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* not a log line */ }
  if (parsed && parsed.svc && parsed.event) {
    logs.push(parsed);
    return;
  }
  baseLog(line);
};

const ORIGIN = "https://paylink-near.vercel.app";
const BASE = "https://tidepool.test";
const RPC = "https://rpc.test";
const DEST_ASSET = "nep141:usdc.tidepool-sandbox.testnet";
const SRC_NEAR = "nep141:wnear.tidepool-sandbox.testnet";
const SRC_USDT = "nep141:usdt.tidepool-sandbox.testnet";
const SRC_BASE = "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet";
const LINK_ID = "lnk-coffee-001";
const MERCHANT = "merchant.testnet";
/* Every mock quote gets a unique address "pa"+counter+filler; this
   pattern lets the sweeps find one in any body or log line. */
const ADDR_RE = /pa\d{6}abab/;

const realFetch = globalThis.fetch;
const realNow = Date.now;
const FIXED = Date.parse("2026-11-11T12:00:00.000Z");
let clock = FIXED;
Date.now = () => clock;
const advance = (ms) => { clock += ms; };

/* ── per-run signing identity (mock Tidepool signer for this file) ───── */
const testKeys = generateKeyPairSync("ed25519");
const TEST_MAKER =
  "ed25519:" + b58encode(new Uint8Array(Buffer.from(testKeys.publicKey.export({ format: "jwk" }).x, "base64url")));
const WRONG_KEYS = generateKeyPairSync("ed25519");

/* The 1Click/Tidepool signed-payload field lists, spelled out here on
   purpose (SDK quote-signature.ts ground truth — NOT imported from the
   worker, so sign and verify are independent implementations meeting on
   a known byte string). */
const REQ_SIGNED = [
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType",
  "destinationAsset", "amount", "refundTo", "refundType", "recipient",
  "recipientType", "deadline",
];
const COND_SIGNED = [
  "quoteWaitingTimeMs", "referral", "virtualChainRecipient",
  "virtualChainRefundRecipient", "customRecipientMsg",
];
const QUOTE_SIGNED = [
  "amountIn", "amountInFormatted", "amountInUsd", "minAmountIn",
  "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut",
];
/* Non-dry quotes sign the execution fields too (Tidepool
   /docs/guides/verify-quote-signatures); absent fields are omitted. */
const EXEC_SIGNED = [
  "depositAddress", "depositMemo", "deadline", "timeWhenInactive",
  "timeEstimate", "refundFee", "withdrawFee",
];

async function signQuoteResponse(resp, pair) {
  const request = {};
  for (const k of REQ_SIGNED) request[k] = resp.quoteRequest[k];
  for (const k of COND_SIGNED) if (resp.quoteRequest[k]) request[k] = resp.quoteRequest[k];
  const quote = {};
  for (const k of QUOTE_SIGNED) quote[k] = resp.quote[k];
  if (resp.quoteRequest.dry !== true) {
    for (const k of EXEC_SIGNED) if (resp.quote[k] !== undefined) quote[k] = resp.quote[k];
  }
  const dataStr = stableStringify({ ...request, ...quote, timestamp: resp.timestamp });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataStr));
  const b58hash = b58encode(new Uint8Array(hash));
  const sig = nodeSign(null, Buffer.from(b58hash), pair.privateKey);
  resp.signature = "ed25519:" + b58encode(new Uint8Array(sig));
  return resp;
}

/* ── fixtures ────────────────────────────────────────────────────────── */

const TOKENS = [
  {
    assetId: DEST_ASSET, decimals: 6, blockchain: "near", symbol: "USDC",
    price: 0.999531, priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "usdc.tidepool-sandbox.testnet", coingeckoId: "usd-coin",
  },
  {
    assetId: SRC_NEAR, decimals: 24, blockchain: "near", symbol: "wNEAR",
    price: 1.19, priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "wnear.tidepool-sandbox.testnet", coingeckoId: "near",
  },
  {
    assetId: SRC_USDT, decimals: 6, blockchain: "near", symbol: "USDT",
    price: 1.0, priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "usdt.tidepool-sandbox.testnet", coingeckoId: "tether",
  },
  {
    assetId: SRC_BASE, decimals: 6, blockchain: "base", symbol: "USDC",
    price: 0.999571, priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "0x38d81431B9f76d9699AF7517040D5221D9dEA252", coingeckoId: "usd-coin",
  },
];

const HEALTH = {
  ok: true,
  service: "tidepool",
  network: "testnet",
  checks: { rpc: { ok: true, height: 57227655, ms: 42 }, verifier: { ok: true, codeHashHex: "a1afab98" } },
  bridges: { chains: { base: { ok: true, name: "Base Sepolia" }, xrp: { ok: false, name: "XRP Ledger Testnet" } } },
};

const openLink = (over = {}) => ({
  link_id: LINK_ID,
  creator: MERCHANT,
  amount: "2500000",
  token: "usdc.tidepool-sandbox.testnet",
  description: "Coffee",
  created_at: 1762800000000,
  expires_at: null,
  status: "OPEN",
  paid_by: null,
  paid_amount: null,
  paid_at: null,
  claimed_at: null,
  ...over,
});

/* REAL Tidepool captures (community testnet, public data, 11 Nov 2026).
   DRY: no deposit instructions by design, so it is used for signature
   verification only. LIVE: full response, used for end-to-end
   validateQuoteResponse under the DEFAULT maker key at a pinned `now`. */
const DRY_FIXTURE = {
  correlationId: "2be521df-663f-4f71-b303-e9b37ba2ad04",
  timestamp: "2026-11-11T09:16:10.614Z",
  quoteRequest: {
    dry: true, swapType: "EXACT_OUTPUT", slippageTolerance: 100,
    originAsset: "nep141:usdc.tidepool-sandbox.testnet", depositType: "INTENTS",
    destinationAsset: "nep141:usdt.tidepool-sandbox.testnet", amount: "1000000",
    refundTo: "alice.testnet", refundType: "INTENTS", recipient: "bob.testnet",
    recipientType: "DESTINATION_CHAIN", deadline: "2030-01-01T00:00:00.000Z",
  },
  quote: {
    amountIn: "1009704", amountInFormatted: "1.009704", amountInUsd: "1.0092",
    minAmountIn: "999707", amountOut: "1000000", amountOutFormatted: "1",
    amountOutUsd: "0.9991", minAmountOut: "1000000", timeEstimate: 10,
  },
  signature: "ed25519:5SWnNPjRsUYPwLcYuKkNxqUdd6Y7g6abPZ2i7rWxXkkNabqzC5PExHooVhi15TKBhd5Mvm2gnf6BpWAcjFMe8acB",
};

const LIVE_FIXTURE = {
  correlationId: "b4cfa71f-1dd6-4b10-8463-b92a247a3b31",
  timestamp: "2026-11-11T09:51:07.685Z",
  quoteRequest: {
    swapType: "EXACT_OUTPUT", slippageTolerance: 100, dry: false,
    destinationAsset: DEST_ASSET, amount: "2500000", recipient: MERCHANT,
    recipientType: "DESTINATION_CHAIN", deadline: "2026-11-11T21:51:06.393Z",
    originAsset: SRC_NEAR, depositType: "INTENTS",
    refundTo: "payer.testnet", refundType: "INTENTS",
  },
  quote: {
    amountIn: "702488059452237833470205",
    amountInFormatted: "0.702488059452237833470205",
    amountInUsd: "2.5290",
    minAmountIn: "695532732130928547990302",
    amountOut: "2500000", amountOutFormatted: "2.5", amountOutUsd: "2.4989",
    minAmountOut: "2500000", timeEstimate: 10,
    depositAddress: "11e0c3d44396893877599cacf8a04cf471d6a33045fb2edf249535eb32882740",
    deadline: "2026-11-11T21:51:06.393Z",
    timeWhenInactive: "2026-11-11T21:51:06.393Z",
  },
  signature: "ed25519:91G75z7kHS2h5ScMon8EjzoeCPKtxYTWJKQEBheCaevmeogULHsYM7okGhnm6RrDCb52WTmNyh5bcwd7qVtizqA",
};
const LIVE_NOW = Date.parse("2026-11-11T10:30:00.000Z"); // inside the 12h deadline

/* ── Durable Object harness ──────────────────────────────────────────── */

function makeIntentDO(env, opts = {}) {
  const instances = new Map();
  let putCount = 0;
  const getInst = (name) => {
    if (!instances.has(name)) {
      instances.set(name, { store: new Map(), queue: Promise.resolve() });
    }
    const inst = instances.get(name);
    if (!inst.storage) {
      inst.storage = {
        async get(k) {
          if (opts.getFail) throw new Error("kv read down");
          const v = inst.store.get(k);
          return v === undefined ? undefined : structuredClone(v);
        },
        async put(k, v) {
          putCount++;
          if (opts.failPutAt && putCount === opts.failPutAt) throw new Error("kv write down");
          inst.store.set(k, structuredClone(v)); // non-cloneable record fields throw here
        },
      };
    }
    return inst;
  };
  return {
    instances,
    /* Seed a record directly (state-machine tests). */
    seed(name, record) {
      getInst(name).store.set("record", structuredClone(record));
    },
    /* Real namespace shape: idFromName returns an opaque id; only get(id)
       returns the stub whose fetch reaches the object. The workerd run
       proved the source needs this exact two-step form — a harness that
       hands the stub straight from idFromName would mask it. */
    idFromName(name) {
      return { name };
    },
    get(id) {
      const name = id && id.name;
      if (typeof name !== "string") throw new Error("durable object id invalid");
      const inst = getInst(name);
      const obj = new PaymentIntent({ storage: inst.storage }, env);
      const run = (request) => {
        /* serialize:false removes the input-gate emulation so a second
           request can interleave with a first one parked on its upstream
           call — the CREATING checkpoint must carry correctness alone. */
        if (opts.serialize === false) return obj.fetch(request);
        const p = inst.queue.then(() => obj.fetch(request));
        inst.queue = p.then(() => {}, () => {});
        return p;
      };
      return { fetch: run };
    },
  };
}

function makeEnv(over = {}, doOpts = {}) {
  const env = {
    ALLOWED_ORIGIN: ORIGIN,
    TIDEPOOL_ORIGIN: BASE,
    RPC_URL: RPC,
    TIDEPOOL_CACHE_MS: "0",
    TIDEPOOL_TIMEOUT_MS: "2000",
    TIDEPOOL_MAKER_KEY: TEST_MAKER,
    TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "60000",
    ...over,
  };
  env.INTENT_DO = makeIntentDO(env, doOpts);
  return env;
}

const getRecord = (env, linkId = LINK_ID) => {
  const inst = env.INTENT_DO.instances.get(linkId);
  return inst ? inst.store.get("record") : undefined;
};

/* ── upstream router ─────────────────────────────────────────────────── */

const jsonResp = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const hangResponse = (init) => new Promise((_resolve, reject) => {
  const sig = init && init.signal;
  if (!sig) { reject(new Error("no signal")); return; }
  sig.addEventListener("abort", () => reject(new Error("The operation was aborted")));
});

const rpcEnvelope = (value) => {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return jsonResp(200, { jsonrpc: "2.0", id: "1", result: { result: bytes, logs: [] } });
};

let cidCounter = 0;
let addrCounter = 0;
const nextAddress = () => `pa${String(++addrCounter).padStart(6, "0")}${"ab".repeat(60)}`;

async function makeSignedQuote(state, init) {
  const sent = JSON.parse(init.body);
  const amount = BigInt(sent.amount);
  const resp = {
    correlationId: `cid-test-${++cidCounter}`,
    timestamp: new Date(clock).toISOString(),
    quoteRequest: { ...sent },
    quote: {
      amountIn: String(amount + 1000n),
      amountInFormatted: "1",
      amountInUsd: "1.00",
      minAmountIn: String(amount + 900n),
      amountOut: String(amount),
      amountOutFormatted: "1",
      amountOutUsd: "1.00",
      minAmountOut: String(amount),
      timeEstimate: 10,
      depositAddress: state.depositAddress || nextAddress(),
      deadline: sent.deadline,
    },
  };
  /* memo-required chains: the worker's single data-driven retry asks for
     MEMO, and Tidepool then answers with a memo the payer must include. */
  if (sent.depositMode === "MEMO") resp.quote.depositMemo = "memo-12345";
  await signQuoteResponse(resp, state.signKeyPair || testKeys);
  if (typeof state.mutateAfterSign === "function") state.mutateAfterSign(resp);
  return jsonResp(200, resp);
}

function stubNet(opts = {}) {
  clearDiscoveryCache();
  const state = {
    tokens: opts.tokens || TOKENS,
    link: "link" in opts ? opts.link : openLink(),
    rpcMode: opts.rpcMode || "ok",
    tokensMode: opts.tokensMode || "ok",
    quoteMode: opts.quoteMode || "ok",
    statusMode: opts.statusMode || "ok",
    statusBody: opts.statusBody || { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T12:00:00.000Z" },
    depositAddress: opts.depositAddress,
    signKeyPair: opts.signKeyPair || testKeys,
    mutateAfterSign: opts.mutateAfterSign,
    calls: { rpc: [], tokens: [], health: [], quote: [], status: [] },
  };

  const rpcLeg = (init) => {
    if (state.rpcMode === "hang") return hangResponse(init);
    if (state.rpcMode === "http500") return jsonResp(500, { error: { message: "RPC-DETAIL-MARKER " + "x".repeat(300) } });
    if (state.rpcMode === "badshape") return jsonResp(200, { jsonrpc: "2.0", id: "1", result: { logs: [] } });
    if (state.rpcMode === "panic") {
      return jsonResp(200, { jsonrpc: "2.0", id: "1", result: { error: { name: "ERR", cause: "panicked" }, result: [] } });
    }
    return rpcEnvelope(state.link);
  };

  const tokensLeg = (init) => {
    if (state.tokensMode === "hang") return hangResponse(init);
    if (state.tokensMode === "http500") {
      return jsonResp(500, { error: { message: "UPSTREAM-DETAIL-MARKER tokens " + "x".repeat(300) } });
    }
    if (state.tokensMode === "badshape") return jsonResp(200, { tokens: [] });
    return jsonResp(200, state.tokens);
  };

  const quoteLeg = async (init) => {
    const mode = state.quoteMode;
    if (typeof mode === "function") return mode(init, state);
    if (mode === "hang") return hangResponse(init);
    if (mode === "http400") return jsonResp(400, { message: "slippageTolerance out of range" });
    if (mode === "http500") return jsonResp(500, { message: "QUOTE-UPSTREAM-DETAIL-MARKER " + "x".repeat(300) });
    if (mode === "garbage200") {
      return new Response("<<<not json>>>", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (mode === "schema") {
      return jsonResp(200, { correlationId: 12345, quoteRequest: null, quote: null, timestamp: null, signature: null });
    }
    if (mode === "badsig") {
      const saved = state.signKeyPair;
      state.signKeyPair = WRONG_KEYS;
      const r = await makeSignedQuote(state, init);
      state.signKeyPair = saved;
      return r;
    }
    if (mode === "tampered") {
      const saved = state.mutateAfterSign;
      state.mutateAfterSign = (resp) => { resp.quote.amountInFormatted = "9.9.9"; };
      const r = await makeSignedQuote(state, init);
      state.mutateAfterSign = saved;
      return r;
    }
    if (mode === "memo400") {
      const sent = JSON.parse(init.body);
      if (!sent.depositMode) return jsonResp(400, { message: "depositMode must be MEMO for this chain" });
    }
    return makeSignedQuote(state, init);
  };

  const statusLeg = (init) => {
    if (state.statusMode === "hang") return hangResponse(init);
    if (state.statusMode === "http500") return jsonResp(500, { message: "STATUS-DETAIL-MARKER " + "x".repeat(300) });
    if (state.statusMode === "not_found") return jsonResp(404, { message: "Deposit address not found" });
    if (state.statusMode === "unknown") {
      return jsonResp(200, { status: "SOMETHING_ELSE", updatedAt: "2026-11-11T12:00:00.000Z" });
    }
    return jsonResp(200, state.statusBody);
  };

  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(RPC)) { state.calls.rpc.push({ url: u, init }); return rpcLeg(init); }
    if (u.includes("/v0/tokens")) { state.calls.tokens.push({ url: u, init }); return tokensLeg(init); }
    if (u.includes("/v0/health")) { state.calls.health.push({ url: u, init }); return jsonResp(200, HEALTH); }
    if (u.includes("/v0/quote")) { state.calls.quote.push({ url: u, init }); return quoteLeg(init); }
    if (u.includes("/v0/status")) { state.calls.status.push({ url: u, init }); return statusLeg(init); }
    return Promise.reject(new TypeError("unexpected upstream fetch: " + u));
  };
  return state;
}

/* ── request helpers ─────────────────────────────────────────────────── */

const bodies = [];      // every response body, joined for the leak sweep
const entries = [];     // {status, text} for status-scoped sweep assertions

async function send(method, path, body, env, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined && body !== null) {
    init.headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await worker.fetch(new Request(`https://paylink.test${path}`, init), env);
  const text = await res.clone().text();
  bodies.push(text);
  entries.push({ status: res.status, text });
  let out = null;
  try { out = JSON.parse(text); } catch { /* asserted as text */ }
  return { res, text, out };
}

const defaultBody = (over = {}) => ({
  linkId: LINK_ID,
  blockchain: "near",
  assetId: SRC_NEAR,
  refundTo: "payer.testnet",
  idempotencyKey: "key-1",
  ...over,
});

const postQuote = (env, body = defaultBody(), headers = {}) => send("POST", "/quote", body, env, headers);
const getNetworks = (env, headers = {}) => send("GET", "/networks", undefined, env, headers);

/* ── tests ───────────────────────────────────────────────────────────── */

try {
  clock = FIXED;

  /* ── 1. routing & admission (Phase 2 contract preserved) ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const opt = await send("OPTIONS", "/quote", null, env);
    ok(opt.res.status === 204, "OPTIONS -> 204");
    ok((opt.res.headers.get("access-control-allow-methods") || "").includes("POST"),
      "CORS allow-methods advertises POST");

    const p405 = await send("POST", "/networks", null, env);
    ok(p405.res.status === 405 && p405.res.headers.get("allow") === "GET",
      "POST /networks -> 405 + Allow: GET");

    const g405 = await send("GET", "/quote", null, env);
    ok(g405.res.status === 405 && g405.res.headers.get("allow") === "POST",
      "GET /quote -> 405 + Allow: POST");

    const n404 = await send("POST", "/nope", "{}", env);
    ok(n404.res.status === 404 && n404.out.error === "not found", "unknown path -> 404 whatever the verb");
    ok(n404.res.headers.get("x-request-id") === null, "404 carries no correlation id (deploy signal)");

    const evil = await postQuote(env, undefined, { Origin: "https://evil.test" });
    ok(evil.res.status === 403 && evil.out.error === "Origin not allowed", "foreign Origin -> 403");

    const cl = await postQuote(env, defaultBody(), { "content-length": "99999" });
    ok(cl.res.status === 413 && cl.out.code === "payload_too_large",
      "oversized declared Content-Length -> 413 before the body is read");

    const big = await postQuote(env, JSON.stringify({ junk: "x".repeat(9000) }));
    ok(big.res.status === 413 && big.out.code === "payload_too_large", "oversized actual body -> 413");

    ok(state.calls.rpc.length === 0 && state.calls.tokens.length === 0 && state.calls.quote.length === 0,
      "routing/admission rejections never reach upstream");

    stubNet();
    const okOrigin = await postQuote(env, undefined, { Origin: ORIGIN });
    ok(okOrigin.res.status === 201, "allowed Origin passes the gate (full flow)");
  }

  /* ── 2. request validation & the same-asset gate ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const bad = await postQuote(env, "{not json");
    ok(bad.res.status === 400 && bad.out.code === "invalid_json", "malformed JSON -> 400 invalid_json");

    const noLink = await postQuote(env, defaultBody({ linkId: "abc" }));
    ok(noLink.res.status === 400 && noLink.out.code === "invalid_link_id", "linkId outside 4-64 -> 400 invalid_link_id");

    const noAsset = await postQuote(env, { linkId: LINK_ID, blockchain: "near", refundTo: "payer.testnet" });
    ok(noAsset.res.status === 400 && noAsset.out.code === "invalid_asset_id", "missing assetId -> 400");

    const noChain = await postQuote(env, defaultBody({ blockchain: " " }));
    ok(noChain.res.status === 400 && noChain.out.code === "invalid_blockchain", "missing blockchain -> 400");

    const noRefund = await postQuote(env, defaultBody({ refundTo: "" }));
    ok(noRefund.res.status === 400 && noRefund.out.code === "invalid_refund_to", "missing refundTo -> 400");

    const longKey = await postQuote(env, defaultBody({ idempotencyKey: "k".repeat(129) }));
    ok(longKey.res.status === 400 && longKey.out.code === "invalid_idempotency_key",
      "idempotencyKey over 128 -> 400");

    const same = await postQuote(env, defaultBody({ assetId: DEST_ASSET }));
    ok(same.res.status === 400 && same.out.code === "same_asset_source",
      "source === destination asset -> 400 same_asset_source (matches the live upstream rejection)");
    ok(state.calls.rpc.length === 0 && state.calls.quote.length === 0 && state.calls.tokens.length === 0,
      "field/same-asset rejections happen before ANY upstream call");
  }

  /* ── 3. contract lookup (get_link) ── */
  {
    let state = stubNet({ rpcMode: "http500" });
    let env = makeEnv({ TIDEPOOL_TIMEOUT_MS: "50" });
    let r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "invoice_lookup_failed", "RPC 5xx -> 502 invoice_lookup_failed");
    ok(!r.text.includes("RPC-DETAIL-MARKER"), "…and the RPC detail stays server-side");

    state = stubNet({ rpcMode: "badshape" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "invoice_lookup_failed", "undecodable RPC result -> 502");

    state = stubNet({ rpcMode: "panic" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "invoice_lookup_failed", "contract panic -> 502 (definitive)");

    state = stubNet({ rpcMode: "hang" });
    env = makeEnv({ TIDEPOOL_TIMEOUT_MS: "50" });
    r = await postQuote(env);
    ok(r.res.status === 504 && r.out.code === "invoice_lookup_timeout", "hung RPC -> 504 invoice_lookup_timeout");

    state = stubNet({ link: null });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 404 && r.out.code === "invoice_not_found", "nonexistent link -> 404 invoice_not_found");

    state = stubNet({ link: { ...openLink(), amount: "abc" } });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "invoice_malformed",
      "contract answered with garbage amounts -> 502 invoice_malformed");

    /* the query itself: right node, right method, right args */
    state = stubNet();
    env = makeEnv({ CONTRACT_ID: "paylink-v3.testnet" });
    await postQuote(env);
    const call = state.calls.rpc[0];
    const rpcBody = JSON.parse(call.init.body);
    const args = JSON.parse(Buffer.from(rpcBody.params.args_base64, "base64").toString());
    ok(call.url === RPC && rpcBody.method === "query", "get_link goes to RPC_URL via JSON-RPC query");
    ok(rpcBody.params.account_id === "paylink-v3.testnet" && rpcBody.params.method_name === "get_link",
      "…against CONTRACT_ID with method get_link");
    ok(args.link_id === LINK_ID, "…with the requested link id as base64 args");
  }

  /* ── 4. eligibility: contract truth, never the frontend's word ── */
  {
    for (const [status, code] of [
      ["PAID", "invoice_settled"],
      ["CLAIMED", "invoice_settled"],
      ["CANCELLED", "invoice_cancelled"],
      ["EXPIRED", "invoice_expired"],
    ]) {
      stubNet({ link: openLink({ status }) });
      const r = await postQuote(makeEnv());
      ok(r.res.status === 409 && r.out.code === code, `link status ${status} -> 409 ${code}`);
    }

    stubNet({ link: openLink({ token: "wnear.tidepool-sandbox.testnet" }) });
    const rToken = await postQuote(makeEnv());
    ok(rToken.res.status === 409 && rToken.out.code === "invoice_token_unsupported",
      "invoice not denominated in the destination USDC -> 409 invoice_token_unsupported");

    const state = stubNet({ link: openLink({ expires_at: clock + 30_000 }) });
    const rExp = await postQuote(makeEnv());
    ok(rExp.res.status === 409 && rExp.out.code === "invoice_expiry_too_soon",
      "invoice expiring inside the 60 s floor -> 409 invoice_expiry_too_soon");
    ok(state.calls.tokens.length === 0, "…and eligibility runs before the tokens leg");
  }

  /* ── 5. FRESH /v0/tokens — the cached discovery is never authorization ── */
  {
    /* warm the discovery cache with the base asset present… */
    let state = stubNet();
    let env = makeEnv({ TIDEPOOL_CACHE_MS: "60000" });
    const warm = await getNetworks(env);
    ok(warm.res.status === 200 && Array.isArray(warm.out.networks), "discovery succeeds first (cache warmed)");

    /* …then upstream drops it; /quote must see the fresh reality… */
    state.tokens = TOKENS.filter((t) => t.assetId !== SRC_BASE);
    const r = await postQuote(env, defaultBody({ blockchain: "base", assetId: SRC_BASE }));
    ok(r.res.status === 400 && r.out.code === "asset_unsupported",
      "asset removed upstream -> /quote 400 asset_unsupported despite warm cache");

    /* …while /networks still answers from the stale cache (documented). */
    const stale = await getNetworks(env);
    const baseStillListed = JSON.stringify(stale.out).includes(SRC_BASE);
    ok(stale.out && stale.out.cached === true && baseStillListed,
      "/networks serves the cached stale entry — proving /quote did NOT consult it");

    state = stubNet({ tokensMode: "http500" });
    env = makeEnv();
    const t500 = await postQuote(env);
    ok(t500.res.status === 502 && t500.out.code === "tokens_unavailable", "tokens 5xx -> 502 tokens_unavailable");
    ok(!t500.text.includes("UPSTREAM-DETAIL-MARKER"), "…without the upstream marker");

    state = stubNet({ tokensMode: "badshape" });
    env = makeEnv();
    const tBad = await postQuote(env);
    ok(tBad.res.status === 502 && tBad.out.code === "tokens_unavailable", "tokens body not an array -> 502");

    state = stubNet({ tokensMode: "hang" });
    env = makeEnv({ TIDEPOOL_TIMEOUT_MS: "50" });
    const tHang = await postQuote(env);
    ok(tHang.res.status === 504 && tHang.out.code === "tokens_unavailable", "hung tokens leg -> 504");

    state = stubNet({ tokens: TOKENS.filter((t) => t.assetId !== DEST_ASSET) });
    env = makeEnv();
    const noDest = await postQuote(env);
    ok(noDest.res.status === 502 && noDest.out.code === "destination_unavailable",
      "destination asset missing upstream -> 502 destination_unavailable");

    state = stubNet();
    env = makeEnv();
    const mismatch = await postQuote(env, defaultBody({ blockchain: "near", assetId: SRC_BASE }));
    ok(mismatch.res.status === 400 && mismatch.out.code === "network_token_mismatch",
      "asset on another network -> 400 network_token_mismatch");
  }

  /* ── 6. happy path: 201, exact response shape, full record ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const r = await postQuote(env);
    ok(r.res.status === 201, "valid OPEN invoice -> 201 Created");
    ok(r.out.ok === true && r.out.reused === false, "body says ok, reused:false");
    ok(JSON.stringify(Object.keys(r.out).sort()) === '["intent","ok","onChainStatus","reused"]',
      "top-level response has exactly {ok,reused,intent,onChainStatus}");
    const INTENT_KEYS = [
      "intentId", "linkId", "status", "depositAddress", "depositMemo", "source", "destination",
      "merchant", "invoiceAmount", "expectedInputAmount", "minInputAmount", "expectedOutputAmount",
      "quoteDeadline", "correlationId", "tidepoolStatus", "createdAt", "updatedAt",
    ].sort();
    ok(JSON.stringify(Object.keys(r.out.intent).sort()) === JSON.stringify(INTENT_KEYS),
      "intent has exactly the documented 17 fields");
    ok(!r.text.includes('"signature"') && !r.text.includes("ed25519:"),
      "the signature never leaves the server");
    ok(!r.text.includes("sentQuoteRequest"), "the raw signed payload never leaves the server");

    const it = r.out.intent;
    ok(/^pi_[0-9a-f]{16}$/.test(it.intentId), "intentId is machine-generated");
    ok(it.status === "AWAITING_DEPOSIT", "state machine lands on AWAITING_DEPOSIT");
    ok(it.linkId === LINK_ID && it.merchant === MERCHANT, "merchant/link come from the contract");
    ok(it.invoiceAmount === "2500000", "invoice amount comes from the contract (base units, string)");
    ok(typeof it.depositAddress === "string" && ADDR_RE.test(it.depositAddress) && it.depositMemo === null,
      "deposit instructions present (address, no memo on the NEAR rail)");
    ok(it.source.assetId === SRC_NEAR && it.source.blockchain === "near" &&
       it.source.symbol === "wNEAR" && it.source.decimals === 24,
      "source metadata curated to 4 fields");
    ok(JSON.stringify(Object.keys(it.source).sort()) === '["assetId","blockchain","decimals","symbol"]',
      "source carries exactly assetId/blockchain/symbol/decimals (no price etc.)");
    ok(it.destination.assetId === DEST_ASSET && it.destination.decimals === 6,
      "destination metadata curated");
    ok(it.expectedOutputAmount === "2500000" && BigInt(it.expectedInputAmount) > 0n &&
       BigInt(it.minInputAmount) <= BigInt(it.expectedInputAmount),
      "EXACT_OUTPUT amounts: out === invoice, in > 0, minIn <= in (BigInt)");
    ok(it.quoteDeadline === new Date(FIXED + 3_600_000).toISOString(),
      "quote deadline = now + default 1 h window");
    ok(it.tidepoolStatus === null, "tidepoolStatus stays null until a real /v0/status read");
    ok(r.out.onChainStatus === "OPEN", "onChainStatus mirrors the contract");
    ok(r.res.headers.get("x-request-id") && r.res.headers.get("cache-control") === "no-store",
      "201 carries rid + Cache-Control: no-store");

    /* what we SENT upstream: contract-derived facts only */
    const sent = JSON.parse(state.calls.quote[0].init.body);
    ok(sent.recipient === MERCHANT && sent.recipientType === "DESTINATION_CHAIN",
      "quote recipient is the contract's creator");
    ok(sent.amount === "2500000" && sent.swapType === "EXACT_OUTPUT" && sent.dry === false,
      "quote is live EXACT_OUTPUT with the invoice amount");
    ok(sent.destinationAsset === DEST_ASSET && sent.originAsset === SRC_NEAR,
      "destination is the approved USDC, origin is the chosen asset");
    ok(sent.deadline === new Date(FIXED + 3_600_000).toISOString(), "requested deadline matches the window");
    ok(!("depositMode" in sent), "depositMode omitted unless the data-driven retry adds it");
    const hdrs = state.calls.quote[0].init.headers;
    ok(hdrs["x-api-key"] === "paylink-testnet", "quote carries the fee-tier X-API-Key header");

    /* the record (Part 5 checklist) */
    const rec = getRecord(env);
    ok(rec && rec.linkId === LINK_ID && rec.merchant === MERCHANT && rec.onChainStatus === "OPEN",
      "record: linkId/merchant/onChainStatus");
    ok(rec.activeIntentId === it.intentId && rec.intents.length === 1,
      "record: one intent, activeIntentId points at it");
    const stored = rec.intents[0];
    ok(stored.status === "AWAITING_DEPOSIT" && stored.idempotencyKey === "key-1",
      "stored intent: status + idempotencyKey");
    ok(typeof stored.signature === "string" && stored.signature.startsWith("ed25519:") &&
       stored.signatureValid === true,
      "stored intent: signature retained as proof, marked valid");
    ok(typeof stored.correlationId === "string" && /^cid-test-/.test(stored.correlationId),
      "stored intent: Tidepool correlationId");
    ok(stored.quoteDeadlineMs === FIXED + 3_600_000 && typeof stored.quoteTimestamp === "string",
      "stored intent: deadline + quote timestamp");
    ok(stored.depositAddress === it.depositAddress && stored.reconcileUntil === null &&
       stored.tidepoolStatus === null,
      "stored intent: address persisted, no cooldown, no status yet");
    ok(JSON.stringify(stored.sentQuoteRequest) === state.calls.quote[0].init.body,
      "stored intent: the exact signed quoteRequest is retained");
    ok(JSON.stringify(Object.keys(stored.source).sort()) === '["assetId","blockchain","decimals","symbol"]',
      "stored source is curated (no upstream extras)");
    ok(rec.history.length === 3 &&
       rec.history[0].from === null && rec.history[0].to === "CREATING" &&
       rec.history[0].reason === "creation_started" &&
       rec.history[1].from === "CREATING" && rec.history[1].to === "QUOTE_ISSUED" &&
       rec.history[2].from === "QUOTE_ISSUED" && rec.history[2].to === "AWAITING_DEPOSIT",
      "history: null->CREATING->QUOTE_ISSUED->AWAITING_DEPOSIT with reasons");
    const [qok] = logs.filter((e) =>
      e.event === "quote_ok" && e.reused === false && e.intentId === it.intentId);
    ok(qok && qok.rid && qok.linkId === LINK_ID && qok.intentId === it.intentId &&
       qok.state === "AWAITING_DEPOSIT" && typeof qok.ms === "number",
      "quote_ok logged with rid/linkId/intentId/state/ms");
    ok(qok && !ADDR_RE.test(JSON.stringify(qok)), "…but no deposit address in the log");
  }

  /* ── 7. idempotent reuse, duplicates, concurrency ── */
  {
    /* a. same idempotency key again */
    let state = stubNet();
    let env = makeEnv();
    const first = await postQuote(env);
    const second = await postQuote(env);
    ok(second.res.status === 200 && second.out.reused === true, "second request -> 200 reused:true");
    ok(second.out.intent.intentId === first.out.intent.intentId &&
       second.out.intent.depositAddress === first.out.intent.depositAddress,
      "…with the SAME intent and deposit address");
    ok(state.calls.quote.length === 1, "…and only ONE upstream quote call");
    ok(state.calls.status.length === 0, "reuse inside the deadline does no status polling at all");

    /* b. different idempotency key AND different asset: still one address */
    state = stubNet();
    env = makeEnv();
    await postQuote(env);
    const other = await postQuote(env, defaultBody({ assetId: SRC_USDT, idempotencyKey: "key-2" }));
    ok(other.res.status === 200 && other.out.intent.source.assetId === SRC_NEAR,
      "a different key/asset still resolves to the ONE active intent (recorded source wins)");
    ok(state.calls.quote.length === 1, "…without a second quote call");

    /* c. true concurrency, input gates on (queued harness) */
    state = stubNet();
    env = makeEnv();
    const [a, b] = await Promise.all([postQuote(env), postQuote(env)]);
    const statuses = [a.res.status, b.res.status].sort().join(",");
    ok(statuses === "200,201", `concurrent requests serialize to one 201 + one 200 (got ${statuses})`);
    ok(state.calls.quote.length === 1 && getRecord(env).intents.length === 1,
      "…one upstream quote and one intent total");
    ok(a.out.intent.depositAddress === b.out.intent.depositAddress,
      "…both answers expose the same deposit address");

    /* d. true interleaving WITHOUT input gates: the CREATING checkpoint alone */
    state = stubNet();
    env = makeEnv({}, { serialize: false });
    let entered;
    let release;
    const enteredP = new Promise((res) => { entered = res; });
    const releaseP = new Promise((res) => { release = res; });
    state.quoteMode = async (init) => {
      entered();
      await releaseP;
      return makeSignedQuote(state, init);
    };
    const pA = postQuote(env);
    await enteredP; // A is parked on its upstream call, CREATING already persisted
    const rB = await postQuote(env);
    ok(rB.res.status === 503 && rB.out.code === "reconcile_cooldown" && rB.out.retryAfterSec >= 1,
      "interleaved request during creation -> 503 reconcile_cooldown + Retry-After");
    ok(state.calls.quote.length === 1, "…with NO second quote call while the first is in flight");
    release();
    const rA = await pA;
    ok(rA.res.status === 201, "the in-flight creation still completes -> 201");
    const recD = getRecord(env);
    ok(recD.intents.length === 1 && recD.intents[0].status === "AWAITING_DEPOSIT" &&
       recD.intents[0].depositAddress !== null,
      "exactly one intent, one persisted address — the CREATING checkpoint held");
  }

  /* ── 8. bad signature: wrong key + post-sign tamper ── */
  {
    let state = stubNet({ quoteMode: "badsig" });
    let env = makeEnv();
    let r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "quote_signature_invalid",
      "quote signed by the wrong key -> 502 quote_signature_invalid");
    ok(!r.text.includes("ed25519:"), "…and the invalid signature value is not echoed back");
    let rec = getRecord(env);
    ok(rec.intents[0].status === "FAILED" && rec.intents[0].lastReason === "quote_signature",
      "intent closed as FAILED (its address never reached a client)");

    state.quoteMode = "ok"; // the rejection was definitive: immediate retry allowed
    r = await postQuote(env, defaultBody({ idempotencyKey: "key-2" }));
    ok(r.res.status === 201 && r.out.reused === false, "immediate retry after signature failure -> new 201");
    rec = getRecord(env);
    ok(rec.intents.length === 2 && rec.intents[1].status === "AWAITING_DEPOSIT",
      "…as a SECOND intent (FAILED is terminal, a new one may start)");
    ok(state.calls.quote.length === 2, "…with a second upstream quote");

    state = stubNet({ quoteMode: "tampered" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "quote_signature_invalid",
      "amounts tampered AFTER signing -> 502 quote_signature_invalid");
    ok(getRecord(env).intents[0].status === "FAILED", "…intent FAILED, no address exposed");
    ok(!ADDR_RE.test(r.text), "…the tampered quote's address never reaches the client");
  }

  /* ── 9. REAL Tidepool fixtures under the DEFAULT maker key ── */
  {
    const defaultKey = makerKey({});
    ok(defaultKey === "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY",
      "default maker key is Tidepool's published key");

    ok(await verifyQuoteSignature(DRY_FIXTURE, defaultKey),
      "REAL dry quote verifies under the default maker key (independent stableStringify+b58+Ed25519)");
    const flipped = { ...DRY_FIXTURE, signature: DRY_FIXTURE.signature.slice(0, -1) + "3" };
    ok(!(await verifyQuoteSignature(flipped, defaultKey)), "…a flipped signature byte does not");
    ok(!(await verifyQuoteSignature(DRY_FIXTURE, TEST_MAKER)), "…and neither does the wrong public key");

    const live = await validateQuoteResponse(LIVE_FIXTURE, LIVE_FIXTURE.quoteRequest, {
      makerKey: defaultKey, invoiceAmount: "2500000", now: LIVE_NOW,
    });
    ok(live.ok === true, "REAL live quote passes full validation (schema+echo+amounts+deadline+deposit+sig)");
    ok(live.ok && live.data.depositAddress === LIVE_FIXTURE.quote.depositAddress,
      "…with the real deposit address extracted");
    ok(live.ok && live.data.amountOut === "2500000" && live.data.amountIn === "702488059452237833470205",
      "…EXACT_OUTPUT amounts survive BigInt string checks (24-decimal amountIn intact)");

    const amtTamper = { ...LIVE_FIXTURE, quote: { ...LIVE_FIXTURE.quote, amountOut: "2500001" } };
    const vAmt = await validateQuoteResponse(amtTamper, amtTamper.quoteRequest, {
      makerKey: defaultKey, invoiceAmount: "2500000", now: LIVE_NOW,
    });
    ok(vAmt.ok === false && vAmt.reason === "amount_mismatch",
      "tampered amountOut -> amount_mismatch (hard EXACT_OUTPUT check)");

    const sigTamper = { ...LIVE_FIXTURE, signature: LIVE_FIXTURE.signature.slice(0, -1) + "3" };
    const vSig = await validateQuoteResponse(sigTamper, sigTamper.quoteRequest, {
      makerKey: defaultKey, invoiceAmount: "2500000", now: LIVE_NOW,
    });
    ok(vSig.ok === false && vSig.reason === "signature", "tampered signature -> signature failure");

    /* echo-replay: a valid Tidepool signature over a DIFFERENT request
       must still be refused — a signature alone only proves Tidepool
       signed SOMETHING. */
    const replay = { ...LIVE_FIXTURE, quoteRequest: { ...LIVE_FIXTURE.quoteRequest, amount: "9999999" } };
    const vReplay = await validateQuoteResponse(replay, LIVE_FIXTURE.quoteRequest, {
      makerKey: defaultKey, invoiceAmount: "2500000", now: LIVE_NOW,
    });
    ok(vReplay.ok === false && vReplay.reason === "echo_mismatch",
      "replayed quoteRequest -> echo_mismatch fires BEFORE the signature check");

    const vExpired = await validateQuoteResponse(LIVE_FIXTURE, LIVE_FIXTURE.quoteRequest, {
      makerKey: defaultKey, invoiceAmount: "2500000", now: LIVE_NOW + 12 * 3600 * 1000,
    });
    ok(vExpired.ok === false && vExpired.reason === "deadline", "a past deadline is refused");
  }

  /* ── 10. state machine: unit matrix + Durable Object level ── */
  {
    ok(SPEC_STATES.length === 10 && INTERNAL_STATES.length === 12,
      "10 spec states + 2 implementation states (CREATING, SETTLED)");
    ok(SPEC_STATES.every((s) => INTERNAL_STATES.includes(s)) &&
       !SPEC_STATES.includes("CREATING") && !SPEC_STATES.includes("SETTLED"),
      "implementation states are additive, not renames");

    const NO_EXITS = ["VERIFIED", "REFUNDED", "FAILED", "EXPIRED"];
    let invariant = true;
    for (const from of INTERNAL_STATES) {
      if (canTransition(from, from)) invariant = false;                 // duplicates = no-op
      if (NO_EXITS.includes(from)) {
        for (const to of INTERNAL_STATES) if (canTransition(from, to)) invariant = false;
      }
      for (const to of INTERNAL_STATES) if (to === "CREATING" && canTransition(from, to)) invariant = false;
    }
    ok(invariant, "invariants: no self-loops, terminal states have no exits, CREATING has no inbound");

    const allowed = [
      ["CREATING", "QUOTE_ISSUED"], ["QUOTE_ISSUED", "AWAITING_DEPOSIT"],
      ["AWAITING_DEPOSIT", "DEPOSIT_SEEN"], ["DEPOSIT_SEEN", "SETTLING"],
      ["SETTLING", "SETTLED"], ["SETTLED", "VERIFIED"], ["RECONCILE", "AWAITING_DEPOSIT"],
      ["UNKNOWN", "EXPIRED"], ["AWAITING_DEPOSIT", "EXPIRED"],
    ];
    const refused = [
      ["DEPOSIT_SEEN", "EXPIRED"], ["QUOTE_ISSUED", "VERIFIED"], ["AWAITING_DEPOSIT", "VERIFIED"],
      ["REFUNDED", "AWAITING_DEPOSIT"], ["EXPIRED", "FAILED"], ["VERIFIED", "SETTLED"],
      ["FAILED", "REFUNDED"], ["CREATING", "AWAITING_DEPOSIT"], ["SETTLING", "AWAITING_DEPOSIT"],
      ["AWAITING_DEPOSIT", "CREATING"],
    ];
    ok(allowed.every(([f, t]) => canTransition(f, t)), "permitted transitions all allowed");
    ok(refused.every(([f, t]) => !canTransition(f, t)), "forbidden transitions all refused");
    ok(isTerminal("VERIFIED") && isTerminal("EXPIRED") && isTerminal("REFUNDED") && isTerminal("FAILED") &&
       !isTerminal("AWAITING_DEPOSIT") && !isTerminal("SETTLED") && !isTerminal("CREATING"),
      "isTerminal correct at both edges");

    const frozenIntent = { status: "VERIFIED", updatedAt: 5, lastReason: null };
    ok(applyTransition(frozenIntent, "SETTLED", "regression", 9) === null &&
       frozenIntent.status === "VERIFIED" && frozenIntent.updatedAt === 5 && frozenIntent.lastReason === null,
      "applyTransition refusal leaves the intent completely untouched");
    const moving = { status: "AWAITING_DEPOSIT", updatedAt: 5, lastReason: null };
    const t = applyTransition(moving, "DEPOSIT_SEEN", "tidepool_KNOWN_DEPOSIT_TX", 9);
    ok(t && t.from === "AWAITING_DEPOSIT" && t.to === "DEPOSIT_SEEN" && moving.updatedAt === 9 &&
       moving.lastReason === "tidepool_KNOWN_DEPOSIT_TX",
      "applyTransition accepts, stamps updatedAt and reason");
    ok(applyTransition({ status: "DEPOSIT_SEEN" }, "DEPOSIT_SEEN", "dup", 9) === null,
      "duplicate update (from===to) is refused, not an error");

    const expectedMap = {
      PENDING_DEPOSIT: null, KNOWN_DEPOSIT_TX: "DEPOSIT_SEEN", INCOMPLETE_DEPOSIT: "DEPOSIT_SEEN",
      PROCESSING: "SETTLING", SUCCESS: "SETTLED", REFUNDED: "REFUNDED", FAILED: "FAILED",
    };
    let mapOk = true;
    for (const [status, target] of Object.entries(expectedMap)) {
      const m = mapTidepoolStatus(status);
      if (!m.ok || m.target !== target) mapOk = false;
    }
    ok(mapOk, "all 7 documented Tidepool statuses map exactly as specified");
    ok(!mapTidepoolStatus("SOMETHING_ELSE").ok && !mapTidepoolStatus(42).ok && !mapTidepoolStatus(null).ok,
      "unknown/non-string statuses -> {ok:false} (never guessed)");

    /* DO level: a VERIFIED payment can never be overwritten */
    const stateS = stubNet();
    const envS = makeEnv();
    envS.INTENT_DO.seed(LINK_ID, {
      linkId: LINK_ID, merchant: MERCHANT, onChainStatus: "OPEN",
      activeIntentId: "pi_seed", intents: [{ intentId: "pi_seed", linkId: LINK_ID, status: "VERIFIED" }],
      history: [], createdAt: FIXED, updatedAt: FIXED,
    });
    const rV = await postQuote(envS);
    ok(rV.res.status === 409 && rV.out.code === "payment_verified",
      "seeded VERIFIED intent -> 409 payment_verified");
    ok(getRecord(envS).intents[0].status === "VERIFIED" && getRecord(envS).activeIntentId === "pi_seed",
      "…the VERIFIED record is untouched");
    ok(stateS.calls.quote.length === 0, "…and no quote was requested");

    /* history cap: an invoice at the intent limit cannot mint another */
    stubNet();
    const envF = makeEnv();
    const seededIntents = Array.from({ length: 20 }, (_, i) => ({
      intentId: `pi_f${i}`, linkId: LINK_ID, status: "FAILED",
    }));
    envF.INTENT_DO.seed(LINK_ID, {
      linkId: LINK_ID, merchant: MERCHANT, onChainStatus: "OPEN",
      activeIntentId: "pi_f19", intents: seededIntents, history: [],
      createdAt: FIXED, updatedAt: FIXED,
    });
    const rF = await postQuote(envF);
    ok(rF.res.status === 409 && rF.out.code === "intent_history_full",
      "20 intents on one invoice -> 409 intent_history_full");
  }

  /* ── 11. reconcile against /v0/status (deadline-driven, no polling) ── */
  {
    /* a. KNOWN_DEPOSIT_TX: deposit stays attached to THIS intent */
    let state = stubNet();
    let env = makeEnv();
    const created = await postQuote(env);
    const firstAddr = created.out.intent.depositAddress;
    advance(3_600_001); // past the quote deadline
    state.statusBody = { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T13:00:00.000Z" };
    let r = await postQuote(env);
    ok(r.res.status === 200 && r.out.reused === true && r.out.intent.status === "DEPOSIT_SEEN",
      "deadline passed, Tidepool saw a deposit -> 200 reused, internal DEPOSIT_SEEN");
    ok(r.out.intent.depositAddress === firstAddr && state.calls.quote.length === 1,
      "…same address, no second quote");
    ok(state.calls.status.length === 1 &&
       state.calls.status[0].url.includes("depositAddress="),
      "…one /v0/status read keyed by the deposit address");

    /* duplicate status read is a no-op reuse, not an error */
    r = await postQuote(env);
    ok(r.res.status === 200 && r.out.intent.status === "DEPOSIT_SEEN" &&
       state.calls.status.length === 2 && state.calls.quote.length === 1,
      "a repeated KNOWN_DEPOSIT_TX stays a 200 reuse (from===to no-op)");

    /* b. SUCCESS -> SETTLED, never VERIFIED, blocks new intents */
    state = stubNet();
    env = makeEnv();
    await postQuote(env);
    advance(3_600_001);
    state.statusBody = { status: "SUCCESS", updatedAt: "2026-11-11T13:00:00.000Z" };
    r = await postQuote(env);
    ok(r.res.status === 409 && r.out.code === "payment_settled",
      "Tidepool SUCCESS -> 409 payment_settled (external success is not payment)");
    let rec = getRecord(env);
    ok(rec.intents[0].status === "SETTLED",
      "…internal state SETTLED (and never VERIFIED — see the matrix above)");
    const statusCalls = state.calls.status.length;
    const rAgain = await postQuote(env);
    ok(rAgain.res.status === 409 && rAgain.out.code === "payment_settled" &&
       state.calls.status.length === statusCalls && state.calls.quote.length === 1,
      "SETTLED blocks further intents without another status read");

    /* c. PENDING_DEPOSIT past our deadline -> EXPIRED -> fresh 201 */
    state = stubNet();
    env = makeEnv();
    const firstAddrC = (await postQuote(env)).out.intent.depositAddress;
    advance(3_600_001);
    state.statusBody = { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T13:00:00.000Z" };
    r = await postQuote(env);
    ok(r.res.status === 201 && r.out.reused === false,
      "no deposit past deadline -> intent EXPIRED, fresh quote in the SAME request");
    rec = getRecord(env);
    ok(rec.intents.length === 2 && rec.intents[0].status === "EXPIRED" &&
       rec.intents[0].lastReason === "no_deposit_past_deadline" &&
       rec.intents[1].status === "AWAITING_DEPOSIT",
      "…old intent EXPIRED, new intent active");
    ok(rec.intents[1].depositAddress && rec.intents[1].depositAddress !== firstAddrC &&
       state.calls.quote.length === 2,
      "…with a genuinely new address from a second upstream quote");

    /* d. REFUNDED -> terminal -> new intent allowed */
    state = stubNet();
    env = makeEnv();
    await postQuote(env);
    advance(3_600_001);
    state.statusBody = { status: "REFUNDED", updatedAt: "2026-11-11T13:00:00.000Z" };
    r = await postQuote(env);
    ok(r.res.status === 201 && r.out.reused === false, "REFUNDED -> money went back -> new intent allowed");
    rec = getRecord(env);
    ok(rec.intents[0].status === "REFUNDED" && rec.intents[1].status === "AWAITING_DEPOSIT" &&
       rec.activeIntentId === rec.intents[1].intentId,
      "…old intent terminal, new intent active");

    /* e. status unreadable / not found / hung -> RECONCILE + cooldown + throttle */
    for (const [mode, label] of [["http500", "5xx"], ["not_found", "404"], ["hang", "timeout"]]) {
      state = stubNet();
      env = makeEnv(mode === "hang" ? { TIDEPOOL_TIMEOUT_MS: "50" } : {});
      await postQuote(env);
      advance(3_600_001);
      state.statusMode = mode;
      r = await postQuote(env);
      ok(r.res.status === 503 && r.out.code === "reconcile_cooldown" && r.out.retryAfterSec >= 1 &&
         r.res.headers.get("retry-after") !== null,
        `status ${label} -> 503 reconcile_cooldown + Retry-After persisted`);
      rec = getRecord(env);
      ok(rec.intents[0].status === "RECONCILE", `…internal state RECONCILE after status ${label}`);
      const before = state.calls.status.length;
      const r2 = await postQuote(env);
      ok(r2.res.status === 503 && state.calls.status.length === before && state.calls.quote.length === 1,
        `…cooldown throttles: the retry does no status read and no quote (${label})`);
    }

    /* f. unknown status -> UNKNOWN + 503, never invented */
    state = stubNet();
    env = makeEnv();
    await postQuote(env);
    advance(3_600_001);
    state.statusMode = "unknown";
    r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "status_unknown",
      "unrecognized Tidepool status -> 503 status_unknown");
    rec = getRecord(env);
    ok(rec.intents[0].status === "UNKNOWN" && rec.intents[0].tidepoolStatus === "SOMETHING_ELSE",
      "…internal UNKNOWN, raw external status recorded verbatim");
    const beforeUnknown = state.calls.status.length;
    const r2 = await postQuote(env);
    ok(r2.res.status === 503 && state.calls.status.length === beforeUnknown,
      "…and the cooldown throttles the retry");

    /* g. PROCESSING -> SETTLING reuse */
    state = stubNet();
    env = makeEnv();
    await postQuote(env);
    advance(3_600_001);
    state.statusBody = { status: "PROCESSING", updatedAt: "2026-11-11T13:00:00.000Z" };
    r = await postQuote(env);
    ok(r.res.status === 200 && r.out.intent.status === "SETTLING" && state.calls.quote.length === 1,
      "PROCESSING -> SETTLING, still THIS intent's instructions");
  }

  /* ── 12. ambiguous creation, 4xx-vs-5xx classification, malformed bodies ── */
  {
    /* a. hung quote -> ambiguous -> cooldown -> supersede after cooldown */
    let state = stubNet({ quoteMode: "hang" });
    let env = makeEnv({ TIDEPOOL_TIMEOUT_MS: "50" });
    let r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown" && r.out.retryAfterSec >= 1 &&
       r.res.headers.get("retry-after") !== null,
      "hung quote creation -> 503 reconcile_cooldown + Retry-After");
    let rec = getRecord(env);
    ok(rec.intents[0].status === "RECONCILE" && rec.intents[0].depositAddress === null &&
       rec.intents[0].reconcileUntil === clock + 60_000,
      "…RECONCILE persisted WITH its cooldown clock, address never stored");
    let r2 = await postQuote(env);
    ok(r2.res.status === 503 && state.calls.quote.length === 1,
      "immediate retry inside the cooldown -> 503, no second quote");
    advance(60_001);
    state.quoteMode = "ok";
    r = await postQuote(env);
    ok(r.res.status === 201 && r.out.reused === false,
      "after the cooldown: old intent abandoned, fresh quote -> 201 (supersede)");
    rec = getRecord(env);
    ok(rec.intents.length === 2 && rec.intents[0].status === "FAILED" &&
       rec.intents[0].lastReason === "creation_abandoned",
      "…old intent FAILED creation_abandoned, new intent active");

    /* b. 4xx is DEFINITIVE: FAILED immediately, retry allowed at once */
    state = stubNet({ quoteMode: "http400" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "quote_upstream_rejected",
      "quote 4xx -> 502 quote_upstream_rejected (definitive rejection)");
    rec = getRecord(env);
    ok(rec.intents[0].status === "FAILED" && rec.intents[0].lastReason === "upstream_rejected" &&
       rec.intents[0].reconcileUntil === null,
      "…intent FAILED with NO cooldown (4xx means no quote was created)");
    ok(!r.text.includes("slippageTolerance out of range"), "…upstream message not echoed");
    state.quoteMode = "ok";
    r = await postQuote(env);
    ok(r.res.status === 201 && getRecord(env).intents.length === 2,
      "immediate retry after 4xx -> new intent, no cooldown gate");

    /* c. 5xx is AMBIGUOUS: cooldown, no blind retry */
    state = stubNet({ quoteMode: "http500" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown",
      "quote 5xx -> 503 reconcile_cooldown (outcome uncertain)");
    ok(!r.text.includes("QUOTE-UPSTREAM-DETAIL-MARKER"), "…upstream 5xx detail not echoed");
    ok(getRecord(env).intents[0].status === "RECONCILE", "…intent in RECONCILE");

    /* d. unreadable 200 (garbage body) is AMBIGUOUS… */
    state = stubNet({ quoteMode: "garbage200" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown",
      "unreadable 200 body -> ambiguous -> 503 reconcile_cooldown");
    ok(getRecord(env).intents[0].status === "RECONCILE" && getRecord(env).intents[0].depositAddress === null,
      "…RECONCILE without an address (nobody could have funded it)");

    /* …while a schema-invalid 200 is a refusal: 502 + FAILED + retry */
    state = stubNet({ quoteMode: "schema" });
    env = makeEnv();
    r = await postQuote(env);
    ok(r.res.status === 502 && r.out.code === "quote_malformed",
      "schema-invalid 200 -> 502 quote_malformed (definitive refusal)");
    ok(getRecord(env).intents[0].status === "FAILED" && getRecord(env).intents[0].reconcileUntil === null,
      "…intent FAILED, no cooldown");
    state.quoteMode = "ok";
    r = await postQuote(env);
    ok(r.res.status === 201, "…immediate retry allowed");
  }

  /* ── 13. persistence failures ── */
  {
    /* a. the CREATING checkpoint itself fails to persist: no upstream call */
    let state = stubNet();
    let env = makeEnv({}, { failPutAt: 1 });
    let r = await postQuote(env);
    ok(r.res.status === 500 && r.out.code === "persistence_failed",
      "record write fails BEFORE the upstream call -> 500 persistence_failed");
    ok(state.calls.quote.length === 0 && state.calls.rpc.length === 1,
      "…no quote was ever requested (no orphan upstream spend)");
    ok(getRecord(env) === undefined, "…and no partial record exists");

    /* b. record read fails */
    state = stubNet();
    env = makeEnv({}, { getFail: true });
    r = await postQuote(env);
    ok(r.res.status === 500 && r.out.code === "persistence_failed" && state.calls.quote.length === 0,
      "record read fails -> 500, upstream untouched");

    /* c. write AFTER the verified quote fails: CREATING retained */
    state = stubNet();
    env = makeEnv({}, { failPutAt: 2 });
    r = await postQuote(env);
    ok(r.res.status === 500 && r.out.code === "persistence_failed",
      "record write fails AFTER the quote -> 500 persistence_failed");
    const recC = getRecord(env);
    ok(recC && recC.intents.length === 1 && recC.intents[0].status === "CREATING" &&
       recC.intents[0].depositAddress === null,
      "…CREATING checkpoint retained (address assignment did not leak into storage)");
    ok(state.calls.quote.length === 1, "…exactly one upstream quote so far");

    r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown" && state.calls.quote.length === 1,
      "retry inside the cooldown -> 503, no second quote");
    advance(60_001);
    r = await postQuote(env);
    ok(r.res.status === 201 && r.out.reused === false, "after the cooldown -> superseding 201");
    const recD2 = getRecord(env);
    ok(recD2.intents.length === 2 && recD2.intents[0].status === "FAILED" &&
       recD2.intents[0].lastReason === "creation_interrupted",
      "…old CREATING intent FAILED creation_interrupted, new intent active");
    ok(state.calls.quote.length === 2, "…with exactly one more upstream quote");
  }

  /* ── 14. data-driven depositMode retry + fee-tier header ── */
  {
    const state = stubNet({ quoteMode: "memo400" });
    const env = makeEnv();
    const r = await postQuote(env);
    ok(r.res.status === 201, "400 naming depositMode -> single retry succeeds -> 201");
    ok(state.calls.quote.length === 2, "…exactly two quote attempts (a 400 created nothing)");
    const first = JSON.parse(state.calls.quote[0].init.body);
    const second = JSON.parse(state.calls.quote[1].init.body);
    ok(!("depositMode" in first) && second.depositMode === "MEMO",
      "retry re-sends with depositMode:\"MEMO\" and nothing else invented");
    ok(typeof r.out.intent.depositMemo === "string" && r.out.intent.depositMemo.length > 0,
      "…and the memo-required quote exposes depositMemo to the payer");
    ok(state.calls.quote[0].init.headers["x-api-key"] === "paylink-testnet" &&
       state.calls.quote[1].init.headers["x-api-key"] === "paylink-testnet",
      "both attempts carry the X-API-Key fee-tier header");
    ok(logs.some((e) => e.event === "quote_deposit_mode_retry"), "the retry is logged as its own event");

    const stateTier = stubNet();
    const envTier = makeEnv({ TIDEPOOL_X_API_KEY: "tier-max" });
    await postQuote(envTier);
    ok(stateTier.calls.quote[0].init.headers["x-api-key"] === "tier-max",
      "TIDEPOOL_X_API_KEY env overrides the tier header");
  }

  /* ── 15. env tunables: bounds, units, defaults + buildQuoteRequest ── */
  {
    ok(quoteWindowMs({}) === 3_600_000, "quote window default 3600000 ms");
    ok(quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "60000" }) === 60_000 &&
       quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "86400000" }) === 86_400_000,
      "quote window honors in-range ms values (60 s .. 24 h, matching Tidepool's deadline bounds)");
    ok(quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "59999" }) === 3_600_000 &&
       quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "86400001" }) === 3_600_000 &&
       quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "0" }) === 3_600_000 &&
       quoteWindowMs({ TIDEPOOL_QUOTE_WINDOW_MS: "abc" }) === 3_600_000,
      "out-of-range/non-numeric window falls back to the default");
    ok(ambiguousCooldownMs({}) === 60_000, "cooldown default 60000 ms");
    ok(ambiguousCooldownMs({ TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "0" }) === 0 &&
       ambiguousCooldownMs({ TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "5000" }) === 5_000,
      "cooldown accepts 0..3600000");
    ok(ambiguousCooldownMs({ TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "-1" }) === 60_000 &&
       ambiguousCooldownMs({ TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "3600001" }) === 60_000,
      "cooldown outside range falls back to the default");
    ok(makerKey({ TIDEPOOL_MAKER_KEY: "  ed25519:custom  " }) === "ed25519:custom" &&
       makerKey({ TIDEPOOL_MAKER_KEY: "   " }) ===
         "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY",
      "maker key env honored (trimmed), empty falls back to Tidepool's published key");

    const link = openLink();
    const near = { assetId: SRC_NEAR, blockchain: "near", symbol: "wNEAR", decimals: 24 };
    const base = { assetId: SRC_BASE, blockchain: "base", symbol: "USDC", decimals: 6 };
    const dest = { assetId: DEST_ASSET, blockchain: "near", symbol: "USDC", decimals: 6 };
    const req = buildQuoteRequest({ link, source: near, destination: dest, refundTo: "payer.testnet", now: FIXED, windowMs: 3_600_000 });
    ok(req.swapType === "EXACT_OUTPUT" && req.dry === false && req.slippageTolerance === 100 &&
       req.amount === "2500000" && req.recipient === MERCHANT && req.destinationAsset === DEST_ASSET,
      "buildQuoteRequest: contract-derived EXACT_OUTPUT request");
    ok(req.depositType === "INTENTS" && req.refundType === "INTENTS",
      "NEAR source -> INTENTS deposit/refund types");
    ok(!("depositMode" in req), "depositMode omitted by default");
    const reqBase = buildQuoteRequest({ link, source: base, destination: dest, refundTo: "0xabc", now: FIXED, windowMs: 3_600_000 });
    ok(reqBase.depositType === "ORIGIN_CHAIN" && reqBase.refundType === "ORIGIN_CHAIN",
      "non-NEAR source -> ORIGIN_CHAIN types (data-driven from the fresh token, no chain list)");
    const expiring = openLink({ expires_at: FIXED + 600_000 });
    const reqExp = buildQuoteRequest({ link: expiring, source: near, destination: dest, refundTo: "payer.testnet", now: FIXED, windowMs: 3_600_000 });
    ok(reqExp.deadline === new Date(FIXED + 600_000).toISOString(),
      "deadline clamps to the invoice expiry (never beyond it)");
    const reqMemo = buildQuoteRequest({ link, source: near, destination: dest, refundTo: "payer.testnet", now: FIXED, windowMs: 3_600_000, depositMode: "MEMO" });
    ok(reqMemo.depositMode === "MEMO", "depositMode only appears when explicitly passed");
  }

  /* ── 16. sweeps: leak + M-01 envelope ── */
  {
    const all = bodies.join("\n");
    ok(!all.includes("ed25519:"), "sweep: no signature value appears in ANY response body");
    ok(!all.includes("UPSTREAM-DETAIL-MARKER") && !all.includes("RPC-DETAIL-MARKER") &&
       !all.includes("QUOTE-UPSTREAM-DETAIL-MARKER") && !all.includes("STATUS-DETAIL-MARKER"),
      "sweep: no upstream detail appears in any response");
    ok(!all.includes('"price"') && !all.includes("coingeckoId"), "sweep: no upstream token fields leak");
    ok(!all.includes("at Object.") && !all.includes("node:internal") && !all.includes("index.js:"),
      "sweep: no stack-trace fragment appears in any response");
    const errTexts = entries.filter((e) => e.status >= 400).map((e) => e.text).join("\n");
    ok(!ADDR_RE.test(errTexts), "sweep: no error body ever carries a deposit address");
    ok(!errTexts.includes("cid-test-") && !errTexts.includes("correlationId"),
      "sweep: no error body carries upstream correlation ids");

    ok(logs.length > 0 && logs.every((e) => e.ts && e.svc && e.build && e.level && e.event),
      `M-01: every log line carries the envelope (${logs.length} lines)`);
    ok(logs.some((e) => e.event === "quote_ok") && logs.some((e) => e.event === "quote_rejected") &&
       logs.some((e) => e.event === "intent_transition") &&
       logs.some((e) => e.event === "quote_upstream_error"),
      "M-01: quote_ok / quote_rejected / intent_transition / quote_upstream_error all observed");
    const logAll = JSON.stringify(logs);
    ok(!logAll.includes("ed25519:"), "sweep: no signature value appears in any log line");
    ok(!ADDR_RE.test(logAll), "sweep: no deposit address appears in any log line");
    ok(bodies.length >= 60, `sweep ran over a meaningful sample (${bodies.length} responses)`);
  }
} catch (e) {
  fail++;
  baseLog("FAIL  unexpected error:", e && e.message);
  baseLog(e && e.stack);
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  console.log = baseLog;
  clearDiscoveryCache();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
