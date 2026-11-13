/* Phase 6 tests: payment records and reconciliation hardening.
 *
 * Proves that every payment intent keeps a consistent, durable,
 * traceable history and that unresolved payments can be investigated
 * without accidental verification, duplication or loss of records:
 *
 *   - record integrity: type/shape validation before anything is served
 *     or acted on; immutable invoice facts (client-supplied values are
 *     never believed); audit history preserved (cap 256, oldest dropped);
 *     active-intent pointer never read as "nothing is going on";
 *   - durable storage / recovery: persist-before-complete (a detected
 *     conflict survives an interrupted cycle), interrupted verification
 *     and interrupted polling recover without duplicate transitions,
 *     repeated recovery is idempotent, recovery works after Durable
 *     Object reactivation, recovery never assumes upstream success;
 *   - reconciliation: the seven Tidepool statuses observed idempotently,
 *     upstream Retry-After honoured on the reconcile path, invoice PAID
 *     detected mid-reconciliation, quote-expiry semantics preserved,
 *     held SETTLED keeps a bounded contract-only watch (invoice_paid
 *     still detectable after polling stops) and can never become
 *     VERIFIED without the complete Phase 5 evidence;
 *   - conflicts: invoice_paid / double_payout recorded, preserved,
 *     never auto-cleared, never re-logged, surviving reactivation;
 *     a malformed conflict still blocks verification; a missing conflict
 *     record is never treated as proof of no conflict;
 *   - security: no internal reconciliation evidence (hashes, hold
 *     reasons, verify bookkeeping, stamps, history, signatures) in any
 *     public body or log line; no VERIFIED path without evidence.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts
 * Tidepool or a NEAR node. INTENT_DO is the Phase 5 harness plus two
 * Phase 6 hooks: a mutable putGate (to interrupt a SPECIFIC write) and
 * a shared instances map (to simulate Durable Object reactivation).
 * Date.now is pinned for deterministic throttle, backoff and deadline
 * arithmetic.
 */

import worker, {
  PaymentIntent,
  clearDiscoveryCache,
  intentRecordProblem,
  recordLevelProblem,
  pushHistory,
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
    omitFirst = false,
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
    transaction_outcome: { id: first.receipt.receipt_id, outcome: first.outcome.outcome },
    receipts: kept.map((r) => r.receipt),
    receipts_outcome: kept.map((r) => r.outcome),
  };
};

const payoutTx = (o = {}) => makeTx({ receipts: [execReceipt(), payReceipt(o)] });

/* ── request helpers ─────────────────────────────────────────────────── */

const bodies = [];
const entries = [];
const statusTexts = [];
/* Responses from flows where VERIFIED must never appear (no full
   Phase 5 evidence) — swept at the end. */
const noVerifyTexts = [];

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

/* ── Durable Object harness (Phase 5 + Phase 6 hooks) ──────────────────
   putGate: { fail(rec, putCount) } — a MUTABLE predicate, cleared by
   assigning gate.fail = null, to interrupt exactly one write.
   opts.instances: a shared instance map — a second env built on it is a
   reactivation of the SAME Durable Object. */

function makeIntentDO(env, opts = {}) {
  const instances = opts.instances || new Map();
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
          const gate = opts.putGate;
          if (gate && typeof gate.fail === "function" && gate.fail(structuredClone(v), putCount)) {
            throw new Error("kv write down");
          }
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
    TIDEPOOL_TIMEOUT_MS: "100",
    TIDEPOOL_MAKER_KEY: TEST_MAKER,
    TIDEPOOL_AMBIGUOUS_COOLDOWN_MS: "60000",
    TIDEPOOL_VERIFY_BACKOFF_MS: "0",
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
    txMode: opts.txMode || "ok",
    txs: opts.txs || {},
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
    const tx = state.txs[hash];
    if (!tx) {
      /* UNKNOWN_TRANSACTION: the delayed-visibility shape (retryable). */
      return jsonResp(200, {
        jsonrpc: "2.0", id: "1",
        error: {
          name: "HANDLER_ERROR", code: -32000, message: "Server error",
          cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: hash } },
          data: `Transaction ${hash} doesn't exist`,
        },
      });
    }
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
/* Index into the log stream — captures must use this, not a count:
   slice() takes an index, and counts only coincide with indexes when
   every prior line happens to be the same event. */
const logMark = () => logs.length;

/* ── flow helpers ────────────────────────────────────────────────────── */

/* create -> SUCCESS+swapDetails -> SETTLED with candidates captured.
   Returns after the landing cycle; caller advances before polling. */
async function settledFlow(opts = {}) {
  const state = stubNet({ txs: opts.txs, ...(opts.stub || {}) });
  const env = makeEnv(opts.env || {}, opts.doOpts || {});
  const intent = await createIntent(env);
  state.statusBody = successWith("swap" in opts ? opts.swap : swap());
  if (opts.beforeLand) opts.beforeLand(state, env);
  const land = await getStatus(env, intent.intentId);
  return { state, env, intent, land };
}

/* ═══════════════════════════════════════════════════════════════════ */

