/* Phase 5 tests: independent payout verification — SETTLED -> VERIFIED.
 *
 * Proves that a Tidepool SUCCESS never becomes VERIFIED on its word
 * alone: the transition requires authoritative NEAR transaction evidence
 * (exactly one successful ft_transfer of the invoice amount to the
 * merchant on the configured USDC token, args and NEP-297 event
 * agreeing) plus a FRESH get_link immediately before the move — and
 * that every gap fails closed:
 *
 *   - exact / wrong recipient / wrong amount / wrong token / failed
 *     receipt / missing transfer / unusable tx shape;
 *   - missing, malformed, duplicate and multiple candidate hashes;
 *     delayed visibility and retry; RPC errors and inconclusive
 *     contract reads; the EXPERIMENTAL_tx_status fallback;
 *   - duplicate / rapid verification requests (throttled, idempotent),
 *     backoff windows, hold reasons logged once per distinct reason;
 *   - the cross-provider race: the invoice turns PAID/CLAIMED after the
 *     last Phase 4 poll but before verification -> invoice_paid conflict
 *     preserved, hold, never VERIFIED; stored conflict -> zero-read hold;
 *   - contract merchant/amount mismatch -> invoice_mismatch hold;
 *   - no direct UNKNOWN/RECONCILE -> VERIFIED; VERIFIED terminal;
 *   - response/log sweeps: no hash, swapDetails, deposit address or
 *     detail marker ever reaches a /status body or a log line.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts
 * Tidepool or a NEAR node. All transaction fixtures are MOCKS built to
 * the real tx_status shape observed against live testnet nodes (receipts
 * + receipts_outcome + NEP-297 logs); the real settlement transaction's
 * receipt inventory is the template (one ft_transfer on the token
 * contract, dip4 ledger moves living in the verifier's own receipt).
 * Quote responses are signed by this file under a per-run Ed25519 key
 * injected via TIDEPOOL_MAKER_KEY. INTENT_DO is the same harness as
 * status.test.mjs. Date.now is pinned for deterministic throttle,
 * backoff and deadline arithmetic.
 */

import worker, {
  PaymentIntent,
  clearDiscoveryCache,
  verifyBackoffMs,
  canTransition,
  isTerminal,
  mapTidepoolStatus,
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

/* Global log capture: worker log lines are single-line JSON — swallow
   and keep them (for the sweeps); anything else passes through. */
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
const DEST_TOKEN = "usdc.tidepool-sandbox.testnet";   // bare account of DEST_ASSET
const SRC_NEAR = "nep141:wnear.tidepool-sandbox.testnet";
const LINK_ID = "lnk-coffee-001";
const MERCHANT = "merchant.testnet";
const AMOUNT = "2500000";
/* Unique mock deposit addresses: "pa"+counter+filler, so sweeps can
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

const REQ_SIGNED = [
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType",
  "destinationAsset", "amount", "refundTo", "refundType", "recipient",
  "recipientType", "deadline",
];
const COND_SIGNED = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];
const QUOTE_SIGNED = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"];
const EXEC_SIGNED = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];

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
    contractAddress: DEST_TOKEN, coingeckoId: "usd-coin",
  },
  {
    assetId: SRC_NEAR, decimals: 24, blockchain: "near", symbol: "wNEAR",
    price: 1.19, priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "wnear.tidepool-sandbox.testnet", coingeckoId: "near",
  },
];

const openLink = (over = {}) => ({
  link_id: LINK_ID,
  creator: MERCHANT,
  amount: AMOUNT,
  token: DEST_TOKEN,
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

/* ── candidate hashes (server-side capture only) ─────────────────────── */

const H1 = b58encode(new Uint8Array(32).fill(0x11));
const H2 = b58encode(new Uint8Array(32).fill(0x22));
const H3 = b58encode(new Uint8Array(32).fill(0x33));
const HEX_HASH = "0x38d81431b9f76d9699af7517040d5221d9dea252";  // other chain: skipped
const BAD_HASH = "not-a-valid-hash";                            // '-' is not base58
const SHORT_HASH = "2Wx7Yb9Q";                                  // base58, not 32 bytes

/* swapDetails per the docs' real SUCCESS example: the settlement hash
   appears in BOTH lists (dedupe), the deposit leg and intent hashes
   are never transactions. */
const swap = (over = {}) => ({
  intentHashes: ["DsrGVDFfwq6ifa9LctU2JaCzWB2kZB1VzNe1XHFCC3qS", "23MCaK5ZV2qanV6p1LYzpGh7zwPC3pa9vqGSm6hLij6H"],
  nearTxHashes: [H1],
  destinationChainTxHashes: [{ hash: H1, chain: "near" }],
  originChainTxHashes: [{ hash: "HbwEo318L69bJS7XYse18mUTzBBa2tjK6wtGeDYo3dY8", chain: "near" }],
  ...over,
});

const successWith = (sd) => ({
  status: "SUCCESS",
  updatedAt: "2026-11-11T12:00:05.000Z",
  ...(sd ? { swapDetails: sd } : {}),
});

/* ── tx_status fixtures (real shape: receipts + receipts_outcome) ────── */

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const ftArgs = (to, amount, memo = null) => b64({ receiver_id: to, amount, memo });
const nep297 = (from, to, amount) =>
  `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer",
    data: [{ old_owner_id: from, new_owner_id: to, amount }] })}`;

/* One ft_transfer receipt on a token contract, with its outcome. */
const payReceipt = (o = {}) => {
  const {
    id = "rcpay0001", pred = "verifier.tidepool-sandbox.testnet", token = DEST_TOKEN,
    to = MERCHANT, amount = AMOUNT, status = { "SuccessValue": "" }, event, memo = null,
  } = o;
  const ev = event === undefined ? nep297(pred, to, amount) : event; // string | null
  return {
    receipt: {
      receipt_id: id,
      predecessor_id: pred,
      receiver_id: token,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer", args: ftArgs(to, amount, memo), gas: "30000000000000", deposit: "1" } }] } },
    },
    outcome: { id, outcome: { status, logs: ev === null ? [] : [ev] } },
  };
};

/* The dip4 execute_intents receipt the settlement tx opens with. */
const execReceipt = () => ({
  receipt: {
    receipt_id: "rcexec001",
    predecessor_id: "maker.tidepool-sandbox.testnet",
    receiver_id: "verifier.tidepool-sandbox.testnet",
    receipt: { Action: { actions: [{ FunctionCall: { method_name: "execute_intents", args: b64({ signed: [] }), gas: "1", deposit: "0" } }] } },
  },
  outcome: { id: "rcexec001", outcome: { status: { "SuccessValue": "" }, logs: [] } },
});

const makeTx = (o = {}) => {
  const {
    signer = "maker.tidepool-sandbox.testnet",
    receiver = "verifier.tidepool-sandbox.testnet",
    receipts = [execReceipt()],
    txStatus = { "SuccessValue": "" },
    omitFirst = false,             // nearcore's signer===receiver omission
    txActions = null,
  } = o;
  const first = receipts[0];
  const kept = omitFirst ? receipts.slice(1) : receipts;
  return {
    final_execution_status: "FINAL",
    status: txStatus,
    transaction: {
      signer_id: signer,
      receiver_id: receiver,
      actions: txActions || [{ FunctionCall: { method_name: "execute_intents", args: b64({ signed: [] }), gas: "1", deposit: "0" } }],
    },
    /* transaction_outcome IS the first receipt's outcome (same id) —
       the fallback the synthetic-receipt path reads when the list omits it */
    transaction_outcome: { id: first.receipt.receipt_id, outcome: first.outcome.outcome },
    receipts: kept.map((r) => r.receipt),
    receipts_outcome: kept.map((r) => r.outcome),
  };
};

/* The canonical payout transaction: execute_intents + the merchant
   payout (exactly what the live settlement tx contains). */
const payoutTx = (o = {}) => makeTx({ receipts: [execReceipt(), payReceipt(o)] });

const unknownTxError = (hash) => jsonResp(200, {
  jsonrpc: "2.0", id: "1",
  error: {
    name: "HANDLER_ERROR", code: -32000, message: "Server error",
    cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: hash } },
    data: `Transaction ${hash} doesn't exist`,
  },
});
const methodMissing = () => jsonResp(200, {
  jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found", name: "method_missing" },
});

