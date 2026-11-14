/* Phase 4 tests: GET /status — deposit tracking, conservative polling,
 * state-machine protections and the cross-provider race detector for the
 * Tidepool Worker.
 *
 * Covers the Part 8 list end to end: routing/admission and capability
 * checks (the intentId is the read capability; browser-supplied upstream
 * facts are ignored), the exact response allowlist, all seven documented
 * Tidepool statuses, unknown statuses, invalid upstream responses
 * (garbage/bad shape/5xx/timeout/404 unknown address), rate limits with
 * Retry-After, temporary-failure backoff and recovery, duplicate and
 * concurrent polling (zero overlapping upstream reads), terminal-state
 * protection (zero reads), expired deposits against the real quote
 * deadline with and without an observed deposit, partial deposit ->
 * refund, refunded vs failed distinctness, the NEAR invoice going PAID
 * during an active Tidepool payment (conflict detected once, surfaced
 * every response, polling continues), contract-read failures that never
 * fail the status response, env bounds, the 24 h watch limit, and three
 * repo-standard sweeps: no deposit address / signature / correlation id
 * / swapDetails / raw upstream ever leaves this endpoint or its logs,
 * every log line carries the M-01 envelope, and status_ok fires only on
 * change while cooldown 503s stay silent.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts
 * Tidepool or a NEAR node. Quote responses are signed by the test file
 * itself under a per-run Ed25519 key injected via TIDEPOOL_MAKER_KEY —
 * mocks only. INTENT_DO is the same harness as quote.test.mjs: the real
 * PaymentIntent class against structuredClone-backed memory storage with
 * a per-invoice promise queue emulating Durable Object input gates (one
 * test runs WITHOUT the queue to prove the persisted poll stamp holds
 * under true interleaving). Date.now is pinned so deadline, throttle and
 * cooldown arithmetic is deterministic.
 */

import worker, {
  PaymentIntent,
  clearDiscoveryCache,
  statusMinIntervalMs,
  depositObserved,
  mapTidepoolStatus,
  canTransition,
  isTerminal,
  stableStringify,
  b58encode,
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
   keep them (for the sweeps at the end); anything else passes through. */
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
const OTHER_LINK_ID = "lnk-other-002";
const MERCHANT = "merchant.testnet";
/* Unique mock deposit addresses: "pa"+counter+filler, so the sweeps can
   find one in any body or log line. */
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

/* The 1Click/Tidepool signed-payload field lists (independent
   implementation meeting the worker's verify on a known byte string). */
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

/* ── request helpers ─────────────────────────────────────────────────── */

const bodies = [];      // every response body (sweeps)
const entries = [];     // {status, text}
const statusTexts = []; // only /status responses (endpoint-scoped sweeps)

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
  if (path.startsWith("/status")) statusTexts.push(text);
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

/* GET /status?id=<intentId>&linkId=<linkId>[extra] */
const getStatus = (env, intentId, linkId = LINK_ID, extra = "", headers = {}) =>
  send("GET", `/status?id=${encodeURIComponent(intentId)}&linkId=${encodeURIComponent(linkId)}${extra}`,
    undefined, env, headers);

async function createIntent(env, over = {}) {
  const r = await postQuote(env, defaultBody(over));
  if (r.res.status !== 201) throw new Error(`POST /quote failed: ${r.res.status} ${r.text}`);
  return r.out.intent;
}

/* ── Durable Object harness (same as quote.test.mjs) ─────────────────── */

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
    seed(name, record) {
      getInst(name).store.set("record", structuredClone(record));
    },
    /* Real namespace shape: idFromName returns an opaque id; only get(id)
       returns the stub whose fetch reaches the object (verified against
       workerd in the Phase 6 run — a stub-returning idFromName would
       mask the difference the real runtime exposed). */
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
           request can interleave with a first one parked upstream. */
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
  if (sent.depositMode === "MEMO") resp.quote.depositMemo = "memo-12345";
  await signQuoteResponse(resp, state.signKeyPair || testKeys);
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
    statusRetryAfter: opts.statusRetryAfter || "30",
    depositAddress: opts.depositAddress,
    signKeyPair: opts.signKeyPair || testKeys,
    calls: { rpc: [], tokens: [], health: [], quote: [], status: [] },
  };

  const rpcLeg = (init) => {
    if (state.rpcMode === "hang") return hangResponse(init);
    if (state.rpcMode === "http500") return jsonResp(500, { error: { message: "RPC-DETAIL-MARKER " + "x".repeat(300) } });
    if (state.rpcMode === "badshape") return jsonResp(200, { jsonrpc: "2.0", id: "1", result: { logs: [] } });
    return rpcEnvelope(state.link);
  };

  const tokensLeg = (init) => {
    if (state.tokensMode === "hang") return hangResponse(init);
    if (state.tokensMode === "http500") return jsonResp(500, { error: { message: "UPSTREAM-DETAIL-MARKER " + "x".repeat(300) } });
    if (state.tokensMode === "badshape") return jsonResp(200, { tokens: [] });
    return jsonResp(200, state.tokens);
  };

  const quoteLeg = (init) => {
    if (state.quoteMode === "hang") return hangResponse(init);
    return makeSignedQuote(state, init);
  };

  /* The Phase 4 status leg: the seven documented shapes plus the failure
     modes Part 8 demands (rate limit with Retry-After, garbage body,
     bad shape, unknown status, timeout, 404 unknown address). */
  const statusLeg = (init) => {
    const mode = state.statusMode;
    if (typeof mode === "function") return mode(init, state);
    if (mode === "hang") return hangResponse(init);
    if (mode === "http500") return jsonResp(500, { message: "STATUS-DETAIL-MARKER " + "x".repeat(300) });
    if (mode === "http429") {
      return new Response(JSON.stringify({ message: "rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(state.statusRetryAfter) },
      });
    }
    if (mode === "not_found") return jsonResp(404, { message: "Deposit address not found" });
    if (mode === "unknown") return jsonResp(200, { status: "SOMETHING_ELSE", updatedAt: "2026-11-11T12:00:00.000Z" });
    if (mode === "garbage200") {
      return new Response("<<<not json>>>", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (mode === "badshape") return jsonResp(200, { foo: "bar", updatedAt: "2026-11-11T12:00:00.000Z" });
    return jsonResp(200, state.statusBody);
  };

  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(RPC)) { state.calls.rpc.push({ url: u, init }); return rpcLeg(init); }
    if (u.includes("/v0/tokens")) { state.calls.tokens.push({ url: u, init }); return tokensLeg(init); }
    if (u.includes("/v0/health")) { state.calls.health.push({ url: u, init }); return jsonResp(200, { ok: true }); }
    if (u.includes("/v0/quote")) { state.calls.quote.push({ url: u, init }); return quoteLeg(init); }
    if (u.includes("/v0/status")) { state.calls.status.push({ url: u, init }); return statusLeg(init); }
    return Promise.reject(new TypeError("unexpected upstream fetch: " + u));
  };
  return state;
}