try {
  /* ── 1. units: record validation + history cap ── */
  {
    const good = seedIntent();
    ok(intentRecordProblem(good) === null, "a well-formed intent passes validation");
    ok(intentRecordProblem({ intentId: "pi_0123456789abcdef", linkId: LINK_ID, status: "VERIFIED" }) === null,
      "a minimal intent (absent optional fields) passes — Phases 2–5 fixtures stay valid");
    ok(intentRecordProblem({ ...good, status: "ZOMBIE" }) === "status_invalid",
      "status outside the state machine -> status_invalid");
    ok(intentRecordProblem({ ...good, status: 42 }) === "status_invalid", "non-string status -> status_invalid");
    ok(intentRecordProblem({ ...good, depositAddress: 123 }) === "deposit_address_invalid",
      "non-string deposit address -> deposit_address_invalid");
    ok(intentRecordProblem({ ...good, depositAddress: "a".repeat(257) }) === "deposit_address_invalid",
      "oversized deposit address -> deposit_address_invalid");
    ok(intentRecordProblem({ ...good, depositMemo: { v: 1 } }) === "deposit_memo_invalid",
      "object deposit memo -> deposit_memo_invalid");
    ok(intentRecordProblem({ ...good, quoteDeadlineMs: "soon" }) === "quote_deadline_invalid",
      "non-numeric deadline -> quote_deadline_invalid");
    ok(intentRecordProblem({ ...good, invoiceAmount: "1e6" }) === "amount_invalid",
      "non-canonical amount -> amount_invalid (BigInt safety)");
    ok(intentRecordProblem({ ...good, invoiceAmount: "007" }) === "amount_invalid",
      "leading-zero amount -> amount_invalid (canonical integers only)");
    ok(intentRecordProblem({ ...good, source: "near" }) === "meta_invalid",
      "non-object source -> meta_invalid");
    ok(intentRecordProblem({ ...good, correlationId: { evil: true } }) === "correlation_invalid",
      "object correlationId -> correlation_invalid");
    ok(intentRecordProblem({ ...good, lastReason: { x: 1 } }) === "reason_invalid",
      "object lastReason -> reason_invalid");
    ok(intentRecordProblem(null) === "intent_invalid", "null intent -> intent_invalid");

    ok(recordLevelProblem({ history: "oops" }) === "history_invalid",
      "non-array history -> history_invalid");
    ok(recordLevelProblem({ conflict: { kind: 123 } }) === "conflict_invalid",
      "non-string conflict kind -> conflict_invalid");
    ok(recordLevelProblem({ conflict: { kind: "invoice_paid", detectedAt: clock }, history: [] }) === null,
      "a well-formed conflict + history pass");
    ok(recordLevelProblem({ history: [], conflict: null }) === null, "a clean record passes");

    const rec = { history: [] };
    for (let i = 0; i < 300; i++) pushHistory(rec, "pi_x", "A", "B", `r${i}`, FIXED + i);
    ok(rec.history.length === 256, "audit history cap is 256 (Phase 6: a full lifecycle fits)");
    ok(rec.history[0].reason === "r44" && rec.history[255].reason === "r299",
      "oldest entries are dropped, the newest are kept");
  }

  /* ── 2. quarantine: an unreadable persisted status ── */
  {
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "ZOMBIE" })]));
    const mark = logMark();
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 503 && r.out.code === "record_invalid" && Number.isFinite(r.out.retryAfterSec) && r.out.retryAfterSec >= 1,
      "unreadable status -> 503 record_invalid + Retry-After");
    ok(r.res.headers.get("retry-after") !== null, "503 carries a Retry-After header");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "RECONCILE", "force-quarantined into RECONCILE (the honest state)");
    ok(rec.intents[0].lastReason === "record_malformed", "quarantine reason recorded on the intent");
    ok(typeof rec.intents[0].reconcileUntil === "number" && rec.intents[0].reconcileUntil === clock + 60_000,
      "cooldown persisted WITH the quarantine");
    ok(Array.isArray(rec.history) && rec.history.some((h) =>
      h.from === "ZOMBIE" && h.to === "RECONCILE" && h.reason === "record_malformed"),
      "history preserves what happened (from the raw value to RECONCILE)");
    ok(rec.invalid && rec.invalid.reason === "status_invalid", "record.invalid stamp persisted");
    ok(eventCount("intent_transition", mark) === 1 &&
      logs.slice(mark).some((e) => e.event === "intent_transition" && e.reason === "record_malformed"),
      "intent_transition logged once with reason record_malformed");
    ok(eventCount("record_invalid", mark) === 1 &&
      logs.slice(mark).some((e) => e.event === "record_invalid" && e.reason === "status_invalid" && e.level === "alert"),
      "record_invalid logged once at level alert with the specific reason");
    ok(!r.text.includes("depositAddress") && !r.text.includes("signature"),
      "the 503 body carries no record fields");

    /* Immediate retry: cooldown answers, no re-log, zero upstream reads. */
    const mark2 = logMark();
    const r2 = await getStatus(env, SEED_ID);
    ok(r2.res.status === 503 && r2.out.code === "reconcile_cooldown",
      "retry inside the cooldown -> reconcile_cooldown (quarantine is not hammered)");
    ok(eventCount("record_invalid", mark2) === 0, "repeat finding: no second record_invalid log");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0, "zero upstream reads while quarantined+cooling");

    /* Recovery: upstream truth resolves RECONCILE — never a guess, and
       the integrity stamp is preserved (never silently repaired away). */
    advance(60_001);
    const r3 = await getStatus(env, SEED_ID);
    ok(r3.res.status === 200 && r3.out.intent.status === "AWAITING_DEPOSIT" && r3.out.changed === true,
      "after the cooldown the reconcile resolves honestly against upstream (PENDING -> AWAITING_DEPOSIT)");
    ok(state.calls.status.length === 1 && state.calls.rpc.length === 1, "recovery reads exactly once per leg");
    ok(getRecord(env).invalid && getRecord(env).invalid.reason === "status_invalid",
      "the integrity stamp survives the recovery (forensic record kept)");
    ok(!r3.text.includes('"status":"VERIFIED"'), "recovery never produced VERIFIED");
    noVerifyTexts.push(r.text, r2.text, r3.text);

    /* Quarantine also guards POST /quote (active intent validated first). */
    const stateQ = stubNet();
    const envQ = makeEnv();
    envQ.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "ZOMBIE" })]));
    const q = await postQuote(envQ);
    ok(q.res.status === 503 && q.out.code === "record_invalid",
      "POST /quote quarantines an unreadable active status too (never a reuse 200)");
    ok(stateQ.calls.quote.length === 0, "no upstream quote was requested over an unreadable record");
    advance(60_001);
    const q2 = await postQuote(envQ);
    ok(q2.res.status === 200 && q2.out.reused === true && q2.out.intent.status === "AWAITING_DEPOSIT",
      "…and after the cooldown it reconciles to the same intent (no duplicate address)");
    ok(stateQ.calls.quote.length === 0 && stateQ.calls.status.length === 1, "reconciliation, not creation");
    noVerifyTexts.push(q.text, q2.text);
  }

  /* ── 2b. alert webhook: a dead delivery can NEVER affect payment state ── */
  {
    const HOOK = "https://hooks.alert.example.test/services/DEAD-DESTINATION";
    const state = stubNet();
    const env = makeEnv({ ALERT_WEBHOOK_URL: HOOK });
    const baseFetch = globalThis.fetch;
    const hookCalls = [];
    let persistedWhenFired = null;
    globalThis.fetch = (url, init = {}) => {
      const u = String(url);
      if (u !== HOOK) return baseFetch(url, init);
      /* OBSERVE the store at delivery time: the quarantine must already
         be on disk before the webhook is awaited (persist-before-notify).
         Reversed order would see the record still unreadable (ZOMBIE). */
      const rec = getRecord(env);
      persistedWhenFired = !!(rec && rec.invalid && rec.invalid.reason === "status_invalid" &&
        rec.intents[0] && rec.intents[0].status === "RECONCILE");
      hookCalls.push({ url: u, init });
      return Promise.reject(new TypeError("webhook unreachable"));
    };
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "ZOMBIE" })]));
    const mark = logMark();
    const r = await getStatus(env, SEED_ID);
    ok(persistedWhenFired === true,
      "quarantine + integrity stamp are ALREADY persisted when the delivery fires (persist-before-notify)");
    ok(hookCalls.length === 1, "exactly one delivery attempt for the alert");
    ok(r.res.status === 503 && r.out.code === "record_invalid" && Number.isFinite(r.out.retryAfterSec),
      "a dead webhook cannot change the response: 503 record_invalid + Retry-After, as without one");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "RECONCILE" && rec.intents[0].lastReason === "record_malformed" &&
      rec.invalid && rec.invalid.reason === "status_invalid",
      "quarantine + integrity stamp persisted exactly as in the no-webhook run");
    ok(typeof rec.intents[0].reconcileUntil === "number", "the cooldown persisted with the quarantine too");
    ok(eventCount("record_invalid", mark) === 1 &&
      logs.slice(mark).some((e) => e.event === "record_invalid" && e.level === "alert" && e.reason === "status_invalid"),
      "the alert line is still emitted at level alert when delivery fails");
    const sent = JSON.parse(hookCalls[0].init.body);
    ok(sent.event === "record_invalid" && sent.level === "alert" && sent.svc === "paylink-tidepool" &&
      sent.reason === "status_invalid",
      "the payload is the scrubbed alert record (machine reason only)");
    ok(!hookCalls[0].init.body.includes("depositAddress") &&
      !hookCalls[0].init.body.includes("signature") && !hookCalls[0].init.body.includes(SEED_SIG),
      "no record fields beyond the log line reach the webhook");
    ok(!logs.slice(mark).some((e) => JSON.stringify(e).includes(HOOK)),
      "the webhook URL is never logged");

    /* Repeat behaviour is identical to the no-webhook run (section 2). */
    const mark2 = logMark();
    const r2 = await getStatus(env, SEED_ID);
    ok(r2.res.status === 503 && r2.out.code === "reconcile_cooldown" &&
      eventCount("record_invalid", mark2) === 0 && hookCalls.length === 1,
      "repeat: identical cooldown answer, no re-log, no second delivery attempt");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0,
      "zero upstream reads while quarantined — the dead delivery changed nothing");
    noVerifyTexts.push(r.text, r2.text);
    globalThis.fetch = baseFetch;
  }

  /* ── 3. corrupt field: hold in place, never served, never repaired ── */
  {
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ depositAddress: 123 })]));
    const mark = logMark();
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 503 && r.out.code === "record_invalid", "corrupt deposit address -> 503 record_invalid");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "AWAITING_DEPOSIT" && rec.intents[0].depositAddress === 123,
      "state and the corrupt field are HELD in place (no silent repair, no transition)");
    ok(rec.invalid && rec.invalid.reason === "deposit_address_invalid", "stamp records the specific problem");
    ok(eventCount("record_invalid", mark) === 1, "logged once");
    ok(state.calls.status.length === 0 && state.calls.rpc.length === 0, "no upstream call is made with a corrupt address");
    noVerifyTexts.push(r.text);

    /* Repeats are idempotent: same answer, no re-log, stamp unchanged. */
    const mark2 = logMark();
    const at = rec.invalid.at;
    const r2 = await getStatus(env, SEED_ID);
    ok(r2.res.status === 503 && r2.out.code === "record_invalid" &&
      eventCount("record_invalid", mark2) === 0 && getRecord(env).invalid.at === at,
      "repeat: identical 503, no second log, no re-write");

    /* POST /quote refuses the same record instead of reusing it. */
    const q = await postQuote(env);
    ok(q.res.status === 503 && q.out.code === "record_invalid" && !q.text.includes("depositAddress"),
      "POST /quote holds too — never serves the corrupt instructions as a reuse");
    noVerifyTexts.push(r2.text, q.text);

    /* Reactivation: a new DO instance on the same storage holds the same. */
    const env2 = makeEnv({}, { instances: env.INTENT_DO.instances });
    const r3 = await getStatus(env2, SEED_ID);
    ok(r3.res.status === 503 && r3.out.code === "record_invalid",
      "recovery after DO reactivation re-validates: still held, never served");
    noVerifyTexts.push(r3.text);

    /* Other field types are held the same way. */
    const envD = makeEnv();
    envD.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ quoteDeadlineMs: "soon" })]));
    const rd = await getStatus(envD, SEED_ID);
    ok(rd.res.status === 503 && rd.out.code === "record_invalid" &&
      getRecord(envD).invalid.reason === "quote_deadline_invalid",
      "corrupt quote deadline -> hold with quote_deadline_invalid");
    const envA = makeEnv();
    envA.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ invoiceAmount: "1e6" })]));
    const ra = await getStatus(envA, SEED_ID);
    ok(ra.res.status === 503 && ra.out.code === "record_invalid" &&
      getRecord(envA).invalid.reason === "amount_invalid",
      "corrupt amount -> hold with amount_invalid (integer arithmetic protected)");
    noVerifyTexts.push(rd.text, ra.text);
  }

  /* ── 4. record-level corruption: stamped, non-blocking, still safe ── */
  {
    /* history: audit-only — serving and transitions continue, finding logged. */
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { history: "oops" }));
    const mark = logMark();
    state.statusBody = { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" };
    const r = await getStatus(env, SEED_ID);
    ok(r.res.status === 200 && r.out.intent.status === "DEPOSIT_SEEN" && r.out.changed === true,
      "corrupt history does not block the state machine (audit is not authorization)");
    const rec = getRecord(env);
    ok(Array.isArray(rec.history) && rec.history.some((h) => h.to === "DEPOSIT_SEEN"),
      "history is rebuilt around the new entry (finding already stamped)");
    ok(rec.invalid && rec.invalid.reason === "history_invalid", "the finding is stamped and kept");
    ok(eventCount("record_invalid", mark) === 1, "history_invalid logged once");
    noVerifyTexts.push(r.text);

    /* conflict: malformed still BLOCKS verification (fail closed), and the
       finding is stamped — an unreadable conflict is never "no conflict". */
    const st2 = stubNet({ txs: { [H1]: payoutTx() } });
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "SETTLED", tidepoolStatus: "SUCCESS", payoutHashes: [H1],
    })], { conflict: { kind: 123 } }));
    const mark2 = logMark();
    const r2 = await getStatus(env2, SEED_ID);
    ok(r2.res.status === 200 && r2.out.intent.status === "SETTLED" && r2.out.changed === false,
      "malformed conflict: still held at SETTLED");
    const rec2 = getRecord(env2);
    ok(rec2.invalid && rec2.invalid.reason === "conflict_invalid", "conflict_invalid stamped");
    ok(rec2.intents[0].payoutHoldReason === "invoice_conflict",
      "…and verification is BLOCKED anyway (truthy conflict holds)");
    ok(st2.calls.tx.length === 0 && st2.calls.rpc.length === 0, "zero reads for the held verification");
    ok(eventCount("record_invalid", mark2) === 1, "conflict_invalid logged once");
    ok(!r2.text.includes('"status":"VERIFIED"'), "never VERIFIED with an unreadable conflict");
    noVerifyTexts.push(r2.text);
  }

  /* ── 5. active-intent pointer integrity (POST /quote) ── */
  {
    /* Dangling pointer: held, never read as "no active intent", never repaired. */
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { activeIntentId: "pi_nonexistent" }));
    const r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "record_invalid" &&
      getRecord(env).invalid.reason === "active_intent_unresolvable",
      "dangling active-intent pointer -> 503 active_intent_unresolvable");
    const rec = getRecord(env);
    ok(rec.activeIntentId === "pi_nonexistent" && rec.intents.length === 1,
      "pointer NOT repaired, no second intent minted over an uncertain record");
    ok(state.calls.quote.length === 0, "no upstream quote requested");
    noVerifyTexts.push(r.text);

    /* Intents present but no pointer: which one is live is unreadable. */
    const envM = makeEnv();
    envM.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { activeIntentId: null }));
    const rm = await postQuote(envM);
    ok(rm.res.status === 503 && rm.out.code === "record_invalid" &&
      getRecord(envM).invalid.reason === "active_intent_missing",
      "missing pointer over a non-empty intents list -> active_intent_missing");

    /* Wrong-typed pointer. */
    const envW = makeEnv();
    envW.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { activeIntentId: 42 }));
    const rw = await postQuote(envW);
    ok(rw.res.status === 503 && rw.out.code === "record_invalid" &&
      getRecord(envW).invalid.reason === "active_intent_unresolvable",
      "non-string pointer -> active_intent_unresolvable (the old silent null-repair is gone)");

    /* Unreadable intents list: held, not wiped. */
    const envI = makeEnv();
    envI.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent()], { intents: "corrupt" }));
    const ri = await postQuote(envI);
    ok(ri.res.status === 503 && ri.out.code === "record_invalid" &&
      getRecord(envI).invalid.reason === "intents_invalid" && getRecord(envI).intents === "corrupt",
      "non-array intents list -> intents_invalid hold (never repaired into permissiveness)");
    noVerifyTexts.push(rm.text, rw.text, ri.text);
  }

  /* ── 6. persist-before-complete: a detected conflict survives an interruption ── */
 {
    const gate = { fail: (rec) => rec.intents.some((i) => i.status === "DEPOSIT_SEEN") };
    const state = stubNet();
    const env = makeEnv({}, { putGate: gate });
    const intent = await createIntent(env);
    /* The invoice settles on the NEAR rail while this intent is live… */
    state.link = openLink({ status: "PAID", paid_by: "payer.testnet", paid_amount: AMOUNT, paid_at: 1762800060000 });
    state.statusBody = { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" };
    const mark = logMark();
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 500 && r.out.code === "persistence_failed",
      "the cycle's final write is interrupted -> 500 persistence_failed");
    const rec = getRecord(env);
    ok(rec.conflict && rec.conflict.kind === "invoice_paid",
      "…but the DETECTED conflict was already persisted (persist-before-complete)");
    ok(rec.intents[0].status === "AWAITING_DEPOSIT" && !rec.history.some((h) => h.to === "DEPOSIT_SEEN"),
      "the interrupted transition is simply absent — recoverable, not half-applied");
    ok(eventCount("invoice_conflict", mark) === 1, "conflict logged exactly once");

    /* Recovery: the next cycle completes the transition; conflict intact. */
    gate.fail = null;
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "DEPOSIT_SEEN" && r2.out.changed === true,
      "recovery completes the transition on a fresh read (no duplicate, no assumption)");
    ok(r2.out.conflict === "invoice_paid", "conflict surfaced on the recovered response");
    ok(getRecord(env).conflict.detectedAt === rec.conflict.detectedAt,
      "conflict identity preserved (detectedAt not rewritten)");
    ok(eventCount("invoice_conflict", mark) === 1, "repeated observation does not re-log the conflict");

    /* And it stays, across further polls. */
    advance(2000);
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.res.status === 200 && r3.out.conflict === "invoice_paid" &&
      eventCount("invoice_conflict", mark) === 1, "conflict never auto-cleared, never re-logged");
    noVerifyTexts.push(r.text, r2.text, r3.text);
  }

  /* ── 7. held SETTLED: bounded contract-only watch (Phase 6) ── */
  {
    /* a. a fresh record keeps the zero-read hold exactly. */
    const s0 = stubNet({ statusMode: "http500" });
    const e0 = makeEnv();
    e0.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "SETTLED", tidepoolStatus: "SUCCESS" })]));
    const r0 = await getStatus(e0, SEED_ID);
    ok(r0.res.status === 200 && r0.out.intent.status === "SETTLED" &&
      s0.calls.status.length === 0 && s0.calls.rpc.length === 0 && s0.calls.tx.length === 0,
      "fresh held SETTLED: ZERO upstream reads (Phase 4/5 contract intact)");
    noVerifyTexts.push(r0.text);

    /* b/c. stale -> one contract read; immediately after -> bounded to zero. */
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "SETTLED", tidepoolStatus: "SUCCESS" })]));
    advance(60_001);
    const rb = await getStatus(env, SEED_ID);
    ok(rb.res.status === 200 && rb.out.changed === false &&
      state.calls.rpc.length === 1 && state.calls.status.length === 0 && state.calls.tx.length === 0,
      "stale held SETTLED: exactly ONE contract read (never Tidepool, never a tx read)");
    ok(getRecord(env).onChainCheckedAt === clock, "refresh persisted (next hold served from the record)");
    const rc = await getStatus(env, SEED_ID);
    ok(state.calls.rpc.length === 1 && state.calls.status.length === 0,
      "bounded: a fresh onChainCheckedAt -> zero reads again");
    noVerifyTexts.push(rb.text, rc.text);

    /* d. the conflict is still detectable after polling stopped. */
    const mark = logMark();
    advance(60_001);
    state.link = openLink({ status: "PAID", paid_by: "payer.testnet", paid_amount: AMOUNT, paid_at: 1762800060000 });
    const rd = await getStatus(env, SEED_ID);
    ok(rd.res.status === 200 && rd.out.conflict === "invoice_paid" &&
      rd.out.intent.status === "SETTLED",
      "invoice turns PAID while held: conflict detected and surfaced (never VERIFIED)");
    const recD = getRecord(env);
    ok(recD.conflict && recD.conflict.kind === "invoice_paid" && recD.invalid === undefined,
      "conflict persisted; record otherwise clean");
    ok(recD.intents[0].payoutHoldReason === "invoice_paid", "hold reason updated to the conflict");
    ok(eventCount("invoice_conflict", mark) === 1 && state.calls.tx.length === 0,
      "one log, zero tx reads — observation only");
    const detectedAt = recD.conflict.detectedAt;
    const rd2 = await getStatus(env, SEED_ID);
    ok(rd2.out.conflict === "invoice_paid" && getRecord(env).conflict.detectedAt === detectedAt &&
      eventCount("invoice_conflict", mark) === 1,
      "repeated polls: conflict stable, single log, never cleared");
    noVerifyTexts.push(rd.text, rd2.text);

    /* e. RPC down during the refresh: honestly stale, then recovers. */
    const st2 = stubNet({ rpcMode: "http500" });
    const env2 = makeEnv();
    env2.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({ status: "SETTLED", tidepoolStatus: "SUCCESS" })]));
    const checkedSeed = getRecord(env2).onChainCheckedAt;
    advance(60_001);
    const re = await getStatus(env2, SEED_ID);
    ok(re.res.status === 200 && getRecord(env2).conflict === null &&
      getRecord(env2).onChainCheckedAt === checkedSeed,
      "contract read fails: last known state kept, checkedAt NOT advanced (honestly stale)");
    st2.rpcMode = "ok";
    st2.link = openLink({ status: "PAID", paid_by: "payer.testnet", paid_amount: AMOUNT, paid_at: 1762800060000 });
    const re2 = await getStatus(env2, SEED_ID);
    ok(re2.res.status === 200 && re2.out.conflict === "invoice_paid",
      "recovery after RPC returns: the conflict is found on the next bounded refresh");
    noVerifyTexts.push(re.text, re2.text);
  }

  /* ── 8. interrupted verification: recover without duplicate transitions ── */
  {
    const gate = { fail: (rec) => rec.intents.some((i) => i.status === "VERIFIED") };
    const { state, env, intent } = await settledFlow({ txs: { [H1]: payoutTx() }, doOpts: { putGate: gate } });
    ok(getRecord(env).intents[0].status === "SETTLED" &&
      Array.isArray(getRecord(env).intents[0].payoutHashes),
      "settled with candidates captured server-side");

    advance(2000);
    const mark = logMark();
    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 500 && r.out.code === "persistence_failed",
      "the VERIFIED write is interrupted -> persistence_failed");
    ok(getRecord(env).intents[0].status === "SETTLED" && !getRecord(env).history.some((h) => h.to === "VERIFIED"),
      "…record still SETTLED: the transition never half-applied");
    ok(eventCount("payout_verify_ok", mark) === 0,
      "…and no success was logged for the interrupted attempt");

    gate.fail = null;
    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "VERIFIED" && r2.out.changed === true,
      "recovery: the next eligible poll verifies from the SAME record");
    const rec = getRecord(env);
    ok(rec.intents.length === 1 && rec.activeIntentId === intent.intentId,
      "no duplicate intent created by the recovery");
    ok(rec.history.filter((h) => h.to === "VERIFIED").length === 1,
      "exactly one SETTLED -> VERIFIED entry (no duplicate transition)");
    ok(eventCount("payout_verify_ok", mark) === 1,
      "payout_verify_ok logged exactly once — the failed attempt never claimed success");
    ok(state.calls.tx.length === 2, "evidence re-fetched on recovery (recovery never assumes the prior attempt)");
  }

  /* ── 9. interrupted status polling: recover idempotently ── */
  {
    const gate = { fail: (rec) => rec.intents.some((i) => i.status === "DEPOSIT_SEEN") };
    const state = stubNet({ statusBody: { status: "KNOWN_DEPOSIT_TX", updatedAt: "2026-11-11T12:00:05.000Z" } });
    const env = makeEnv({}, { putGate: gate });
    const intent = await createIntent(env);

    const r = await getStatus(env, intent.intentId);
    ok(r.res.status === 500 && r.out.code === "persistence_failed", "poll cycle interrupted at its final write");
    const rec = getRecord(env);
    ok(rec.intents[0].status === "AWAITING_DEPOSIT", "transition absent from storage (not half-applied)");
    ok(typeof rec.intents[0].lastStatusPollAt === "number",
      "…but the poll stamp persisted, so a retry cannot overlap the lost cycle");

    /* Duplicate/repeat inside the floor: served from the record, zero reads. */
    const calls = state.calls.status.length;
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "AWAITING_DEPOSIT" &&
      state.calls.status.length === calls, "repeat inside the poll floor: record answer, zero new reads");

    /* Recovery after the floor: one transition, one history entry. */
    gate.fail = null;
    advance(2000);
    const r3 = await getStatus(env, intent.intentId);
    ok(r3.res.status === 200 && r3.out.intent.status === "DEPOSIT_SEEN" && r3.out.changed === true,
      "recovery poll applies the transition exactly once");
    ok(getRecord(env).history.filter((h) => h.to === "DEPOSIT_SEEN").length === 1,
      "no duplicate transition recorded");
    ok(state.calls.status.length === calls + 1, "exactly one upstream read in the recovery");
    noVerifyTexts.push(r2.text, r3.text);
  }

  /* ── 10. reconcile honours the upstream Retry-After (Phase 6 fix) ── */
  {
    const state = stubNet();
    const env = makeEnv();
    await createIntent(env);
    advance(3_600_001); // past the quote deadline -> reconcile on POST /quote
    state.statusMode = () => new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "120" },
    });
    const r = await postQuote(env);
    ok(r.res.status === 503 && r.out.code === "reconcile_cooldown" && r.out.retryAfterSec === 120,
      "reconcile path: Retry-After 120 s -> retryAfterSec 120 (max of own 60 s + upstream)");
    ok(r.res.headers.get("retry-after") === "120", "Retry-After header follows the upstream instruction");
    ok(getRecord(env).intents[0].reconcileUntil === clock + 120_000,
      "cooldown persisted with the upstream window (survives the response)");
    ok(getRecord(env).intents[0].status === "RECONCILE", "intent parked in RECONCILE");

    const calls = state.calls.status.length;
    const r2 = await postQuote(env);
    ok(r2.res.status === 503 && state.calls.status.length === calls && state.calls.quote.length === 1,
      "immediate retry: throttled, zero new upstream reads, no second quote");

    state.statusMode = "ok";
    advance(120_001);
    const r3 = await postQuote(env);
    ok(r3.res.status === 201 && r3.out.reused === false &&
      getRecord(env).intents.length === 2 && getRecord(env).intents[0].status === "EXPIRED",
      "after the honoured window: honest resolution (past deadline, no deposit -> EXPIRED) then a fresh intent");
    ok(state.calls.quote.length === 2, "exactly one more upstream quote");
    noVerifyTexts.push(r.text, r2.text);
  }

  /* ── 11. Durable Object reactivation: verification continues from the record ── */
  {
    const state1 = stubNet({ txs: { [H1]: payoutTx() } });
    const env1 = makeEnv();
    const intent = await createIntent(env1);
    state1.statusBody = successWith(swap());
    const land = await getStatus(env1, intent.intentId);
    ok(land.out.intent.status === "SETTLED" && state1.calls.tx.length === 0,
      "landing captured candidates; no verification yet");

    /* A NEW worker instance on the SAME storage: reactivation. */
    const state2 = stubNet({ txs: { [H1]: payoutTx() } });
    const env2 = makeEnv({}, { instances: env1.INTENT_DO.instances });
    const mark = logMark();
    advance(2000);
    const r = await getStatus(env2, intent.intentId);
    ok(r.res.status === 200 && r.out.intent.status === "VERIFIED" && r.out.changed === true,
      "recovery after DO reactivation: verification completes from the persisted record");
    const rec = getRecord(env2);
    ok(rec.intents.length === 1 && rec.intents[0].intentId === intent.intentId,
      "same intent, no duplicate creation across instances");
    ok(state1.calls.tx.length === 0 && state2.calls.tx.length === 1,
      "the verification ran exactly once, in the reactivated instance");
    ok(eventCount("payout_verify_ok", mark) === 1, "one payout_verify_ok");
    ok(state2.calls.status.length === 0 && state2.calls.rpc.length === 1,
      "verification is Tidepool-less: zero status reads, one contract read");
  }

  /* ── 12. Durable Object reactivation: interrupted creation recovers ── */
  {
    const gate = { fail: (rec) => rec.intents.some((i) => i.status === "AWAITING_DEPOSIT") };
    const state = stubNet();
    const env1 = makeEnv({}, { putGate: gate });
    const r1 = await postQuote(env1);
    ok(r1.res.status === 500 && r1.out.code === "persistence_failed" &&
      state.calls.quote.length === 1, "creation interrupted after the upstream quote");
    const rec1 = getRecord(env1);
    ok(rec1.intents.length === 1 && rec1.intents[0].status === "CREATING" &&
      rec1.intents[0].depositAddress === null,
      "CREATING checkpoint retained (no address leaked into storage)");

    gate.fail = null;
    const env2 = makeEnv({}, { instances: env1.INTENT_DO.instances });
    const r2 = await postQuote(env2);
    ok(r2.res.status === 503 && r2.out.code === "reconcile_cooldown" && state.calls.quote.length === 1,
      "reactivated instance: retry inside the cooldown -> no second quote (idempotent)");

    advance(60_001);
    const r3 = await postQuote(env2);
    ok(r3.res.status === 201 && r3.out.reused === false, "after the cooldown -> superseding 201");
    const rec2 = getRecord(env2);
    ok(rec2.intents.length === 2 && rec2.intents[0].status === "FAILED" &&
      rec2.intents[0].lastReason === "creation_interrupted" && rec2.intents[0].depositAddress === null &&
      rec2.intents[1].status === "AWAITING_DEPOSIT" && rec2.intents[1].depositAddress,
      "old intent closed honestly, ONE new live address — never a duplicate intent");
    ok(state.calls.quote.length === 2, "exactly one more upstream quote");
    noVerifyTexts.push(r1.text, r2.text);
  }

  /* ── 13. every documented Tidepool status: observed idempotently ── */
  {
    const matrix = [
      ["PENDING_DEPOSIT", "AWAITING_DEPOSIT", false],
      ["KNOWN_DEPOSIT_TX", "DEPOSIT_SEEN", true],
      ["INCOMPLETE_DEPOSIT", "DEPOSIT_SEEN", true],
      ["PROCESSING", "SETTLING", true],
      ["SUCCESS", "SETTLED", true],
      ["REFUNDED", "REFUNDED", true],
      ["FAILED", "FAILED", true],
    ];
    for (const [upstream, expected, changed] of matrix) {
      const state = stubNet({ statusBody: { status: upstream, updatedAt: "2026-11-11T12:00:05.000Z" } });
      const env = makeEnv();
      const intent = await createIntent(env);
      const r = await getStatus(env, intent.intentId);
      ok(r.res.status === 200 && r.out.intent.status === expected && r.out.changed === changed,
        `${upstream} -> ${expected}${changed ? "" : " (no transition)"}`);
      if (upstream === "SUCCESS") {
        ok(!r.text.includes('"status":"VERIFIED"') && state.calls.tx.length === 0,
          "SUCCESS: SETTLED, never VERIFIED, zero tx reads");
        noVerifyTexts.push(r.text);
      }
      /* Same payment observed again: nothing changes, nothing duplicates. */
      const histLen = getRecord(env).history.length;
      const statusCalls = state.calls.status.length;
      advance(2000);
      const r2 = await getStatus(env, intent.intentId);
      ok(r2.res.status === 200 && r2.out.changed === false &&
        getRecord(env).history.length === histLen,
        `${upstream}: repeat observation is a no-op (one transition, stable history)`);
      if (upstream === "SUCCESS") {
        ok(state.calls.status.length === statusCalls, "SUCCESS: no Tidepool re-read after settlement (docs)");
        noVerifyTexts.push(r2.text);
      }
    }
  }

  /* ── 14. hold reasons persist; logged once per distinct reason ── */
  {
    const { env, intent } = await settledFlow({
      txs: { [H1]: payoutTx({ to: "attacker.testnet", event: nep297("verifier.tidepool-sandbox.testnet", "attacker.testnet", AMOUNT) }) },
    });
    const mark = logMark();
    advance(2000);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.res.status === 200 && r1.out.intent.status === "SETTLED" &&
      getRecord(env).intents[0].payoutHoldReason === "evidence_mismatch",
      "wrong recipient: held with evidence_mismatch, persisted");
    ok(eventCount("payout_verify_hold", mark) === 1, "hold logged once");
    ok(!r1.text.includes("attacker"), "the hostile recipient is never echoed");

    advance(2000);
    const r2 = await getStatus(env, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "SETTLED" &&
      getRecord(env).intents[0].payoutHoldReason === "evidence_mismatch" &&
      getRecord(env).intents[0].verifyAttempts === 2,
      "second attempt: same persisted reason, attempts counted (bounded backoff bookkeeping)");
    ok(eventCount("payout_verify_hold", mark) === 1, "unchanged condition: no log flooding");
    ok(!r2.text.includes('"status":"VERIFIED"'), "never VERIFIED on incomplete evidence");

    /* Reactivation: the hold and its single log survive the restart. */
    const env2 = makeEnv({}, { instances: env.INTENT_DO.instances });
    advance(2000);
    const r3 = await getStatus(env2, intent.intentId);
    ok(r3.res.status === 200 && r3.out.intent.status === "SETTLED" &&
      getRecord(env2).intents[0].payoutHoldReason === "evidence_mismatch" &&
      getRecord(env2).intents[0].verifyAttempts === 3,
      "recovery after reactivation: still held, still the same reason, still one log");
    ok(eventCount("payout_verify_hold", mark) === 1, "…and payout_verify_hold never re-fired");
    noVerifyTexts.push(r1.text, r2.text, r3.text);
  }

  /* ── 15. multiple candidates: double_payout found later, preserved ── */
  {
    const both = swap({
      nearTxHashes: [H1, H2],
      destinationChainTxHashes: [{ hash: H1, chain: "near" }, { hash: H2, chain: "near" }],
    });
    const { env, intent } = await settledFlow({
      txs: { [H1]: payoutTx() },
      swap: both,
    });
    const mark = logMark();
    advance(2000);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.res.status === 200 && r1.out.intent.status === "SETTLED" &&
      getRecord(env).intents[0].payoutHoldReason === "evidence_pending",
      "second candidate not yet visible -> evidence_pending hold (retryable, not FAILED)");
    ok(getRecord(env).conflict === null && eventCount("payout_conflict", mark) === 0,
      "no conflict invented while evidence is merely incomplete");

    /* Reactivation + the second payout becomes visible: conflict found. */
    const state2 = stubNet({ txs: { [H1]: payoutTx(), [H2]: payoutTx() } });
    const env2 = makeEnv({}, { instances: env.INTENT_DO.instances });
    advance(2000);
    const r2 = await getStatus(env2, intent.intentId);
    const rec2 = getRecord(env2);
    ok(r2.res.status === 200 && r2.out.intent.status === "SETTLED" &&
      rec2.conflict && rec2.conflict.kind === "double_payout",
      "two payouts proven -> double_payout conflict recorded and persisted");
    ok(r2.out.conflict === "double_payout", "conflict surfaced to the client");
    ok(eventCount("payout_conflict", mark) === 1, "payout_conflict logged once at level error");
    ok(rec2.intents[0].payoutHoldReason === "double_payout", "held on the conflict");
    ok(!r2.text.includes('"status":"VERIFIED"'), "a double pay never becomes VERIFIED");
    noVerifyTexts.push(r1.text, r2.text);

    /* And it survives ANOTHER reactivation — with zero reads (step 1 hold). */
    const state3 = stubNet({ txs: { [H1]: payoutTx(), [H2]: payoutTx() } });
    const env3 = makeEnv({}, { instances: env.INTENT_DO.instances });
    advance(2000);
    const r3 = await getStatus(env3, intent.intentId);
    ok(r3.res.status === 200 && r3.out.conflict === "double_payout" &&
      getRecord(env3).conflict.detectedAt === rec2.conflict.detectedAt,
      "conflict preserved across reactivation (identity unchanged, never cleared)");
    ok(eventCount("payout_conflict", mark) === 1, "never re-detected, never re-logged");
    ok(state3.calls.tx.length === 0 && state3.calls.rpc.length === 0,
      "a stored conflict holds with ZERO reads");
    noVerifyTexts.push(r3.text);
  }

  /* ── 16. delayed payout visibility: hold -> recovery -> VERIFIED ── */
  {
    const { env, intent } = await settledFlow({ txs: {} });   // H1 not visible yet
    const mark = logMark();
    advance(2000);
    const r1 = await getStatus(env, intent.intentId);
    ok(r1.res.status === 200 && r1.out.intent.status === "SETTLED" &&
      getRecord(env).intents[0].payoutHoldReason === "evidence_pending",
      "tx temporarily invisible to the RPC -> evidence_pending (retryable, not FAILED)");
    ok(eventCount("payout_verify_ok", mark) === 0, "no success claimed");

    /* Reactivation + the tx is now visible: full Phase 5 evidence runs. */
    const state2 = stubNet({ txs: { [H1]: payoutTx() } });
    const env2 = makeEnv({}, { instances: env.INTENT_DO.instances });
    advance(2000);
    const r2 = await getStatus(env2, intent.intentId);
    ok(r2.res.status === 200 && r2.out.intent.status === "VERIFIED" && r2.out.changed === true,
      "recovery: evidence found later -> SETTLED -> VERIFIED (only path)");
    ok(eventCount("payout_verify_ok", mark) === 1, "exactly one success log across the whole life");
    ok(getRecord(env2).intents[0].payoutHoldReason === null, "hold cleared only on success");
    ok(getRecord(env2).history.filter((h) => h.to === "VERIFIED").length === 1, "one transition recorded");
  }

  /* ── 17. NEAR invoice turns PAID mid-reconciliation ── */
  {
    const state = stubNet();
    const env = makeEnv();
    env.INTENT_DO.seed(LINK_ID, seedRecord([seedIntent({
      status: "RECONCILE", reconcileUntil: null, lastError: "http_status",
      depositObserved: false, payoutHashes: [H1],
    })]));
    state.link = openLink({ status: "PAID", paid_by: "payer.testnet", paid_amount: AMOUNT, paid_at: 1762800060000 });
    const mark = logMark();

    const r1 = await getStatus(env, SEED_ID);
    ok(r1.res.status === 200 && r1.out.conflict === "invoice_paid" &&
      r1.out.intent.status === "AWAITING_DEPOSIT" && r1.out.changed === true,
      "invoice PAID discovered during reconciliation: conflict recorded, state resolved honestly");
    ok(getRecord(env).conflict && getRecord(env).conflict.kind === "invoice_paid",
      "conflict persisted");
    ok(eventCount("invoice_conflict", mark) === 1, "logged once");

    /* Tidepool later reports SUCCESS: SETTLED with the conflict attached. */
    advance(2000);
    state.statusBody = successWith(swap());
    const r2 = await getStatus(env, SEED_ID);
    ok(r2.res.status === 200 && r2.out.intent.status === "SETTLED" && r2.out.conflict === "invoice_paid",
      "SUCCESS -> SETTLED, conflict still surfaced (never cleared)");
    ok(getRecord(env).intents[0].payoutHashes.length === 1, "candidates captured for the verification leg");

    /* Verification is BLOCKED by the stored conflict — zero reads. */
    advance(2000);
    const r3 = await getStatus(env, SEED_ID);
    const rec = getRecord(env);
    ok(r3.res.status === 200 && r3.out.intent.status === "SETTLED" &&
      rec.intents[0].payoutHoldReason === "invoice_paid",
      "conflicted payment stays out of VERIFIED (stored-conflict hold)");
    ok(!r3.text.includes('"status":"VERIFIED"'), "never VERIFIED");
    ok(eventCount("invoice_conflict", mark) === 1 && eventCount("payout_conflict", mark) === 0,
      "conflict detection never re-fires");
    noVerifyTexts.push(r1.text, r2.text, r3.text);
  }

  /* ── 18. client-supplied financial facts are never trusted ── */
  {
    const state = stubNet();
    const env = makeEnv();
    const evil = defaultBody({
      invoiceAmount: "1",
      merchant: "evil.testnet",
      status: "VERIFIED",
      depositAddress: "pa000099ababababababababababababababababababababababababababababab",
      onChainStatus: "PAID",
      conflict: { kind: "invoice_paid" },
      activeIntentId: "pi_evil",
      history: "wipe",
    });
    const r = await postQuote(env, evil);
    ok(r.res.status === 201, "a quote with hostile extra fields still creates normally");
    const rec = getRecord(env);
    const it = rec.intents[0];
    ok(it.invoiceAmount === AMOUNT && it.merchant === MERCHANT,
      "stored invoice facts come from the CONTRACT, not the request body");
    ok(it.status === "AWAITING_DEPOSIT", "status is never client-writable");
    ok(it.depositAddress && !evil.depositAddress.startsWith(it.depositAddress.slice(0, 9)),
      "deposit address comes from the verified quote, not the body");
    ok(rec.onChainStatus === "OPEN" && rec.conflict === null && rec.activeIntentId === it.intentId,
      "record-level facts (onChainStatus, conflict, pointer) never client-writable");
    ok(Array.isArray(rec.history), "history not wiped by a client field");

    /* GET /status: extra parameters are ignored, never reflected. */
    const rs = await getStatus(env, it.intentId, LINK_ID,
      "&depositAddress=pa000098abababababababababababababababababababababababababababab&invoiceAmount=1&conflict=invoice_paid");
    ok(rs.res.status === 200 && !rs.text.includes("pa000098") && !rs.text.includes('"conflict":"invoice_paid"'),
      "query parameters never reach the record or the response");
    ok(state.calls.status.every((c) => c.url.includes(it.depositAddress)) &&
      state.calls.status.every((c) => !c.url.includes("pa000098")),
      "only the STORED address is ever queried");
  }

  /* ── 19. sweeps: no internal evidence anywhere, no VERIFIED without evidence ── */
  {
    const allStatus = statusTexts.join("\n");
    ok(statusTexts.length >= 40, `sweep ran over a meaningful sample (${statusTexts.length} /status responses)`);
    for (const h of [H1, H2]) {
      ok(!allStatus.includes(h), `no tx hash in any /status body (${h.slice(0, 6)}…)`);
      ok(!logs.some((e) => JSON.stringify(e).includes(h)), `no tx hash in any log line (${h.slice(0, 6)}…)`);
    }
    ok(!ADDR_RE.test(allStatus), "no deposit address in any /status body");
    ok(!ADDR_RE.test(logs.map((e) => JSON.stringify(e)).join("\n")), "no deposit address in any log line");
    ok(!allStatus.includes("swapDetails") && !allStatus.includes("payoutHash") &&
      !allStatus.includes("verifyAttempts") && !allStatus.includes("verifyUntil") &&
      !allStatus.includes("reconcileUntil") && !allStatus.includes("lastStatusPollAt") &&
      !allStatus.includes("sentQuoteRequest") && !allStatus.includes("detectedAt"),
      "no internal reconciliation bookkeeping field ever leaves /status");
    ok(!allStatus.includes('"invalid"') && !allStatus.includes("record_malformed") &&
      !allStatus.includes("SEEDSIGNATURE") && !allStatus.includes("ed25519:") &&
      !allStatus.includes("cid-test") && !allStatus.includes("history"),
      "no integrity stamp, quarantine reason, signature, correlation id or history in any /status body");
    ok(!allStatus.includes("attacker") && !allStatus.includes("evil"),
      "hostile fixture values never reach a client");

    const allLogs = logs.map((e) => JSON.stringify(e)).join("\n");
    ok(!allLogs.includes("ed25519:"), "no signature material in the logs");
    ok(!allLogs.includes("TX-DETAIL-MARKER") && !allLogs.includes("RPC-DETAIL-MARKER") &&
      !allLogs.includes("STATUS-DETAIL-MARKER") && !allLogs.includes("UPSTREAM-DETAIL-MARKER") &&
      !allLogs.includes("RATE-LIMIT-MARKER"),
      "raw upstream detail never reaches the logs");
    ok(!allLogs.includes("REPLACE_WITH"), "no config placeholder leaked anywhere");
    ok(logs.every((e) => e.svc && e.event && e.build && e.ts),
      "every log line carries the M-01 envelope");

    const invLogs = logs.filter((e) => e.event === "record_invalid");
    ok(invLogs.length > 0, `record_invalid exercised (${invLogs.length} lines)`);
    ok(invLogs.every((e) => e.level === "alert" && typeof e.reason === "string" && e.reason && e.linkId),
      "record_invalid: level alert + machine reason + ids on every line");
    ok(!/[1-9A-HJ-NP-Za-km-z]{40,}/.test(invLogs.map((e) => JSON.stringify(e)).join("\n")),
      "record_invalid lines carry reason codes only — no hash-shaped data");
    const malformedTransitions = logs.filter((e) => e.event === "intent_transition" && e.reason === "record_malformed");
    ok(malformedTransitions.length > 0 &&
      malformedTransitions.every((e) => e.from && e.to === "RECONCILE"),
      "quarantine transitions are auditable (from the raw value to RECONCILE)");
    const conflictLogs = logs.filter((e) => e.event === "invoice_conflict" || e.event === "payout_conflict");
    ok(conflictLogs.length > 0 && conflictLogs.every((e) => e.level === "alert"),
      "every conflict log is level alert (webhook-eligible)");

    ok(noVerifyTexts.length >= 20, `no-evidence sample is meaningful (${noVerifyTexts.length} responses)`);
    ok(noVerifyTexts.every((t) => !t.includes('"status":"VERIFIED"')),
      "NOT ONE no-evidence response ever claims VERIFIED");
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