/* ── request helpers ─────────────────────────────────────────────────── */

const bodies = [];
const entries = [];
const statusTexts = [];

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
  try { out = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, out, text };
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
const getStatus = (env, intentId, linkId = LINK_ID, extra = "", headers = {}) =>
  send("GET", `/status?id=${encodeURIComponent(intentId)}&linkId=${encodeURIComponent(linkId)}${extra}`, undefined, env, headers);

async function createIntent(env, over = {}) {
  const r = await postQuote(env, defaultBody(over));
  if (r.res.status !== 201) throw new Error(`POST /quote failed: ${r.res.status} ${r.text}`);
  return r.out.intent;
}

/* ── Durable Object harness (same as status.test.mjs) ───────────────── */

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
          inst.store.set(k, structuredClone(v));
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
    idFromName(name) {
      return { name };
    },
    get(id) {
      const name = id && id.name;
      if (typeof name !== "string") throw new Error("durable object id invalid");
      const inst = getInst(name);
      const obj = new PaymentIntent({ storage: inst.storage }, env);
      const run = (request) => {
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
    TIDEPOOL_TIMEOUT_MS: "100",       // stubbed upstreams resolve instantly; hang tests cost 100 ms
    TIDEPOOL_MAKER_KEY: TEST_MAKER,
    TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "60000",
    TIDEPOOL_VERIFY_BACKOFF_MS: "0",  // attempts are immediately eligible (backoff tested separately)
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
    /* contract (query) leg — Phase 4 failure modes */
    rpcMode: opts.rpcMode || "ok",
    /* tx_status leg: mode or a function (method, hash, state, init) */
    txMode: opts.txMode || "ok",
    txs: opts.txs || {},             // hash -> tx fixture; absent = UNKNOWN_TRANSACTION
    tokensMode: opts.tokensMode || "ok",
    quoteMode: opts.quoteMode || "ok",
    statusMode: opts.statusMode || "ok",
    statusBody: opts.statusBody || { status: "PENDING_DEPOSIT", updatedAt: "2026-11-11T12:00:00.000Z" },
    depositAddress: opts.depositAddress,
    signKeyPair: opts.signKeyPair || testKeys,
    calls: { rpc: [], tokens: [], health: [], quote: [], status: [], tx: [] },
  };

  const txLeg = (init, method) => {
    let body = null;
    try { body = JSON.parse(init.body); } catch { /* keep null */ }
    const params = body && body.params;
    const hash = method === "EXPERIMENTAL_tx_status"
      ? (Array.isArray(params) ? params[0] : null)
      : (params && typeof params === "object" ? params.tx_hash : null);
    state.calls.tx.push({ method, hash });
    const mode = state.txMode;
    if (typeof mode === "function") return mode(method, hash, state, init);
    if (mode === "hang") return hangResponse(init);
    if (mode === "http500") return jsonResp(500, { error: { message: "TX-DETAIL-MARKER " + "x".repeat(300) } });
    if (mode === "node_reject") {
      /* Live shape: HTTP 400 + JSON-RPC error body refusing our params. */
      return jsonResp(400, {
        jsonrpc: "2.0", id: "1",
        error: { name: "REQUEST_VALIDATION_ERROR", code: -32602, message: "invalid params",
          cause: { name: "PARSE_ERROR" } },
      });
    }
    if (mode === "badshape") return jsonResp(200, { jsonrpc: "2.0", id: "1", result: "not-an-object" });
    if (mode === "method_missing") return methodMissing();
    if (mode === "rpc_error") return jsonResp(200, { jsonrpc: "2.0", id: "1", error: { code: -32000, message: "Server error", data: "node exploded" } });
    const tx = state.txs[hash];
    if (!tx) return unknownTxError(hash);
    return jsonResp(200, { jsonrpc: "2.0", id: "1", result: tx });
  };

  const rpcLeg = (init) => {
    let body = null;
    try { body = JSON.parse(init.body); } catch { /* keep null */ }
    const method = body && body.method;
    if (method === "tx_status" || method === "EXPERIMENTAL_tx_status") return txLeg(init, method);
    if (state.rpcMode === "hang") return hangResponse(init);
    if (state.rpcMode === "http500") return jsonResp(500, { error: { message: "RPC-DETAIL-MARKER " + "x".repeat(300) } });
    if (state.rpcMode === "badshape") return jsonResp(200, { jsonrpc: "2.0", id: "1", result: { logs: [] } });
    return rpcEnvelope(state.link);
  };

  const tokensLeg = (init) => {
    if (state.tokensMode === "hang") return hangResponse(init);
    if (state.tokensMode === "http500") return jsonResp(500, { message: "UPSTREAM-DETAIL-MARKER " + "x".repeat(300) });
    if (state.tokensMode === "badshape") return jsonResp(200, { tokens: [] });
    return jsonResp(200, state.tokens);
  };

  const quoteLeg = (init) => {
    if (state.quoteMode === "hang") return hangResponse(init);
    return makeSignedQuote(state, init);
  };

  const statusLeg = (init) => {
    const mode = state.statusMode;
    if (typeof mode === "function") return mode(init, state);
    if (mode === "hang") return hangResponse(init);
    if (mode === "http500") return jsonResp(500, { message: "STATUS-DETAIL-MARKER " + "x".repeat(300) });
    return jsonResp(200, state.statusBody);
  };

  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(RPC)) {
      /* tx_status shares the RPC URL but is a different leg: count it
         under calls.tx only, so calls.rpc stays "contract reads". */
      let m = null;
      try { m = JSON.parse(init.body).method; } catch { /* keep null */ }
      if (m === "tx_status" || m === "EXPERIMENTAL_tx_status") return txLeg(init, m);
      state.calls.rpc.push({ url: u, init });
      return rpcLeg(init);
    }
    if (u.includes("/v0/tokens")) { state.calls.tokens.push({ url: u, init }); return tokensLeg(init); }
    if (u.includes("/v0/health")) { state.calls.health.push({ url: u, init }); return jsonResp(200, { ok: true }); }
    if (u.includes("/v0/quote")) { state.calls.quote.push({ url: u, init }); return quoteLeg(init); }
    if (u.includes("/v0/status")) { state.calls.status.push({ url: u, init }); return statusLeg(init); }
    return Promise.reject(new TypeError("unexpected upstream fetch: " + u));
  };
  return state;
}