/* ── record seeding (state-machine + watch-limit tests) ──────────────── */

const SEED_ID = "pi_0123456789abcdef";
const SEED_SIG = "ed25519:SEEDSIGNATUREONLYNEVERLEAVESTHISRECORD00000000000000000000000000000000";

const seedIntent = (over = {}) => ({
  intentId: SEED_ID,
  linkId: LINK_ID,
  idempotencyKey: null,
  status: "AWAITING_DEPOSIT",
  createdAt: clock,
  updatedAt: clock,
  depositAddress: nextAddress(),
  depositMemo: null,
  source: { assetId: SRC_NEAR, blockchain: "near", symbol: "wNEAR", decimals: 24 },
  destination: { assetId: DEST_ASSET, blockchain: "near", symbol: "USDC", decimals: 6 },
  merchant: MERCHANT,
  invoiceAmount: "2500000",
  expectedInputAmount: "1009704",
  minInputAmount: "999707",
  expectedOutputAmount: "2500000",
  quoteDeadlineMs: clock + 3_600_000,
  quoteTimestamp: new Date(clock).toISOString(),
  signature: SEED_SIG,
  signatureValid: true,
  correlationId: "cid-test-seed-0001",
  tidepoolStatus: "PENDING_DEPOSIT",
  tidepoolStatusUpdatedAt: null,
  lastReason: "awaiting_deposit",
  lastError: null,
  reconcileUntil: null,
  depositObserved: false,
  lastStatusPollAt: null,
  sentQuoteRequest: null,
  ...over,
});

const seedRecord = (intents, over = {}) => ({
  linkId: LINK_ID,
  merchant: MERCHANT,
  onChainStatus: "OPEN",
  onChainCheckedAt: clock,
  conflict: null,
  activeIntentId: intents[0].intentId,
  intents,
  history: [],
  createdAt: clock,
  updatedAt: clock,
  ...over,
});

const eventCount = (name, from = 0) => logs.slice(from).filter((e) => e.event === name).length;
/* Index into the log stream — captures must use this, not a count:
   slice() takes an index, and counts only coincide with indexes when
   every prior line happens to be the same event. */
const logMark = () => logs.length;

/* ═══════════════════════════════════════════════════════════════════════ */