/* ── record seeding ──────────────────────────────────────────────────── */

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
  invoiceAmount: AMOUNT,
  expectedInputAmount: "1009704",
  minInputAmount: "999707",
  expectedOutputAmount: AMOUNT,
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
  payoutHashes: null,
  payoutHashInvalid: 0,
  payoutHoldReason: null,
  verifyUntil: null,
  verifyAttempts: 0,
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
const logMark = () => logs.length;

/* ── flow helpers ────────────────────────────────────────────────────── */

/* create -> SUCCESS+swapDetails -> SETTLED with candidates captured.
   Returns after the landing cycle; caller advances before polling. */
async function settledFlow(opts = {}) {
  /* txs may arrive at the top level (most tests) or inside stub (a stub
     that also customises other legs) — stub wins on collision. */
  const state = stubNet({ txs: opts.txs, ...(opts.stub || {}) });
  const env = makeEnv(opts.env || {}, opts.doOpts || {});
  const intent = await createIntent(env);
  state.statusBody = successWith("swap" in opts ? opts.swap : swap());
  if (opts.beforeLand) opts.beforeLand(state, env);
  const land = await getStatus(env, intent.intentId);
  return { state, env, intent, land };
}

const txHashesCalled = (state) => state.calls.tx.map((c) => c.hash);

/* ═══════════════════════════════════════════════════════════════════ */

try {
  /* ── 1. state-machine guarantees + exports (units) ── */
  {
    ok(canTransition("SETTLED", "VERIFIED"), "SETTLED -> VERIFIED is legal (Phase 5's move)");
    ok(!canTransition("SETTLED", "FAILED") && !canTransition("SETTLED", "RECONCILE") &&
      !canTransition("SETTLED", "UNKNOWN") && !canTransition("SETTLED", "REFUNDED"),
      "SETTLED has no other exit");
    ok(!canTransition("UNKNOWN", "VERIFIED") && !canTransition("RECONCILE", "VERIFIED") &&
      !canTransition("AWAITING_DEPOSIT", "VERIFIED") && !canTransition("SETTLING", "VERIFIED"),
      "no state can jump straight to VERIFIED");
    ok(isTerminal("VERIFIED") && isTerminal("REFUNDED") && isTerminal("FAILED") && isTerminal("EXPIRED"),
      "terminal states stay terminal");
    ok(mapTidepoolStatus("SUCCESS").target === "SETTLED", "map unchanged: SUCCESS -> SETTLED (never VERIFIED)");

    ok(verifyBackoffMs({}) === 5000, "verify backoff default is 5000 ms");
    ok(verifyBackoffMs({ TIDEPOOL_VERIFY_BACKOFF_MS: "0" }) === 0, "0 allowed (retry every eligible poll)");
    ok(verifyBackoffMs({ TIDEPOOL_VERIFY_BACKOFF_MS: "1000" }) === 1000, "in-range backoff honoured");
    ok(verifyBackoffMs({ TIDEPOOL_VERIFY_BACKOFF_MS: "-5" }) === 5000, "negative falls back to default");
    ok(verifyBackoffMs({ TIDEPOOL_VERIFY_BACKOFF_MS: "999999999" }) === 5000, "above 1 h falls back to default");
    ok(verifyBackoffMs({ TIDEPOOL_VERIFY_BACKOFF_MS: "abc" }) === 5000, "non-numeric falls back to default");
  }

  /* ── 2. exact payout: the ONLY path to VERIFIED ── */
  {
    const { state, env, intent, land } = await settledFlow({ txs: { [H1]: payoutTx() } });
    ok(land.res.status === 200 && land.out.intent.status === "SETTLED" && land.out.changed === true,
      "landing cycle: SUCCESS -> SETTLED (changed), byte-identical to Phase 4");
    ok(state.calls.status.length === 1 && state.calls.rpc.length === 2 && state.calls.tx.length === 0,
      "landing cycle: one contract read + one status read, ZERO tx reads (verification is the NEXT cycle)");
    const rec0 = getRecord(env);
    ok(Array.isArray(rec0.intents[0].payoutHashes) && rec0.intents[0].payoutHashes.length === 1 &&
      rec0.intents[0].payoutHashes[0] === H1,
      "candidates captured server-side: both swapDetails lists dedupe to one hash");
    ok(rec0.intents[0].payoutHashInvalid === 0, "no malformed candidates");

    const mark = logMark();
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "VERIFIED" && r2.out.changed === true,
      "evidence + fresh contract -> SETTLED -> VERIFIED (changed)");
    ok(r2.out.conflict === null, "clean verification reports no conflict");
    ok(state.calls.tx.length === 1 && txHashesCalled(state)[0] === H1,
      "exactly one tx_status fetch of the captured hash");
    ok(state.calls.status.length === 1, "NO Tidepool re-read after SUCCESS (docs: stop on SUCCESS)");
    ok(state.calls.rpc.length === 3, "the fresh get_link ran immediately before the transition");
    ok(eventCount("payout_verify_ok", mark) === 1, "payout_verify_ok logged once");
    ok(eventCount("invoice_conflict", mark) === 0, "no conflict log on a clean verification");
    const okLog = logs.filter((e) => e.event === "payout_verify_ok").slice(-1)[0];
    ok(okLog && okLog.linkId === LINK_ID && okLog.intentId === intent.intentId && typeof okLog.attempts === "number",
      "payout_verify_ok carries ids and attempt count");
    const hist = getRecord(env).history.filter((h) => h.to === "VERIFIED");
    ok(hist.length === 1 && hist[0].from === "SETTLED" && hist[0].reason === "payout_verified",
      "history: exactly one SETTLED -> VERIFIED entry");

    const mark2 = logMark();
    advance(2000);
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.res.status === 200 && r3.out.intent.status === "VERIFIED" && r3.out.changed === false,
      "VERIFIED answers from the record");
    const frozen = { tx: state.calls.tx.length, rpc: state.calls.rpc.length, status: state.calls.status.length };
    advance(2000);
    await getStatus(env, intent.intentId);
    ok(state.calls.tx.length === frozen.tx && state.calls.rpc.length === frozen.rpc &&
      state.calls.status.length === frozen.status,
      "VERIFIED is terminal: zero further reads, ever");
    ok(eventCount("payout_verify_ok", mark2) === 0 && eventCount("payout_verify_ok") === 1,
      "payout_verify_ok never fires twice");
    ok(getRecord(env).intents[0].payoutHoldReason === null, "hold state cleared on success");
  }

  /* ── 3. wrong recipient / wrong amount / wrong token ── */
  {
    const wrongTo = await settledFlow({ txs: { [H1]: payoutTx({ to: "attacker.testnet", event: nep297("verifier.tidepool-sandbox.testnet", "attacker.testnet", AMOUNT) }) } });
    advance(2000);
    const r = await getStatus(wrongTo.env, wrongTo.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && r.out.changed === false, "wrong recipient: never VERIFIED");
    ok(getRecord(wrongTo.env).intents[0].payoutHoldReason === "evidence_mismatch",
      "wrong recipient: held as evidence_mismatch");
    ok(!r.text.includes("attacker"), "the wrong recipient is never echoed to the client");

    const wrongAmt = await settledFlow({ txs: { [H1]: payoutTx({ amount: "1", event: nep297("verifier.tidepool-sandbox.testnet", MERCHANT, "1") }) } });
    advance(2000);
    const r2 = await getStatus(wrongAmt.env, wrongAmt.intent.intentId);
    ok(r2.out.intent.status === "SETTLED" && r2.out.changed === false, "wrong amount: never VERIFIED");
    ok(getRecord(wrongAmt.env).intents[0].payoutHoldReason === "evidence_mismatch",
      "wrong amount: held as evidence_mismatch (BigInt inequality)");

    const wrongTok = await settledFlow({ txs: { [H1]: payoutTx({ token: "usdt.tidepool-sandbox.testnet" }) } });
    advance(2000);
    const r3 = await getStatus(wrongTok.env, wrongTok.intent.intentId);
    ok(r3.out.intent.status === "SETTLED" && r3.out.changed === false, "wrong token contract: never VERIFIED");
    ok(getRecord(wrongTok.env).intents[0].payoutHoldReason === "no_transfer_evidence",
      "a transfer on another token is no evidence for this invoice");
  }

  /* ── 4. failed receipt / missing transfer / unusable shape ── */
  {
    const failed = await settledFlow({ txs: { [H1]: payoutTx({ status: { Failure: null } }) } });
    advance(2000);
    const r = await getStatus(failed.env, failed.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && getRecord(failed.env).intents[0].payoutHoldReason === "transfer_failed",
      "a failed ft_transfer receipt: transfer_failed hold, never VERIFIED");

    const noPay = await settledFlow({ txs: { [H1]: makeTx({}) } });   // execute_intents only
    advance(2000);
    const r2 = await getStatus(noPay.env, noPay.intent.intentId);
    ok(r2.out.intent.status === "SETTLED" && getRecord(noPay.env).intents[0].payoutHoldReason === "no_transfer_evidence",
      "a successful tx without a payout receipt: no_transfer_evidence");

    const badShape = await settledFlow({ txs: { [H1]: { nope: true } } }); // result object, no receipts
    advance(2000);
    const r3 = await getStatus(badShape.env, badShape.intent.intentId);
    ok(r3.out.intent.status === "SETTLED" && getRecord(badShape.env).intents[0].payoutHoldReason === "evidence_malformed",
      "an unusable tx shape: evidence_malformed, fail closed");
  }

  /* ── 5. candidate capture: exclusions, hex skip, malformed counting ── */
  {
    /* only intentHashes + origin + hex -> no NEAR candidates -> zero-read hold */
    const none = await settledFlow({
      swap: { intentHashes: [H2], originChainTxHashes: [{ hash: "HbwEo318L69bJS7XYse18mUTzBBa2tjK6wtGeDYo3dY8" }], destinationChainTxHashes: [{ hash: HEX_HASH }] },
      txs: { [H1]: payoutTx() },
    });
    ok(none.land.out.intent.status === "SETTLED", "still settles on SUCCESS");
    const rec = getRecord(none.env);
    ok(!Array.isArray(rec.intents[0].payoutHashes) || rec.intents[0].payoutHashes.length === 0,
      "intentHashes / originChain / 0x-hex are never candidates");
    const m = logMark();
    advance(2000);
    const r = await getStatus(none.env, none.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && r.out.changed === false, "no candidates: stays SETTLED");
    ok(none.state.calls.tx.length === 0 && none.state.calls.rpc.length === 2 && none.state.calls.status.length === 1,
      "no candidates: ZERO reads on the verification cycle (hold, not guess)");
    ok(eventCount("payout_verify_hold", m) === 1 &&
      logs.filter((e) => e.event === "payout_verify_hold").slice(-1)[0].reason === "no_payout_hash",
      "hold logged once with reason no_payout_hash");
    advance(2000);
    await getStatus(none.env, none.intent.intentId);
    ok(eventCount("payout_verify_hold", m) === 1, "same reason never re-logged (no log spam)");

    /* hex skipped, NEAR kept */
    const hexed = await settledFlow({
      swap: { nearTxHashes: [HEX_HASH, H1], destinationChainTxHashes: [HEX_HASH, { hash: H1 }] },
      txs: { [H1]: payoutTx() },
    });
    advance(2000);
    const r2 = await getStatus(hexed.env, hexed.intent.intentId);
    ok(r2.out.intent.status === "VERIFIED", "0x-hex candidates are skipped; the NEAR hash still verifies");
    ok(getRecord(hexed.env).intents[0].payoutHashInvalid === 0, "skipped hex is not malformed");

    /* malformed candidates block BEFORE any read */
    const mixed = await settledFlow({
      swap: { nearTxHashes: [H1, BAD_HASH, SHORT_HASH] },
      txs: { [H1]: payoutTx() },
    });
    advance(2000);
    const r3 = await getStatus(mixed.env, mixed.intent.intentId);
    ok(r3.out.intent.status === "SETTLED" && getRecord(mixed.env).intents[0].payoutHoldReason === "evidence_malformed",
      "a NEAR-lookalike that fails validation blocks verification");
    ok(mixed.state.calls.tx.length === 0, "malformed candidates block BEFORE any node read");
    ok(getRecord(mixed.env).intents[0].payoutHashInvalid === 2, "both bad candidates counted");

    /* malformed-only candidates still route to the malformed hold */
    const onlyBad = await settledFlow({ swap: { nearTxHashes: [BAD_HASH] }, txs: { [H1]: payoutTx() } });
    advance(2000);
    const r4 = await getStatus(onlyBad.env, onlyBad.intent.intentId);
    ok(r4.out.intent.status === "SETTLED" && getRecord(onlyBad.env).intents[0].payoutHoldReason === "evidence_malformed" &&
      onlyBad.state.calls.tx.length === 0,
      "an only-malformed capture holds as evidence_malformed with zero reads");
  }

  /* ── 6. duplicate hashes, multiple candidates, double payout ── */
  {
    /* the same hash in both swapDetails lists -> ONE fetch */
    const dup = await settledFlow({ txs: { [H1]: payoutTx() } });
    ok(getRecord(dup.env).intents[0].payoutHashes.length === 1, "duplicate candidate deduped at capture");
    advance(2000);
    await getStatus(dup.env, dup.intent.intentId);
    ok(dup.state.calls.tx.length === 1, "one deduped hash -> one fetch");

    /* two DIFFERENT hashes, both paying the invoice -> double_payout */
    const dbl = await settledFlow({
      swap: { nearTxHashes: [H1, H2], destinationChainTxHashes: [{ hash: H1 }, { hash: H2 }] },
      txs: { [H1]: payoutTx(), [H2]: payoutTx({ id: "rcpay0002" }) },
    });
    const dm = logMark();
    advance(2000);
    const r = await getStatus(dbl.env, dbl.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && r.out.conflict === "double_payout",
      "two payouts of the invoice amount: double_payout conflict, never VERIFIED");
    ok(getRecord(dbl.env).conflict.kind === "double_payout", "conflict persisted on the record");
    const pcLog = logs.filter((e) => e.event === "payout_conflict").slice(-1)[0];
    ok(eventCount("payout_conflict", dm) === 1 && pcLog && pcLog.level === "error" &&
      pcLog.kind === "double_payout",
      "payout_conflict logged once at level error with its kind");
    const dm2 = logMark();
    const before = dbl.state.calls.tx.length;
    advance(2000);
    const r2 = await getStatus(dbl.env, dbl.intent.intentId);
    ok(r2.out.conflict === "double_payout" && dbl.state.calls.tx.length === before &&
      eventCount("payout_verify_hold", dm2) <= 1,
      "conflicted intent: subsequent cycles are a zero-read hold (never auto-verify)");

    /* one hash pays, the other is not yet visible -> pending, then verify */
    const pend = await settledFlow({
      swap: { nearTxHashes: [H1, H2], destinationChainTxHashes: [{ hash: H1 }, { hash: H2 }] },
      txs: { [H1]: payoutTx() },   // H2 absent -> UNKNOWN_TRANSACTION
    });
    advance(2000);
    const p1 = await getStatus(pend.env, pend.intent.intentId);
    ok(p1.out.intent.status === "SETTLED" && getRecord(pend.env).intents[0].payoutHoldReason === "evidence_pending",
      "an unseen candidate hash holds as evidence_pending (delayed visibility)");
    ok(pend.state.calls.tx.length === 2, "every candidate was asked about");
    /* The second hash resolves to a related settlement tx with no token
       transfer of its own (realistic: nearTxHashes carries more than the
       payout leg) — no second payout appears, so the retry verifies. */
    pend.state.txs[H2] = makeTx({});
    advance(2000);
    const p2 = await getStatus(pend.env, pend.intent.intentId);
    ok(p2.out.intent.status === "VERIFIED", "retry after visibility: VERIFIED once every candidate resolves");
  }

  /* ── 7. RPC failure modes + recovery + EXPERIMENTAL fallback ── */
  {
    const rpcFail = await settledFlow({ stub: { txMode: "http500" }, txs: { [H1]: payoutTx() } });
    advance(2000);
    const r = await getStatus(rpcFail.env, rpcFail.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && getRecord(rpcFail.env).intents[0].payoutHoldReason === "rpc_inconclusive",
      "node 5xx: rpc_inconclusive hold, never VERIFIED");
    rpcFail.state.txMode = "ok";
    advance(2000);
    const r2 = await getStatus(rpcFail.env, rpcFail.intent.intentId);
    ok(r2.out.intent.status === "VERIFIED", "recovery after the node recovers: VERIFIED");

    const bad = await settledFlow({ stub: { txMode: "badshape" }, txs: { [H1]: payoutTx() } });
    advance(2000);
    const b1 = await getStatus(bad.env, bad.intent.intentId);
    ok(b1.out.intent.status === "SETTLED" && getRecord(bad.env).intents[0].payoutHoldReason === "rpc_inconclusive",
      "unusable RPC result: rpc_inconclusive");
    bad.state.txMode = "ok";
    advance(2000);
    ok((await getStatus(bad.env, bad.intent.intentId)).out.intent.status === "VERIFIED", "recovers to VERIFIED");

    /* the node refuses our request outright (HTTP 400 + error body):
       malformed evidence, fail closed */
    const rej = await settledFlow({ stub: { txMode: "node_reject" }, txs: { [H1]: payoutTx() } });
    advance(2000);
    const j1 = await getStatus(rej.env, rej.intent.intentId);
    ok(j1.out.intent.status === "SETTLED" && getRecord(rej.env).intents[0].payoutHoldReason === "evidence_malformed",
      "node refusal of the tx request: evidence_malformed, never VERIFIED");
    rej.state.txMode = "ok";
    advance(2000);
    ok((await getStatus(rej.env, rej.intent.intentId)).out.intent.status === "VERIFIED",
      "recovers once the node accepts the request");

    const hung = await settledFlow({ env: { TIDEPOOL_TIMEOUT_MS: "50" }, stub: { txMode: "hang" }, txs: { [H1]: payoutTx() } });
    advance(2000);
    const h1 = await getStatus(hung.env, hung.intent.intentId);
    ok(h1.out.intent.status === "SETTLED" && getRecord(hung.env).intents[0].payoutHoldReason === "rpc_inconclusive",
      "hung node times out into rpc_inconclusive (bounded by TIDEPOOL_TIMEOUT_MS)");
    hung.state.txMode = "ok";
    advance(2000);
    ok((await getStatus(hung.env, hung.intent.intentId)).out.intent.status === "VERIFIED", "hung-node recovery: VERIFIED");

    /* method_missing on tx_status -> EXPERIMENTAL_tx_status fallback */
    const fb = await settledFlow({
      stub: {
        txs: { [H1]: payoutTx() },
        txMode: (method) => (method === "tx_status" ? methodMissing() : jsonResp(200, { jsonrpc: "2.0", id: "1", result: fb.state.txs[H1] })),
      },
    });
    advance(2000);
    const f = await getStatus(fb.env, fb.intent.intentId);
    ok(f.out.intent.status === "VERIFIED", "EXPERIMENTAL_tx_status fallback still verifies");
    ok(fb.state.calls.tx.length === 2 && fb.state.calls.tx[0].method === "tx_status" &&
      fb.state.calls.tx[1].method === "EXPERIMENTAL_tx_status",
      "fallback tried exactly the documented alternative spelling");
  }

  /* ── 8. args/event disagreement + reversal ── */
  {
    const disagree = await settledFlow({ txs: { [H1]: payoutTx({ event: nep297("verifier.tidepool-sandbox.testnet", "someone-else.testnet", AMOUNT) }) } });
    advance(2000);
    const r = await getStatus(disagree.env, disagree.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && getRecord(disagree.env).intents[0].payoutHoldReason === "evidence_malformed",
      "args and NEP-297 event disagreeing is malformed evidence, never VERIFIED");

    const rev = await settledFlow({ txs: { [H1]: payoutTx({ pred: MERCHANT, to: "vault.testnet", event: nep297(MERCHANT, "vault.testnet", AMOUNT) }) } });
    const rm = logMark();
    advance(2000);
    const r2 = await getStatus(rev.env, rev.intent.intentId);
    ok(r2.out.intent.status === "SETTLED" && r2.out.conflict === "payout_reversed",
      "a successful transfer FROM the merchant of the invoice amount: payout_reversed, never VERIFIED");
    ok(eventCount("payout_conflict", rm) === 1, "reversal logged as payout_conflict once");
    ok(getRecord(rev.env).conflict.kind === "payout_reversed", "reversal conflict persisted");

    /* tx-level Failure must not block a successful payout receipt */
    const txFail = await settledFlow({ txs: { [H1]: payoutTx({ txStatus: { Failure: "GasBurnt" } }) } });
    advance(2000);
    const r3 = await getStatus(txFail.env, txFail.intent.intentId);
    ok(r3.out.intent.status === "VERIFIED",
      "tx-level Failure with a successful payout receipt still verifies (no cross-receipt rollback)");

    /* nearcore's signer===receiver omission: the first receipt is
       synthesized from the transaction body and still scanned */
    const synth = await settledFlow({
      txs: {
        [H1]: makeTx({
          signer: DEST_TOKEN, receiver: DEST_TOKEN, omitFirst: true,
          txActions: [{ FunctionCall: { method_name: "ft_transfer", args: ftArgs(MERCHANT, AMOUNT), gas: "1", deposit: "1" } }],
          receipts: [payReceipt({ pred: DEST_TOKEN })],
        }),
      },
    });
    advance(2000);
    const r4 = await getStatus(synth.env, synth.intent.intentId);
    ok(r4.out.intent.status === "VERIFIED", "the omitted first receipt (signer===receiver) is synthesized and verified");
  }

  /* ── 9. the cross-provider race: invoice PAID before verification ── */
  {
    /* Phase 4 saw OPEN; between its last poll and our fresh read the
       NEAR rail settles the invoice. */
    const race = await settledFlow({
      txs: { [H1]: payoutTx() },
      beforeLand: (state) => { state.link = openLink(); },   // landing still sees OPEN
    });
    race.state.link = openLink({ status: "PAID", paid_by: "payer.testnet", paid_at: 1762800000001 });
    const mark = logMark();
    advance(2000);
    const r = await getStatus(race.env, race.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && r.out.conflict === "invoice_paid",
      "PAID discovered by the fresh read: hold with invoice_paid, never VERIFIED");
    ok(eventCount("invoice_conflict", mark) === 1, "invoice_conflict logged in the Phase 4 shape");
    const ic = logs.filter((e) => e.event === "invoice_conflict").slice(-1)[0];
    ok(ic && ic.level === "error" && ic.previous === "OPEN" && ic.onChainStatus === "PAID" &&
      ic.intentId === race.intent.intentId,
      "conflict log carries previous + new state + ids at level error");
    ok(getRecord(race.env).conflict.kind === "invoice_paid", "conflict persisted for manual reconciliation");
    const before = race.state.calls.tx.length + race.state.calls.rpc.length;
    race.state.link = openLink();     // even if the contract flips back: stored conflict stands
    advance(2000);
    const r2 = await getStatus(race.env, race.intent.intentId);
    ok(r2.out.conflict === "invoice_paid" &&
      race.state.calls.tx.length + race.state.calls.rpc.length === before,
      "a conflicted intent never re-verifies (zero-read hold, stored conflict is enough to block)");

    /* stored conflict from an earlier cycle: zero reads from the first poll */
    const stored = stubNet({ txs: { [H1]: payoutTx() } });
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "SETTLED", tidepoolStatus: "SUCCESS", payoutHashes: [H1],
    })], { conflict: { kind: "invoice_paid", onChainStatus: "PAID", detectedAt: clock } }));
    const sm = logMark();
    const rs = await getStatus(env, SEED_ID);
    ok(rs.res.status === 200 && rs.out.intent.status === "SETTLED" && rs.out.conflict === "invoice_paid",
      "stored conflict: answered from the record");
    ok(stored.calls.tx.length === 0 && stored.calls.rpc.length === 0 && stored.calls.status.length === 0,
      "stored conflict: ZERO reads (never trust that a stored conflict is stale enough to retry)");
    ok(eventCount("payout_verify_hold", sm) === 1 &&
      logs.filter((e) => e.event === "payout_verify_hold").slice(-1)[0].reason === "invoice_paid",
      "conflict hold logged once with the conflict kind");
  }

  /* ── 10. contract mismatch: stored facts vs fresh get_link ── */
  {
    const amt = await settledFlow({ txs: { [H1]: payoutTx() } });
    amt.state.link = openLink({ amount: "9999999" });   // contract disagrees with the stored invoice
    advance(2000);
    const r = await getStatus(amt.env, amt.intent.intentId);
    ok(r.out.intent.status === "SETTLED" && getRecord(amt.env).intents[0].payoutHoldReason === "invoice_mismatch",
      "amount mismatch vs the fresh contract: invoice_mismatch, never VERIFIED");

    const mer = await settledFlow({ txs: { [H1]: payoutTx() } });
    mer.state.link = openLink({ creator: "other-merchant.testnet" });
    advance(2000);
    const r2 = await getStatus(mer.env, mer.intent.intentId);
    ok(r2.out.intent.status === "SETTLED" && getRecord(mer.env).intents[0].payoutHoldReason === "invoice_mismatch",
      "merchant mismatch vs the fresh contract: invoice_mismatch, never VERIFIED");
  }

  /* ── 11. inconclusive contract read during verification ── */
  {
    const c = await settledFlow({ txs: { [H1]: payoutTx() } });
    c.state.rpcMode = "http500";                        // the fresh read fails
    const mark = logMark();
    advance(2000);
    const r = await getStatus(c.env, c.intent.intentId);
    ok(r.res.status === 200 && r.out.intent.status === "SETTLED" &&
      getRecord(c.env).intents[0].payoutHoldReason === "contract_inconclusive",
      "failed fresh contract read: fail closed as contract_inconclusive (status response survives)");
    ok(c.state.calls.tx.length === 1, "evidence was gathered before the contract gate");
    ok(eventCount("status_upstream_error", mark) === 0, "verification failures log as payout_verify_hold, not status noise");
    c.state.rpcMode = "ok";
    advance(2000);
    const r2 = await getStatus(c.env, c.intent.intentId);
    ok(r2.out.intent.status === "VERIFIED", "recovery after the contract read recovers: VERIFIED");
  }

  /* ── 12. duplicate / rapid verification requests are idempotent ── */
  {
    const d = await settledFlow({ txs: { [H1]: payoutTx() } });
    advance(2000);
    await getStatus(d.env, d.intent.intentId);          // the verification attempt
    const after = { tx: d.state.calls.tx.length, rpc: d.state.calls.rpc.length, status: d.state.calls.status.length };
    const r2 = await getStatus(d.env, d.intent.intentId); // immediately again, no advance
    ok(r2.res.status === 200 && r2.out.changed === false, "immediate repeat answers from the record");
    ok(d.state.calls.tx.length === after.tx && d.state.calls.rpc.length === after.rpc &&
      d.state.calls.status.length === after.status,
      "duplicate request performs ZERO additional reads (persisted poll stamp)");

    /* rapid polls during a HOLD are throttled too */
    const h = await settledFlow({ stub: { txMode: "http500" }, txs: { [H1]: payoutTx() } });
    advance(2000);
    await getStatus(h.env, h.intent.intentId);          // hold attempt #1
    const hb = { tx: h.state.calls.tx.length };
    await getStatus(h.env, h.intent.intentId);          // inside the floor: no attempt
    ok(h.state.calls.tx.length === hb.tx, "a second request inside the 2 s floor never re-attempts");
    ok(getRecord(h.env).intents[0].verifyAttempts === 1, "exactly one attempt recorded");
  }

  /* ── 13. backoff window (verifyUntil) ── */
  {
    const b = await settledFlow({
      env: { TIDEPOOL_VERIFY_BACKOFF_MS: "5000" },
      stub: { txMode: "http500" },
      txs: { [H1]: payoutTx() },
    });
    advance(2000);
    await getStatus(b.env, b.intent.intentId);          // attempt at T+2000, hold -> verifyUntil = T+7000
    ok(getRecord(b.env).intents[0].verifyAttempts === 1 &&
      typeof getRecord(b.env).intents[0].verifyUntil === "number",
      "a hold persists its backoff clock and attempt count");
    advance(2000);                                       // poll at T+4000: floor passed, window open
    const r = await getStatus(b.env, b.intent.intentId);
    ok(r.res.status === 200 && r.out.intent.status === "SETTLED" && b.state.calls.tx.length === 1,
      "inside the backoff window: zero reads (the record is the answer)");
    b.state.txMode = "ok";
    advance(4000);                                       // poll at T+8000: window elapsed
    const r2 = await getStatus(b.env, b.intent.intentId);
    ok(r2.out.intent.status === "VERIFIED" && b.state.calls.tx.length === 2,
      "after the window the next attempt runs and verifies");
  }

  /* ── 14. hold reasons: logged once per distinct reason ── */
  {
    const h = await settledFlow({ stub: { txMode: "http500" }, txs: { [H1]: payoutTx() } });
    const mark = logMark();
    advance(2000);
    await getStatus(h.env, h.intent.intentId);          // rpc_inconclusive
    advance(2000);
    await getStatus(h.env, h.intent.intentId);          // rpc_inconclusive again
    ok(eventCount("payout_verify_hold", mark) === 1, "same reason logged once across attempts");
    h.state.txMode = "ok";
    h.state.txs[H1] = payoutTx({ to: "attacker.testnet", event: nep297("verifier.tidepool-sandbox.testnet", "attacker.testnet", AMOUNT) });
    advance(2000);
    await getStatus(h.env, h.intent.intentId);          // now evidence_mismatch
    const reasons = logs.slice(mark).filter((e) => e.event === "payout_verify_hold").map((e) => e.reason);
    ok(reasons.length === 2 && new Set(reasons).size === 2,
      `a NEW distinct reason logs exactly once more (reason codes only) — got ${JSON.stringify(reasons)}`);
  }

  /* ── 15. client input is never evidence ── */
  {
    const s = await settledFlow({ txs: { [H1]: payoutTx() } });
    advance(2000);
    const r = await getStatus(s.env, s.intent.intentId, LINK_ID,
      `&txHash=${H2}&merchant=evil.testnet&amount=1&payoutClaim=verified`);
    ok(r.out.intent.status === "VERIFIED",
      "browser-supplied txHash/merchant/amount/claim params are ignored");
    ok(txHashesCalled(s.state).every((h) => h === H1),
      "only the server-captured candidate was ever fetched");
    ok(!r.text.includes("evil") && !r.text.includes(H2), "supplied values are never echoed");
  }

  /* ── 16. no VERIFIED without complete evidence (matrix sweep) ── */
  {
    const matrix = [
      ["wrong recipient", { txs: { [H1]: payoutTx({ to: "attacker.testnet", event: nep297("verifier.tidepool-sandbox.testnet", "attacker.testnet", AMOUNT) }) } }],
      ["wrong amount", { txs: { [H1]: payoutTx({ amount: "7", event: nep297("verifier.tidepool-sandbox.testnet", MERCHANT, "7") }) } }],
      ["wrong token", { txs: { [H1]: payoutTx({ token: "usdt.tidepool-sandbox.testnet" }) } }],
      ["failed receipt", { txs: { [H1]: payoutTx({ status: { Failure: null } }) } }],
      ["missing transfer", { txs: { [H1]: makeTx({}) } }],
      ["unusable shape", { txs: { [H1]: { bad: 1 } } }],
      ["no candidate visible", { txs: {} }],
      ["node 5xx", { stub: { txMode: "http500" }, txs: { [H1]: payoutTx() } }],
      ["node hang", { env: { TIDEPOOL_TIMEOUT_MS: "50" }, stub: { txMode: "hang" }, txs: { [H1]: payoutTx() } }],
      ["malformed candidate", { swap: { nearTxHashes: [BAD_HASH] }, txs: { [H1]: payoutTx() } }],
      ["invoice PAID", { txs: { [H1]: payoutTx() }, beforeLand: () => {}, postLand: (state) => { state.link = openLink({ status: "PAID" }); } }],
      ["invoice amount moved", { txs: { [H1]: payoutTx() }, postLand: (state) => { state.link = openLink({ amount: "42" }); } }],
    ];
    const okMark = logMark();
    let held = 0;
    for (const [label, cfg] of matrix) {
      const f = await settledFlow(cfg);
      if (cfg.postLand) cfg.postLand(f.state);
      advance(2000);
      const r = await getStatus(f.env, f.intent.intentId);
      const st = r.out && r.out.intent && r.out.intent.status;
      if (st !== "VERIFIED") held++;
      ok(st === "SETTLED" && r.out.changed === false, `matrix/${label}: holds at SETTLED, never VERIFIED`);
      if (st !== "VERIFIED") ok(getRecord(f.env).intents[0].payoutHoldReason !== null,
        `matrix/${label}: a hold reason is recorded`);
    }
    ok(held === matrix.length, `all ${matrix.length} incomplete-evidence scenarios held`);
    ok(eventCount("payout_verify_ok", okMark) === 0, "payout_verify_ok never fired in the matrix");
  }

  /* ── 17. reconcile landing SETTLED captures candidates; no direct UNKNOWN -> VERIFIED ── */
  {
    /* an uncertain intent reconciles INTO SETTLED with the evidence attached */
    const state = stubNet({ txs: { [H1]: payoutTx() } });
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "RECONCILE", reconcileUntil: null, lastError: "http_status",
      tidepoolStatus: "PROCESSING",
    })]));
    state.statusBody = successWith(swap());
    const rq = await postQuote(env);
    ok(rq.res.status === 409 && rq.out.code === "payment_settled",
      "reconcile into SETTLED still answers payment_settled (Phase 3 contract)");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "SETTLED" &&
      Array.isArray(rec.intents[0].payoutHashes) && rec.intents[0].payoutHashes[0] === H1,
      "the reconcile read captured the candidates for the next verification cycle");
    const rv = await getStatus(env, SEED_ID);
    ok(rv.out.intent.status === "VERIFIED", "the next poll verifies the reconciled settlement");
    ok(state.calls.tx.length === 1, "exactly one evidence fetch");

    /* UNKNOWN resolves to SETTLED first — never straight to VERIFIED */
    const st2 = stubNet({ txs: { [H1]: payoutTx() } });
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "UNKNOWN", reconcileUntil: null, lastError: "unmapped_status", payoutHashes: [H1],
    })]));
    st2.statusBody = successWith(swap());
    const u1 = await getStatus(env2, SEED_ID);
    ok(u1.out.intent.status === "SETTLED" && u1.out.changed === true,
      "UNKNOWN resolves to SETTLED first (no direct UNKNOWN -> VERIFIED)");
    advance(2000);
    const u2 = await getStatus(env2, SEED_ID);
    ok(u2.out.intent.status === "VERIFIED", "then the verified path proceeds normally");
  }

  /* ── 18. watch limit applies to verification too ── */
  {
    const state = stubNet({ txs: { [H1]: payoutTx() } });
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "SETTLED", tidepoolStatus: "SUCCESS", payoutHashes: [H1],
      quoteDeadlineMs: clock - 86_400_000 - 1,
    })]));
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 200 && r.out.intent.status === "SETTLED" && r.out.changed === false,
      "past the 24 h watch window: answered from the record");
    ok(state.calls.tx.length === 0 && state.calls.rpc.length === 0 && state.calls.status.length === 0,
      "watch limit: verification performs ZERO reads after Tidepool's own watcher stops");
  }

  /* ── 19. Phase 2–4 preservation around the new path ── */
  {
    /* the landing cycle is count-identical to a Phase 4 SUCCESS cycle */
    const p = await settledFlow({ txs: { [H1]: payoutTx() } });
    ok(p.state.calls.status.length === 1 && p.state.calls.rpc.length === 2 && p.state.calls.quote.length === 1 &&
      p.state.calls.tokens.length === 1,
      "create + landing cycle: upstream call counts unchanged from Phase 4");

    /* POST /quote during SETTLED still refuses (no second address) */
    const q = await postQuote(p.env);
    ok(q.res.status === 409 && q.out.code === "payment_settled",
      "SETTLED still blocks a second quote (Phase 3 guard intact)");

    /* SETTLED without candidates keeps the Phase 4 zero-read contract */
    const state = stubNet({ statusMode: "http500" });   // hostile upstream, never reached
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "SETTLED", tidepoolStatus: "SUCCESS" })]));
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 200 && r.out.intent.status === "SETTLED" && r.out.changed === false,
      "candidate-less SETTLED answered from the record (Phase 4 §10 semantics)");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
      "candidate-less SETTLED: ZERO upstream reads (hostup upstream never reached)");
    const other = ["VERIFIED", "REFUNDED", "FAILED", "EXPIRED"];
    for (const st of other) {
      const s2 = stubNet({ statusMode: "http500" });
      const e2 = makeEnv();
      e2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: st, tidepoolStatus: "SUCCESS" })]));
      const rr = await getStatus(e2, SEED_ID);
      ok(rr.res.status === 200 && rr.out.intent.status === st &&
        s2.calls.status.length === 0 && s2.calls.rpc.length === 0 && s2.calls.tx.length === 0,
        `${st}: still zero reads`);
    }
  }

  /* ── 20. sweeps: sensitive data never leaves the endpoint or the logs ── */
  {
    const allStatus = statusTexts.join("\n");
    ok(statusTexts.length >= 40, `sweep ran over a meaningful sample (${statusTexts.length} /status responses)`);
    for (const h of [H1, H2, H3]) {
      ok(!allStatus.includes(h), `no tx hash in any /status body (${h.slice(0, 6)}…)`);
      ok(!logs.some((e) => JSON.stringify(e).includes(h)), `no tx hash in any log line (${h.slice(0, 6)}…)`);
    }
    ok(!allStatus.includes("swapDetails") && !allStatus.includes("TxHash") && !allStatus.includes("txHash"),
      "swapDetails / tx hash field names never leave the endpoint");
    ok(!ADDR_RE.test(allStatus), "no deposit address in any /status body");
    ok(!ADDR_RE.test(logs.map((e) => JSON.stringify(e)).join("\n")), "no deposit address in any log line");
    ok(!allStatus.includes("not-a-valid-hash") && !allStatus.includes(SHORT_HASH),
      "malformed candidate strings are never echoed");
    ok(!allStatus.includes("attacker") && !allStatus.includes("evil"),
      "hostile fixture values never reach a client");

    const allLogs = logs.map((e) => JSON.stringify(e)).join("\n");
    ok(!allLogs.includes("TX-DETAIL-MARKER") && !allLogs.includes("RPC-DETAIL-MARKER") &&
      !allLogs.includes("STATUS-DETAIL-MARKER") && !allLogs.includes("UPSTREAM-DETAIL-MARKER"),
      "upstream detail markers never reach the logs");
    ok(!allLogs.includes("ed25519:"), "no signature material in the logs");
    const verifyLogs = logs.filter((e) =>
      e.event === "payout_verify_hold" || e.event === "payout_conflict" || e.event === "payout_verify_ok");
    ok(verifyLogs.length > 0, `verification logging exercised (${verifyLogs.length} lines)`);
    ok(!/[1-9A-HJ-NP-Za-km-z]{40,}/.test(verifyLogs.map((e) => JSON.stringify(e)).join("\n")),
      "verification logs carry reason codes only — no base58 hash-shaped data");
    ok(verifyLogs.every((e) => e.svc && e.event && e.build && e.ts),
      "every verification log line carries the M-01 envelope");
    ok(logs.filter((e) => e.event === "payout_verify_hold").every((e) => e.level === "warn" && e.reason),
      "payout_verify_hold: level warn + machine reason on every line");
    ok(logs.filter((e) => e.event === "payout_conflict").every((e) => e.level === "error" && e.kind),
      "payout_conflict: level error + conflict kind on every line");
    ok(logs.filter((e) => e.event === "invoice_conflict").every((e) => e.level === "error"),
      "the Phase 4 invoice_conflict shape is preserved");
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