try {
  clock = FIXED;

  /* ── 1. routing & admission ── */
  {
    const state = stubNet();
    const env = makeEnv();

    const opt = await send("OPTIONS", "/status", null, env);
    ok(opt.res.status === 204, "OPTIONS /status -> 204");
    ok((opt.res.headers.get("access-control-allow-methods") || "").includes("GET"),
      "CORS allow-methods advertises GET");

    const m405 = await send("POST", "/status", "{}", env);
    ok(m405.res.status === 405 && m405.res.headers.get("allow") === "GET",
      "POST /status -> 405 + Allow: GET");
    ok(!m405.res.headers.get("x-request-id"), "405 carries no correlation id (deploy signal intact)");

    const n404 = await send("GET", "/nope", undefined, env);
    ok(n404.res.status === 404 && n404.out.error === "not found", "unknown path -> 404 whatever the verb");

    const noParams = await send("GET", "/status", undefined, env);
    ok(noParams.res.status === 400 && noParams.out.code === "invalid_link_id",
      "missing linkId -> 400 invalid_link_id");

    /* linkId WITHOUT the capability id is the settlement summary (form b):
       no record exists in this env, so the honest answer is its own 404 —
       never the full status body, never an upstream call. */
    const noId = await send("GET", `/status?linkId=${LINK_ID}`, undefined, env);
    ok(noId.res.status === 404 && noId.out.code === "settlement_not_found",
      "missing id -> settlement lookup: 404 settlement_not_found (no record)");

    const badId = await send("GET", `/status?id=not-an-id&linkId=${LINK_ID}`, undefined, env);
    ok(badId.res.status === 400 && badId.out.code === "invalid_intent_id",
      "malformed id -> 400 invalid_intent_id");

    const hexId = await send("GET", `/status?id=pi_zzzzzzzzzzzzzzzz&linkId=${LINK_ID}`, undefined, env);
    ok(hexId.res.status === 400 && hexId.out.code === "invalid_intent_id",
      "non-hex id -> 400 invalid_intent_id (strict capability format)");

    const shortLink = await send("GET", "/status?id=pi_0123456789abcdef&linkId=x", undefined, env);
    ok(shortLink.res.status === 400 && shortLink.out.code === "invalid_link_id",
      "short linkId -> 400 invalid_link_id");

    const before = logMark();
    const evil = await send("GET", `/status?id=pi_0123456789abcdef&linkId=${LINK_ID}`, undefined, env,
      { Origin: "https://evil.example" });
    ok(evil.res.status === 403 && evil.out.code === undefined && evil.out.error === "Origin not allowed",
      "wrong Origin -> 403");
    ok(eventCount("status_rejected", before) === 1, "origin rejection logged once as status_rejected");

    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
      "no upstream call for any rejected request");
  }

  /* ── 2. happy path: shape allowlist + authority of the stored address ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);
    ok(/^pi_[0-9a-f]{16}$/.test(intent.intentId), "created intent id matches the capability format");
    const rpcBefore = state.calls.rpc.length;

    const okBefore = logMark();
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 200, "first GET /status -> 200");
    ok(r.out.ok === true, "body carries ok:true");
    ok(r.out.intent.status === "AWAITING_DEPOSIT", "internal state AWAITING_DEPOSIT");
    ok(r.out.intent.tidepoolStatus === "PENDING_DEPOSIT", "documented Tidepool status surfaced");
    ok(r.out.intent.intentId === intent.intentId && r.out.intent.linkId === LINK_ID, "identity echoes the request");
    ok(typeof r.out.intent.quoteDeadline === "string" && typeof r.out.intent.createdAt === "string",
      "timestamps are ISO strings");
    ok(typeof r.out.intent.lastReason === "string", "lastReason present");
    ok(r.out.onChainStatus === "OPEN", "authoritative contract status included");
    ok(typeof r.out.onChainStatusCheckedAt === "string", "contract check time included");
    ok(r.out.conflict === null, "no conflict on the happy path");
    ok(r.out.changed === false, "PENDING_DEPOSIT with no transition reports changed:false");
    ok(eventCount("status_ok", okBefore) === 0, "unchanged poll does NOT log status_ok (log budget)");

    ok(JSON.stringify(Object.keys(r.out)) ===
      JSON.stringify(["ok", "intent", "onChainStatus", "onChainStatusCheckedAt", "conflict", "changed"]),
      "response keys are exactly the allowlist");
    ok(JSON.stringify(Object.keys(r.out.intent)) ===
      JSON.stringify(["intentId", "linkId", "status", "tidepoolStatus", "quoteDeadline", "lastReason", "createdAt", "updatedAt"]),
      "intent keys are exactly the allowlist");

    ok(r.res.headers.get("x-request-id"), "200 carries X-Request-Id");
    ok(state.calls.status.length === 1, "exactly one upstream status read");
    ok(state.calls.status[0].url.includes(intent.depositAddress),
      "the queried address is the STORED one from the record");
    ok(state.calls.rpc.length === rpcBefore + 1, "the authoritative contract was re-read in the same cycle");
    ok(!r.text.includes("attacker"), "no browser-supplied field echoed (n/a body is clean)");
  }

  /* ── 3. all seven documented Tidepool statuses ── */
  {
    /* observed: whether THIS transition sets the depositObserved flag —
       transition() writes it on DEPOSIT_SEEN / SETTLING / SETTLED, the
       states whose expiry the flag must block. REFUNDED / FAILED are
       terminal (no exits), so they never need the expiry guard; a refund
       that passed through DEPOSIT_SEEN keeps the flag from that earlier
       crossing (see section 12). */
    const cases = [
      ["PENDING_DEPOSIT", "AWAITING_DEPOSIT", false, false],
      ["KNOWN_DEPOSIT_TX", "DEPOSIT_SEEN", true, true],
      ["INCOMPLETE_DEPOSIT", "DEPOSIT_SEEN", true, true],
      ["PROCESSING", "SETTLING", true, true],
      ["SUCCESS", "SETTLED", true, true],
      ["REFUNDED", "REFUNDED", true, false],
      ["FAILED", "FAILED", true, false],
    ];
    for (const [tp, internal, changed, observed] of cases) {
      const state = stubNet({ statusBody: { status: tp, updatedAt: "2026-11-11T12:00:05.000Z" } });
      const env = makeEnv();
      const intent = await createIntent(env);
      const r = await getStatus(env, intent.intentId);
      ok(r.res.status === 200, `${tp} -> 200`);
      ok(r.out.intent.status === internal, `${tp} maps to internal ${internal}`);
      ok(r.out.intent.tidepoolStatus === tp, `${tp} surfaced verbatim`);
      ok(r.out.changed === changed, `${tp} changed=${changed}`);
      const rec = getRecord(env);
      const i0 = rec.intents[0];
      ok(i0.depositObserved === observed, `${tp} depositObserved=${observed}`);
      if (tp === "SUCCESS") {
        ok(r.out.intent.status !== "VERIFIED", "SUCCESS is never VERIFIED");
        ok(canTransition("SETTLED", "VERIFIED") && !canTransition("SETTLED", "FAILED"),
          "SETTLED's only exit is VERIFIED (Phase 5)");
      }
    }

    /* unit: the map itself — exactly seven statuses, nothing invented. */
    ok(mapTidepoolStatus("PENDING_DEPOSIT").ok && mapTidepoolStatus("PENDING_DEPOSIT").target === null,
      "map: PENDING_DEPOSIT -> no transition");
    ok(mapTidepoolStatus("KNOWN_DEPOSIT_TX").target === "DEPOSIT_SEEN", "map: KNOWN_DEPOSIT_TX -> DEPOSIT_SEEN");
    ok(mapTidepoolStatus("INCOMPLETE_DEPOSIT").target === "DEPOSIT_SEEN", "map: INCOMPLETE_DEPOSIT -> DEPOSIT_SEEN");
    ok(mapTidepoolStatus("PROCESSING").target === "SETTLING", "map: PROCESSING -> SETTLING");
    ok(mapTidepoolStatus("SUCCESS").target === "SETTLED", "map: SUCCESS -> SETTLED");
    ok(mapTidepoolStatus("REFUNDED").target === "REFUNDED", "map: REFUNDED -> REFUNDED");
    ok(mapTidepoolStatus("FAILED").target === "FAILED", "map: FAILED -> FAILED");
    ok(!mapTidepoolStatus("EXPIRED").ok, "Tidepool has no EXPIRED status — we never invent one");
    ok(!mapTidepoolStatus("pending_deposit").ok, "case-sensitive: lowercase is unknown");
    ok(!mapTidepoolStatus(null).ok && !mapTidepoolStatus(123).ok && !mapTidepoolStatus(undefined).ok,
      "non-string statuses are unknown");

    /* REFUNDED and FAILED remain distinct terminal states. */
    ok(!canTransition("REFUNDED", "FAILED") && !canTransition("FAILED", "REFUNDED"),
      "REFUNDED and FAILED are mutually unreachable");
    ok(isTerminal("REFUNDED") && isTerminal("FAILED") && isTerminal("EXPIRED") && isTerminal("VERIFIED"),
      "money-out / verified states are terminal");
  }

  /* ── 3b. duplicate status reads are idempotent ── */
  {
    const state = stubNet({ statusBody: { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" } });
    const env = makeEnv();
    const intent = await createIntent(env);
    const r1 = await getStatus(env, intent.intentId);
    const histAfterFirst = getRecord(env).history.length;
    ok(r1.out.changed === true && r1.out.intent.status === "DEPOSIT_SEEN", "first read transitions");
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.changed === false, "duplicate read -> 200 changed:false (idempotent)");
    ok(r2.out.intent.status === "DEPOSIT_SEEN", "state unchanged on duplicate");
    ok(getRecord(env).history.length === histAfterFirst, "no duplicate history entry / transition");
    ok(state.calls.status.length === 2, "the duplicate still counts as a (throttled-open) read window");
  }

  /* ── 4. unknown Tidepool status ── */
  {
    const state = stubNet({ statusMode: "unknown" });
    const env = makeEnv();
    const intent = await createIntent(env);
    const rejBefore = logMark();
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 503 && r.out.code === "status_unknown", "unknown status -> 503 status_unknown");
    ok(Number.isFinite(r.out.retryAfterSec) && r.out.retryAfterSec >= 1, "503 carries retryAfterSec");
    ok(r.res.headers.get("retry-after"), "503 carries a Retry-After header");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "UNKNOWN", "parked in UNKNOWN");
    ok(rec.intents[0].tidepoolStatus === "SOMETHING_ELSE", "raw value stored (bounded) for diagnosis");
    ok(eventCount("status_rejected", rejBefore) === 0, "cooldown-style 503 does NOT log status_rejected");

    const calls = state.calls.status.length;
    const again = await getStatus(env, intent.intentId);
    ok(again.res.status === 503 && again.out.code === "reconcile_cooldown",
      "immediate retry -> 503 reconcile_cooldown (backoff)");
    ok(state.calls.status.length === calls, "backoff: zero upstream reads while cooling down");

    advance(60000); // default ambiguous cooldown elapses
    state.statusMode = "ok";
    state.statusBody = { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T12:01:00.000Z" };
    const healed = await getStatus(env, intent.intentId);
    ok(healed.res.status === 200 && healed.out.intent.status === "AWAITING_DEPOSIT",
      "after cooldown a definite answer resolves UNKNOWN -> AWAITING_DEPOSIT");
    ok(healed.out.changed === true, "recovery counts as a change");
  }

  /* ── 4b. the view never surfaces a raw, non-documented status ── */
  {
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      tidepoolStatus: "TOTALLY_FAKE_RAW",
      lastStatusPollAt: clock - 500,   // inside the poll floor -> served from the record
    })]));
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 200 && r.out.intent.tidepoolStatus === null,
      "view returns null for a non-documented stored status");
    ok(state.calls.status.length === 0, "throttled: zero upstream reads");
  }

  /* ── 5. invalid upstream responses (garbage, bad shape, 5xx, timeout, 404) ── */
  {
    const modes = [
      ["garbage200", "unreadable"],
      ["badshape", "bad_shape"],
      ["http500", "http_status"],
      ["not_found", "not_found"],
    ];
    for (const [mode, lastError] of modes) {
      const state = stubNet({ statusMode: mode });
      const env = makeEnv();
      const intent = await createIntent(env);
      const r = await getStatus(env, intent.intentId);
      ok(r.res.status === 503 && r.out.code === "reconcile_cooldown",
        `${mode} -> 503 reconcile_cooldown`);
      const rec = getRecord(env);
      ok(rec.intents[0].status === "RECONCILE", `${mode} parks in RECONCILE`);
      ok(rec.intents[0].lastError === lastError, `${mode} records lastError=${lastError}`);
      ok(!r.text.includes("STATUS-DETAIL-MARKER"), `${mode}: upstream detail never leaves`);
      const calls = state.calls.status.length;
      const again = await getStatus(env, intent.intentId);
      ok(again.res.status === 503 && state.calls.status.length === calls,
        `${mode}: immediate retry is backed off with zero reads`);
      const upErr = logs.slice(-50).filter((e) => e.event === "status_upstream_error");
      ok(upErr.some((e) => e.level === "error" && e.target === "status"),
        `${mode}: status_upstream_error logged at level error`);
    }

    /* unknown deposit address (Tidepool 404 for OUR stored address) */
    const nf = stubNet({ statusMode: "not_found" });
    const envNf = makeEnv();
    const intentNf = await createIntent(envNf);
    await getStatus(envNf, intentNf.intentId);
    ok(getRecord(envNf).intents[0].lastError === "not_found",
      "unknown deposit address -> lastError not_found, still never a success");

    /* timeout: hang until the upstream budget aborts (50 ms for speed) */
    const hs = stubNet({ statusMode: "hang" });
    const envH = makeEnv({ TIDEPOOL_TIMEOUT_MS: "50" });
    const intentH = await createIntent(envH);
    const rh = await getStatus(envH, intentH.intentId);
    ok(rh.res.status === 503 && getRecord(envH).intents[0].lastError === "timeout",
      "Tidepool timeout -> 503 + lastError timeout");
    ok(getRecord(envH).intents[0].status === "RECONCILE", "timeout parks in RECONCILE");
  }

  /* ── 6. rate limit (429 + Retry-After) ── */
  {
    const state = stubNet({ statusMode: "http429", statusRetryAfter: "120" });
    const env = makeEnv();
    const intent = await createIntent(env);
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown", "429 -> 503 reconcile_cooldown");
    const rec = getRecord(env);
    const cooldown = rec.intents[0].reconcileUntil - clock;
    ok(cooldown === 120000, `Retry-After 120 s honoured: cooldown is ${cooldown} ms (max of own + upstream)`);
    ok(r.out.retryAfterSec === 120, "503 retryAfterSec follows the upstream Retry-After");

    const calls = state.calls.status.length;
    const again = await getStatus(env, intent.intentId);
    ok(again.res.status === 503 && state.calls.status.length === calls,
      "rate-limited: further polls are backed off with zero reads");
    advance(61000);
    const mid = await getStatus(env, intent.intentId);
    ok(mid.res.status === 503 && state.calls.status.length === calls && mid.out.retryAfterSec === 59,
      "cooldown still active at +61 s (retryAfterSec counts down), zero reads");

    advance(59000); // 120 000 ms elapsed
    state.statusMode = "ok";
    state.statusBody = { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T12:02:00.000Z" };
    const recovered = await getStatus(env, intent.intentId);
    ok(recovered.res.status === 200 && state.calls.status.length === calls + 1,
      "reads resume only after the honoured Retry-After window");

    /* an absurd Retry-After is clamped to this Worker's own ceiling */
    const cl = stubNet({ statusMode: "http429", statusRetryAfter: "999999" });
    const envCl = makeEnv();
    const intentCl = await createIntent(envCl);
    await getStatus(envCl, intentCl.intentId);
    const clamped = getRecord(envCl).intents[0].reconcileUntil - clock;
    ok(clamped === 3600000, `Retry-After clamp: ${clamped} ms (<= MAX_AMBIGUOUS_COOLDOWN_MS)`);
    void cl;
  }

  /* ── 7. temporary failure -> backoff -> recovery ── */
  {
    const state = stubNet({ statusMode: "http500" });
    const env = makeEnv();
    const intent = await createIntent(env);
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 503, "temporary 5xx -> 503");
    const calls = state.calls.status.length;
    const again = await getStatus(env, intent.intentId);
    ok(again.res.status === 503 && state.calls.status.length === calls,
      "no hammering while the cooldown is active");
    advance(60000);
    state.statusMode = "ok";
    state.statusBody = { status: "PROCESSING", updatedAt: "2026-11-11T12:01:00.000Z" };
    const healed = await getStatus(env, intent.intentId);
    ok(healed.res.status === 200 && healed.out.intent.status === "SETTLING",
      "after backoff the next read reconciles RECONCILE -> SETTLING");
    ok(healed.out.changed === true, "recovery transition reported");
    ok(state.calls.status.length === calls + 1, "exactly one read per open cycle");
  }

  /* ── 8. duplicate polling (sequential) ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.res.status === 200 && state.calls.status.length === 1, "first poll reads once");
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.changed === false, "immediate second poll answered from the record");
    ok(state.calls.status.length === 1, "duplicate poll performs ZERO upstream reads (2 s floor)");
    advance(1999);
    const almost = await getStatus(env, intent.intentId);
    ok(almost.res.status === 200 && state.calls.status.length === 1, "1999 ms later still throttled");
    advance(1);
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.res.status === 200 && state.calls.status.length === 2, "at exactly the floor a new cycle runs");
    ok(state.calls.rpc.length === 3, "every cycle re-reads the authoritative contract");
  }

  /* ── 9. concurrent polling (no input gates: the persisted stamp holds) ── */
  {
    const state = stubNet();
    const env = makeEnv({}, { serialize: false });
    const intent = await createIntent(env);
    let release = null;
    state.statusMode = () => new Promise((resolve) => {
      release = (body) => resolve(jsonResp(200, body));
    });

    const aPromise = getStatus(env, intent.intentId);
    for (let i = 0; i < 200 && state.calls.status.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    ok(state.calls.status.length === 1, "first concurrent request reached the upstream exactly once");

    const b = await getStatus(env, intent.intentId);
    ok(b.res.status === 200 && b.out.changed === false, "second concurrent request answered 200 from the record");
    ok(state.calls.status.length === 1, "second concurrent request issued ZERO upstream reads");
    ok(getRecord(env).intents[0].lastStatusPollAt === clock, "the poll stamp was persisted before the reads");

    release({ status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" });
    const a = await aPromise;
    ok(a.res.status === 200 && a.out.intent.status === "DEPOSIT_SEEN",
      "first request completed its transition after the upstream answered");
    ok(state.calls.status.length === 1, "two overlapping requests -> exactly one upstream read, one transition");
    ok(getRecord(env).history.filter((h) => h.to === "DEPOSIT_SEEN").length === 1,
      "exactly one DEPOSIT_SEEN transition recorded");
  }

  /* ── 10. terminal state protection (zero upstream reads, ever) ── */
  {
    for (const st of ["SETTLED", "VERIFIED", "REFUNDED", "FAILED", "EXPIRED"]) {
      const state = stubNet({ statusMode: "http500" }); // hostile upstream, never reached
      const env = makeEnv();
      env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: st })]));
      const r = await getStatus(env, SEED_ID);
      ok(r.res.status === 200 && r.out.intent.status === st && r.out.changed === false,
        `${st} answered from the record`);
      ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
        `${st}: ZERO upstream reads (docs: stop on final status)`);
    }

    /* SUCCESS then stop: the second poll must not touch anything. */
    const state = stubNet({ statusBody: { status: "SUCCESS", updatedAt: "2026-11-11T12:00:05.000Z" } });
    const env = makeEnv();
    const intent = await createIntent(env);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.out.intent.status === "SETTLED" && r1.out.changed === true, "SUCCESS -> SETTLED");
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "SETTLED" && r2.out.changed === false,
      "SETTLED re-read is a no-op view");
    ok(state.calls.status.length === 1, "no status read after settlement");

    /* an addressless (CREATING / ambiguous) intent: nothing to query. */
    const state2 = stubNet();
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "CREATING", depositAddress: null })]));
    const rc = await getStatus(env2, SEED_ID);
    ok(rc.res.status === 200 && rc.out.intent.status === "CREATING" && state2.calls.status.length === 0,
      "addressless intent answered from the record, zero reads");
  }

  /* ── 11. expired deposits: real deadline + observed state ── */
  {
    /* past the deadline with no observed deposit -> EXPIRED, then stop. */
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);
    advance(3_600_001); // quote window is exactly 3 600 000 ms
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 200 && r.out.intent.status === "EXPIRED" && r.out.changed === true,
      "PENDING_DEPOSIT past the actual quote deadline -> EXPIRED");
    ok(r.out.intent.tidepoolStatus === "PENDING_DEPOSIT", "Tidepool's own status stays PENDING_DEPOSIT (docs: no EXPIRED)");
    const calls = state.calls.status.length;
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && state.calls.status.length === calls,
      "EXPIRED is terminal: no further reads");

    /* an OBSERVED deposit is never expired, even past the deadline. */
    const st3 = stubNet({ statusBody: { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T14:00:00.000Z" } });
    const env3 = makeEnv();
    env3.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "DEPOSIT_SEEN", depositObserved: true, tidepoolStatus: "KNOWN_DEPOSIT_TX",
      quoteDeadlineMs: clock - 1000,
    })]));
    const r3 = await getStatus(env3, SEED_ID);
    ok(r3.res.status === 200 && r3.out.intent.status === "DEPOSIT_SEEN",
      "DEPOSIT_SEEN past deadline is NOT expired (observed deposit wins)");
    ok(r3.out.changed === false, "no spurious transition");
    void st3;

    /* a deposit observed BEFORE a failure parked the intent: the park
       must not open an expiry path either (RECONCILE + observed). */
    const st4 = stubNet({ statusBody: { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T14:00:00.000Z" } });
    const env4 = makeEnv();
    env4.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "RECONCILE", depositObserved: true, tidepoolStatus: "KNOWN_DEPOSIT_TX",
      reconcileUntil: null, lastError: "http_status", quoteDeadlineMs: clock - 1000,
    })]));
    const r4 = await getStatus(env4, SEED_ID);
    ok(r4.res.status === 200 && r4.out.intent.status === "DEPOSIT_SEEN",
      "RECONCILE + observed deposit + past deadline -> resolves to DEPOSIT_SEEN, never EXPIRED");
    ok(r4.out.changed === true, "the honest resolution is reported as a change");
    void st4;

    /* without an observed deposit the same park DOES expire. */
    const st5 = stubNet({ statusBody: { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T14:00:00.000Z" } });
    const env5 = makeEnv();
    env5.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "RECONCILE", depositObserved: false, reconcileUntil: null,
      lastError: "http_status", quoteDeadlineMs: clock - 1000,
    })]));
    const r5 = await getStatus(env5, SEED_ID);
    ok(r5.res.status === 200 && r5.out.intent.status === "EXPIRED",
      "RECONCILE + NO deposit + past deadline -> EXPIRED");
    void st5;
  }

  /* ── 12. partial deposit -> refund (distinct terminal outcomes) ── */
  {
    const state = stubNet({ statusBody: { status: "INCOMPLETE_DEPOSIT", updatedAt: "2026-11-11T12:00:05.000Z" } });
    const env = makeEnv();
    const intent = await createIntent(env);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.out.intent.status === "DEPOSIT_SEEN" && r1.out.changed === true,
      "partial deposit (INCOMPLETE_DEPOSIT) -> DEPOSIT_SEEN, not FAILED");
    ok(getRecord(env).intents[0].depositObserved === true, "partial deposit marks the deposit observed");

    advance(2000);
    state.statusBody = { status: "REFUNDED", updatedAt: "2026-11-11T12:00:10.000Z" };
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "REFUNDED" && r2.out.changed === true,
      "the refunded deposit lands as REFUNDED (distinct from FAILED)");
    ok(canTransition("DEPOSIT_SEEN", "REFUNDED"), "the machine allows the observed-deposit refund");

    advance(2000);
    const calls = state.calls.status.length;
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.res.status === 200 && r3.out.intent.status === "REFUNDED" && state.calls.status.length === calls,
      "REFUNDED is terminal: no further reads");
  }

  /* ── 13. NEAR invoice goes PAID while the Tidepool payment is active ── */
  {
    const conflictBefore = logMark();
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);

    const r1 = await getStatus(env, intent.intentId);
    ok(r1.out.conflict === null && r1.out.onChainStatus === "OPEN", "baseline: OPEN, no conflict");

    /* the payer settles the ORIGINAL NEAR invoice mid-flight */
    state.link.status = "PAID";
    advance(2000);
    state.statusBody = { status: "PROCESSING", updatedAt: "2026-11-11T12:00:05.000Z" };
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200, "status polling continues after the conflict");
    ok(r2.out.conflict === "invoice_paid", "conflict detected: invoice_paid surfaced");
    ok(r2.out.onChainStatus === "PAID", "fresh contract state included");
    ok(r2.out.intent.status === "SETTLING", "the Tidepool leg is still tracked");
    ok(eventCount("invoice_conflict", conflictBefore) === 1, "invoice_conflict logged exactly once");
    const conflictLog = logs.filter((e) => e.event === "invoice_conflict")[0];
    ok(conflictLog && conflictLog.level === "alert" && conflictLog.onChainStatus === "PAID" &&
      conflictLog.previous === "OPEN", "conflict log carries previous + new state at level alert");
    const rec = getRecord(env);
    ok(rec.conflict && rec.conflict.kind === "invoice_paid" && rec.conflict.onChainStatus === "PAID",
      "conflict persisted on the record");
    ok(typeof rec.conflict.detectedAt === "number", "conflict carries its detection time");
    ok(state.calls.rpc.length === 3, "the contract is re-read on EVERY non-terminal cycle (create + 2 cycles)");

    /* Tidepool completes anyway: observe the double-pay outcome. */
    advance(2000);
    state.statusBody = { status: "SUCCESS", updatedAt: "2026-11-11T12:00:10.000Z" };
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.out.intent.status === "SETTLED", "Tidepool SUCCESS -> SETTLED (awaiting Phase 5 verification)");
    ok(r3.out.conflict === "invoice_paid", "conflict still surfaced on every response");
    ok(eventCount("invoice_conflict", conflictBefore) === 1, "still logged only once (no log spam)");
    ok(state.calls.status.length === 3 && state.calls.rpc.length === 4,
      "polling CONTINUES through the conflict — only observation reveals the double pay");

    /* the record-level truth Phase 5 will act on */
    const finalRec = getRecord(env);
    ok(finalRec.conflict.kind === "invoice_paid" && finalRec.intents[0].status === "SETTLED",
      "record holds SETTLED + invoice_paid for manual review");
  }

  /* ── 14. reconciliation conflicts around the contract read ── */
  {
    /* contract read failure: the status response survives, staleness shows. */
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);
    const checkedBefore = getRecord(env).onChainCheckedAt;
    const warnBefore = logs.filter((e) => e.event === "status_upstream_error" && e.target === "contract").length;
    state.rpcMode = "http500";
    advance(2000);
    state.statusBody = { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" };
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 200, "contract read failure does NOT fail the status response");
    ok(r.out.intent.status === "DEPOSIT_SEEN", "the Tidepool leg still reconciles");
    ok(r.out.onChainStatus === "OPEN", "last KNOWN contract state kept");
    ok(r.out.onChainStatusCheckedAt === new Date(checkedBefore).toISOString(),
      "onChainStatusCheckedAt NOT advanced (staleness is honest)");
    const contractWarns = logs.filter((e) => e.event === "status_upstream_error" && e.target === "contract");
    ok(contractWarns.length > warnBefore && contractWarns.slice(-1)[0].level === "warn",
      "contract read failure logged at level warn");
    ok(!JSON.stringify(contractWarns.slice(-1)).includes("RPC-DETAIL-MARKER"),
      "contract failure detail never reaches the logs or body");

    /* invoice cancelled mid-flight: not a double-pay conflict. */
    const state2 = stubNet();
    const env2 = makeEnv();
    const intent2 = await createIntent(env2);
    const conflictBefore = logMark();
    state2.link.status = "CANCELLED";
    advance(2000);
    const r2 = await getStatus(env2, intent2.intentId);
    ok(r2.res.status === 200 && r2.out.onChainStatus === "CANCELLED" && r2.out.conflict === null,
      "CANCELLED is surfaced but is not an invoice_paid conflict");
    ok(eventCount("invoice_conflict", conflictBefore) === 0, "no conflict log for a non-PAID transition");
  }

  /* ── 15. capability: the intentId is the read key, nothing else ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const intent = await createIntent(env);

    const unknown = await getStatus(env, "pi_ffffffffffffffff");
    ok(unknown.res.status === 404 && unknown.out.code === "intent_not_found",
      "well-formed but unknown id -> 404 intent_not_found");

    const wrongInvoice = await getStatus(env, intent.intentId, OTHER_LINK_ID);
    ok(wrongInvoice.res.status === 404 && wrongInvoice.out.code === "intent_not_found",
      "real id + different invoice's linkId -> 404 (ids are not transferable)");

    const noRecord = await getStatus(env, SEED_ID, OTHER_LINK_ID);
    ok(noRecord.res.status === 404, "unknown invoice -> 404");

    /* A browser-supplied deposit address is ignored — never believed. */
    const r = await getStatus(env, intent.intentId, LINK_ID, "&depositAddress=attacker-controlled-address");
    ok(r.res.status === 200, "extra depositAddress parameter does not break or steer the request");
    ok(!r.text.includes("attacker"), "the supplied value is never echoed");
    ok(state.calls.status.every((c) => c.url.includes(intent.depositAddress)),
      "every upstream read used the STORED address");
    ok(state.calls.status.every((c) => !c.url.includes("attacker")),
      "the browser-supplied address was never queried");

    const sigParam = await getStatus(env, intent.intentId, LINK_ID, "&signature=ed25519:zzz&correlationId=cid-evil");
    ok(sigParam.res.status === 200 && !sigParam.text.includes("cid-evil"),
      "signature/correlationId query params are ignored, never reflected");
    ok(state.calls.status.every((c) => !c.url.includes("cid-evil")), "no extra parameter reaches the upstream");
  }

  /* ── 16. env bounds + helpers (units) ── */
  {
    ok(statusMinIntervalMs({}) === 2000, "default poll floor is 2000 ms (docs: 2–5 s)");
    ok(statusMinIntervalMs({ TIDEPOOL_STATUS_MIN_INTERVAL_MS: "5000" }) === 5000, "in-range floor honoured");
    ok(statusMinIntervalMs({ TIDEPOOL_STATUS_MIN_INTERVAL_MS: "1500" }) === 1500, "1500 ms in range");
    ok(statusMinIntervalMs({ TIDEPOOL_STATUS_MIN_INTERVAL_MS: "100" }) === 2000, "below 1000 falls back to default");
    ok(statusMinIntervalMs({ TIDEPOOL_STATUS_MIN_INTERVAL_MS: "999999" }) === 2000, "above 60000 falls back to default");
    ok(statusMinIntervalMs({ TIDEPOOL_STATUS_MIN_INTERVAL_MS: "abc" }) === 2000, "non-numeric falls back to default");

    ok(depositObserved({ status: "AWAITING_DEPOSIT" }) === false, "depositObserved: false when nothing seen");
    ok(depositObserved({ status: "AWAITING_DEPOSIT", depositObserved: true }) === true, "flag alone suffices");
    ok(depositObserved({ status: "DEPOSIT_SEEN" }) === true, "DEPOSIT_SEEN back-computes as observed");
    ok(depositObserved({ status: "SETTLED" }) === true, "SETTLED back-computes as observed");
    ok(depositObserved(null) === false, "null-safe");
  }

  /* ── 17. watch limit: stop asking 24 h after the deadline (docs) ── */
  {
    const state = stubNet({ statusMode: "http500" }); // never reached
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      quoteDeadlineMs: clock - 86_400_000 - 1,
    })]));
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 200 && r.out.intent.status === "AWAITING_DEPOSIT" && r.out.changed === false,
      "past deadline + 24 h: answered from the record (no invented transition)");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
      "watch limit: ZERO upstream reads after Tidepool's own watcher stops");

    /* just inside the window still reads. */
    const state2 = stubNet();
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      quoteDeadlineMs: clock - 86_400_000 + 60_000,
    })]));
    const r2 = await getStatus(env2, SEED_ID);
    ok(r2.res.status === 200 && state2.calls.status.length === 1,
      "inside the 24 h window a read still happens");
  }

  /* ── 17b. settlement summary: GET /status?linkId=… (no capability id) ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const depositTs = clock - 300_000;
    const settleTs = clock - 240_000;
    const verifiedTs = clock - 60_000;
    const payoutTx = b58encode(new Uint8Array(32).fill(9));
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "VERIFIED",
      depositObserved: true,
      payoutHashes: [payoutTx, "not-a-hash", 42], // non-hashes must be filtered on the way out
      updatedAt: verifiedTs,
    })], {
      history: [
        { ts: clock - 400_000, intentId: SEED_ID, from: "QUOTE_ISSUED", to: "AWAITING_DEPOSIT", reason: "awaiting_deposit" },
        { ts: depositTs, intentId: SEED_ID, from: "AWAITING_DEPOSIT", to: "DEPOSIT_SEEN", reason: "deposit_seen" },
        { ts: settleTs, intentId: SEED_ID, from: "DEPOSIT_SEEN", to: "SETTLING", reason: "settlement_detected" },
        { ts: verifiedTs, intentId: SEED_ID, from: "SETTLED", to: "VERIFIED", reason: "payout_verified" },
      ],
    }));

    const before = logMark();
    const r = await send("GET", `/status?linkId=${LINK_ID}`, undefined, env);
    ok(r.res.status === 200 && r.out.ok === true, "linkId-only GET /status -> 200 settlement summary");
    ok(JSON.stringify(Object.keys(r.out)) ===
      JSON.stringify(["ok", "settlement", "onChainStatus", "onChainStatusCheckedAt"]),
      "settlement response keys are exactly the allowlist");
    ok(r.out.settlement && JSON.stringify(Object.keys(r.out.settlement)) ===
      JSON.stringify(["intentId", "status", "depositSeenAt", "verifiedAt", "payoutTx"]),
      "settlement keys are exactly the allowlist");
    ok(r.out.settlement.intentId === SEED_ID && r.out.settlement.status === "VERIFIED",
      "intent id + status echo the settled record");
    ok(r.out.settlement.depositSeenAt === new Date(depositTs).toISOString(),
      "deposit date = the earliest deposit-family transition");
    ok(r.out.settlement.verifiedAt === new Date(verifiedTs).toISOString(),
      "verified date = the VERIFIED transition");
    ok(JSON.stringify(r.out.settlement.payoutTx) === JSON.stringify([payoutTx]),
      "payout hash served once VERIFIED; non-hash junk filtered out");
    ok(r.out.onChainStatus === "OPEN" && typeof r.out.onChainStatusCheckedAt === "string",
      "on-chain status rides along (still honestly OPEN)");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
      "the settlement lookup makes ZERO upstream calls");
    ok(eventCount("status_ok", before) === 0, "settlement reads stay silent (log budget)");
    ok(!ADDR_RE.test(r.text) && !r.text.includes("depositAddress") && !r.text.includes("correlationId") &&
       !r.text.includes("swapDetails") && !r.text.includes('"history"') && !r.text.includes("ed25519:"),
      "the settlement body carries no capability-only field");

    /* An intent that never saw a deposit answers honestly. */
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "AWAITING_DEPOSIT",
      payoutHashes: [payoutTx],
    })]));
    const r2 = await send("GET", `/status?linkId=${LINK_ID}`, undefined, env2);
    ok(r2.res.status === 200 && r2.out.settlement.depositSeenAt === null &&
      r2.out.settlement.verifiedAt === null && r2.out.settlement.payoutTx.length === 0,
      "no deposit yet: null dates and empty payoutTx (hashes only after VERIFIED)");

    /* Unknown invoice, and a record holding no intents. */
    const env3 = makeEnv();
    const r3 = await send("GET", `/status?linkId=${OTHER_LINK_ID}`, undefined, env3);
    ok(r3.res.status === 404 && r3.out.code === "settlement_not_found",
      "unknown linkId -> 404 settlement_not_found");

    const env4 = makeEnv();
    env4.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { intents: [] }));
    const r4 = await send("GET", `/status?linkId=${LINK_ID}`, undefined, env4);
    ok(r4.res.status === 404 && r4.out.code === "settlement_not_found",
      "record with no intents -> 404 settlement_not_found");

    /* The capability form is untouched: with the id, the FULL body. */
    const r5 = await getStatus(env, SEED_ID);
    ok(r5.res.status === 200 && r5.out.intent && r5.out.intent.intentId === SEED_ID &&
      typeof r5.out.intent.lastReason === "string",
      "capability form unchanged: full intent body when id is present");
    ok(JSON.stringify(Object.keys(r5.out)) ===
      JSON.stringify(["ok", "intent", "onChainStatus", "onChainStatusCheckedAt", "conflict", "changed"]),
      "capability response keys still the original allowlist");
  }

  /* ── 18. sweeps: sensitive data, envelope, logging budget ── */
  {
    const allStatus = statusTexts.join("\n");
    ok(statusTexts.length >= 40, `sweep ran over a meaningful sample (${statusTexts.length} /status responses)`);
    ok(!ADDR_RE.test(allStatus), "sweep: no deposit address appears in ANY /status response");
    ok(!allStatus.includes("ed25519:"), "sweep: no signature appears in ANY /status response");
    ok(!allStatus.includes("SEEDSIGNATURE"), "sweep: the seeded record signature never leaks");
    ok(!allStatus.includes("depositAddress") && !allStatus.includes("depositMemo"),
      "sweep: no deposit field names in ANY /status response");
    ok(!allStatus.includes("correlationId") && !allStatus.includes("cid-test-"),
      "sweep: no correlation id in ANY /status response");
    ok(!allStatus.includes("swapDetails") && !allStatus.includes("TxHash") && !allStatus.includes("refundReason"),
      "sweep: no upstream swap details in ANY /status response");
    ok(!allStatus.includes("STATUS-DETAIL-MARKER") && !allStatus.includes("RPC-DETAIL-MARKER") &&
       !allStatus.includes("UPSTREAM-DETAIL-MARKER"),
      "sweep: no upstream detail appears in any response");
    ok(!allStatus.includes("SOMETHING_ELSE") && !allStatus.includes("TOTALLY_FAKE"),
      "sweep: raw/unknown upstream status strings never reach a client body");
    ok(!allStatus.includes('"history"') && !allStatus.includes("reconcileUntil") &&
       !allStatus.includes("lastStatusPollAt") && !allStatus.includes("depositObserved"),
      "sweep: no internal bookkeeping field in ANY /status response");
    ok(!allStatus.includes("at Object.") && !allStatus.includes("node:internal") && !allStatus.includes("index.js:"),
      "sweep: no stack-trace fragment appears in any response");

    const allLogs = logs.map((e) => JSON.stringify(e)).join("\n");
    ok(logs.length > 0 && logs.every((e) => e.ts && e.svc && e.build && e.level && e.event),
      `M-01: every log line carries the envelope (${logs.length} lines)`);
    ok(logs.every((e) => e.svc === "paylink-tidepool"), "M-01: svc is paylink-tidepool on every line");
    ok(!ADDR_RE.test(allLogs), "sweep: no deposit address appears in any log line");
    ok(!allLogs.includes("ed25519:"), "sweep: no signature appears in any log line");
    ok(!allLogs.includes("STATUS-DETAIL-MARKER") && !allLogs.includes("RPC-DETAIL-MARKER"),
      "sweep: no upstream detail appears in any log line");
    ok(!allLogs.includes("cid-test-") && !allLogs.includes("SEEDSIGNATURE"),
      "sweep: no correlation id or seeded signature in any log line");
    ok(!allLogs.includes("attacker"), "sweep: browser-supplied values never reach a log line");

    /* logging budget: status_ok only on change; rejections only 4xx. */
    const statusOk = logs.filter((e) => e.event === "status_ok");
    ok(statusOk.length > 0, `status_ok observed (${statusOk.length} times)`);
    ok(statusOk.every((e) => e.level === "info" && e.rid && e.linkId && e.intentId && e.status),
      "status_ok lines carry the standard fields");
    const cooldownPolls = statusTexts.filter((t) => t.includes("reconcile_cooldown")).length;
    ok(cooldownPolls > 0, `cooldown 503s exercised (${cooldownPolls}) — and:`);
    const rejected = logs.filter((e) => e.event === "status_rejected");
    ok(rejected.every((e) => e.status === 400 || e.status === 403 || e.status === 404),
      "status_rejected only ever fires for 4xx (cooldown 503s stay silent)");
    ok(rejected.every((e) => e.code || e.reason), "status_rejected carries a machine code");
    ok(!rejected.some((e) => e.code === "reconcile_cooldown" || e.code === "status_unknown"),
      "reconcile_cooldown / status_unknown never logged as status_rejected");
    ok(!bodies.join("\n").includes("REPLACE_WITH"), "no config placeholder leaked anywhere");
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
