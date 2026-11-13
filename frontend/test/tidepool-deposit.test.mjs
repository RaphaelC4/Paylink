/* Deposit-instruction tests — run with: node frontend/test/tidepool-deposit.test.mjs
 *
 * Phase 7 §deposit: the instruction block shows exactly what a payer needs
 * (amount, address, memo, deadline) with copy buttons in the app's shared
 * shape, spells out that the deposit address is NOT the merchant's NEAR
 * payout address, warns before the deadline, and never renders a field the
 * spec forbids (signature, correlation id, hashes, lastReason, internal
 * state). After a reload the journey resumes status-first and instructions
 * come back only through an explicit, reuse-guaranteed re-quote.
 */

import { createTidepoolRail, tpInstructionsHtml, tpParseQuote } from "../tidepool.js";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const ENDPOINT = "https://paylink-tidepool.example.workers.dev";
const LINK_ID = "demo-004";
const LINK = { link_id: LINK_ID };
const CTX = { st: "OPEN", mine: false, accountId: "bob.testnet" };
const INTENT_ID = "pi_0123456789abcdef";
const flush = () => new Promise((r) => setTimeout(r, 0));

const NETS = {
  networks: [
    { blockchain: "ethereum", name: "Ethereum", availability: "bridge-ok",
      tokens: [{ assetId: "nep141:usdc.eth", symbol: "USDC", decimals: 6, contractAddress: "0xeth" }] },
  ],
  count: { networks: 1, tokens: 1 }, fetchedAt: "2026-11-12T00:00:00Z", cached: false, cacheSeconds: 60,
};

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (n) => {
    const k = Object.keys(headers).find((x) => x.toLowerCase() === String(n).toLowerCase());
    return k ? String(headers[k]) : null;
  } },
  json: async () => body,
});

/* A quote carrying every renderable field PLUS hostile extras that must
   never reach the DOM. */
const quoteBody = (intentOver = {}) => ({
  ok: true, reused: false,
  intent: {
    intentId: INTENT_ID, linkId: LINK_ID, status: "AWAITING_DEPOSIT",
    depositAddress: "dep.tidepool.testnet", depositMemo: "memo-42",
    source: { assetId: "nep141:usdc.eth", blockchain: "ethereum", symbol: "USDC", decimals: 6 },
    destination: { assetId: "nep141:usdc.tidepool-sandbox.testnet", blockchain: "near", symbol: "USDC", decimals: 6 },
    merchant: "shop.testnet",
    invoiceAmount: "1000000", expectedInputAmount: "10050000", minInputAmount: "10000000",
    expectedOutputAmount: "1000000",
    quoteDeadline: new Date(Date.now() + 900000).toISOString(),
    correlationId: "CORR-SECRET-9f", signature: "SIG-SECRET-9f", signatureValid: true,
    swapDetails: { nearTxHashes: ["SECRET-HASH"] }, payoutHashes: ["SECRET-HASH"],
    lastReason: "SECRET-REASON", history: ["SECRET-HISTORY"],
    tidepoolStatus: "PENDING_DEPOSIT",
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
    ...intentOver,
  },
  onChainStatus: "OPEN",
});

const statusBody = (status, extra = {}) => ({
  ok: true,
  intent: {
    intentId: INTENT_ID, linkId: LINK_ID, status,
    tidepoolStatus: extra.tidepoolStatus ?? null,
    quoteDeadline: null, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:01:00Z",
  },
  onChainStatus: "OPEN", conflict: null, changed: false,
});

function fakeEl() {
  return { innerHTML: "", addEventListener() {}, querySelector() { return null; }, contains() { return false; } };
}
function fakeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function fakeTimers() {
  let seq = 1;
  const pending = new Map();
  return {
    schedule: (fn, ms) => { const id = seq++; pending.set(id, { fn, ms }); return id; },
    unschedule: (id) => pending.delete(id),
    pending,
    nextDelay() { const v = pending.values().next(); return v.done ? null : v.value.ms; },
    async runNext() {
      const first = pending.entries().next();
      if (first.done) return false;
      const [id, { fn }] = first.value;
      pending.delete(id);
      await fn();
      return true;
    },
  };
}

/* Build a rail with scripted responses; `pre` runs before the quote. */
async function scenario(opts = {}) {
  const el = fakeEl();
  const store = opts.store || fakeStore();
  const timers = fakeTimers();
  const calls = [];
  let qRes = opts.quoteRes || res(201, quoteBody(opts.intentOver || {}));
  let sRes = opts.statusRes || res(200, statusBody("AWAITING_DEPOSIT"));
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null });
    if (u.includes("/networks")) return res(200, NETS);
    if (u.includes("/quote")) return typeof qRes === "function" ? qRes() : qRes;
    if (u.includes("/status")) return typeof sRes === "function" ? sRes() : sRes;
    throw new Error(`unexpected request: ${u}`);
  };
  const seen = { verified: 0, stale: 0 };
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => store,
    schedule: timers.schedule, unschedule: timers.unschedule,
    onVerified: () => { seen.verified++; },
    onInvoiceStale: () => { seen.stale++; },
    onActionsChanged: () => {},
  });
  rail.init({ endpoint: ENDPOINT });
  await rail.sync(LINK, CTX);
  await flush();
  rail.setForm({ blockchain: "ethereum", assetId: "nep141:usdc.eth", refundTo: "alice.testnet" });
  if (opts.skipQuote !== true) await rail.quote();
  return { rail, el, store, timers, calls, seen,
           setQuote: (r) => { qRes = r; }, setStatus: (r) => { sRes = r; } };
}

/* ── pure: the instruction block ── */

{
  const intent = tpParseQuote(quoteBody());
  const html = tpInstructionsHtml(intent, Date.now());
  ok(html.includes("10.05 USDC"), "expected input rendered exactly (BigInt base units, 6 decimals)");
  ok(html.includes("10") && html.includes("(minimum 10)"), "minimum shown when it differs");
  ok(html.includes("dep.tidepool.testnet"), "deposit address rendered");
  ok(html.includes("memo-42"), "deposit memo rendered");
  ok(html.includes("ethereum"), "source network named");
  ok(html.includes("Quote expires in"), "deadline rendered");
  ok(html.includes("not") && html.includes("shop.testnet"), "merchant NEAR address named in the distinction note");
  ok(html.includes('data-copy-text="dep.tidepool.testnet"'), "address copy button uses the shared copy hook");
  ok(html.includes('data-copy-label="Address copied!"'), "copy button carries its confirm label");
  ok(html.includes("<span>Copy</span>"), "copy button has the inner span the delegated handler swaps");
  ok(!html.includes("CORR-SECRET") && !html.includes("SIG-SECRET"), "correlation id / signature never rendered");
  ok(!html.includes("SECRET-HASH") && !html.includes("SECRET-REASON"), "hashes and lastReason never rendered");
}

{
  const noMemo = quoteBody();
  noMemo.intent.depositMemo = null;
  const html = tpInstructionsHtml(tpParseQuote(noMemo), Date.now());
  ok(!html.includes("memo"), "no memo row when the quote carries none");
}

{
  const expired = quoteBody({ quoteDeadline: new Date(Date.now() - 1000).toISOString() });
  const html = tpInstructionsHtml(tpParseQuote(expired), Date.now());
  ok(html.includes("Quote expired") && html.includes("request a new quote before sending"),
    "expired deadline blocks sending with clear words");
}

{
  const soon = quoteBody({ quoteDeadline: new Date(Date.now() + 30000).toISOString() });
  const html = tpInstructionsHtml(tpParseQuote(soon), Date.now());
  ok(html.includes("Quote expires in 30s") && html.includes("warn"), "sub-minute deadline warns");
}

{
  /* hostile symbol: escaped, never markup */
  const evil = quoteBody();
  evil.intent.source.symbol = "<img src=x onerror=alert(1)>";
  const html = tpInstructionsHtml(tpParseQuote(evil), Date.now());
  ok(!html.includes("<img") && html.includes("&lt;img"), "hostile symbol is escaped, not executed");
}

/* ── rail: quote → instructions on the card ── */

{
  const { rail, el } = await scenario();
  ok(el.innerHTML.includes("Deposit instructions"), "instruction block rendered after the quote");
  ok(el.innerHTML.includes("10.05 USDC"), "amount on the rendered card");
  ok(el.innerHTML.includes('data-copy-text="dep.tidepool.testnet"'), "copyable address on the card");
  ok(el.innerHTML.includes("never send funds there yourself"), "deposit vs merchant address distinction shown");
  ok(el.innerHTML.includes("Invoice on chain"), "authoritative invoice state shown alongside");
  ok(!el.innerHTML.includes("alice.testnet"), "refund address is never rendered as a deposit target");
  const html = el.innerHTML;
  ok(!html.includes("CORR-SECRET") && !html.includes("SIG-SECRET") && !html.includes("SECRET-HASH"),
     "hostile extras from the wire never reach the DOM");
}

/* ── reload: status-first, instructions only on request ── */

{
  const first = await scenario();
  const persisted = first.store.getItem("paylink:tp-journey:v1");
  ok(!!persisted, "journey persisted for resume");

  /* fresh rail, same storage — simulates a page reload */
  const second = await scenario({ store: (function () {
    const m = new Map([["paylink:tp-journey:v1", persisted]]);
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })(), skipQuote: true });
  await flush();
  await second.timers.runNext(); // the resume status read
  const snap = second.rail.snapshot();
  ok(snap.journey && snap.journey.intentId === INTENT_ID, "journey restored from storage");
  ok(snap.status && snap.status.status === "AWAITING_DEPOSIT", "resume is status-first");
  ok(second.el.innerHTML.includes("Deposit details are re-fetched"), "instructions hidden after reload");
  ok(!second.el.innerHTML.includes("dep.tidepool.testnet"), "no deposit address rendered from stale memory");
  ok(second.el.innerHTML.includes("Show deposit details"), "explicit press offered for reuse-guaranteed states");

  /* the press: a reuse-guaranteed re-quote with the SAME intent id */
  await second.rail.details();
  const qCalls = second.calls.filter((c) => c.url.includes("/quote"));
  ok(qCalls.length === 1, "exactly one re-quote for the press");
  ok(qCalls[0].body.linkId === LINK_ID && qCalls[0].body.refundTo === "alice.testnet",
    "re-quote carries the persisted routing fields");
  ok(second.el.innerHTML.includes("dep.tidepool.testnet"), "instructions rebuilt from the Worker");
}

/* ── resume never adopts a different attempt ── */

{
  const first = await scenario();
  const persisted = first.store.getItem("paylink:tp-journey:v1");
  const store2 = (function () {
    const m = new Map([["paylink:tp-journey:v1", persisted]]);
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  const second = await scenario({ store: store2, skipQuote: true,
    quoteRes: res(201, quoteBody({ intentId: "pi_abcdef0123456789" })) });
  await flush();
  await second.timers.runNext();
  await second.rail.details();
  ok(second.rail.snapshot().journey.intentId === INTENT_ID, "journey keeps its own attempt id");
  ok(second.el.innerHTML.includes("different payment attempt"), "mismatch explained, nothing adopted");
  ok(!second.el.innerHTML.includes("dep.tidepool.testnet"), "no instructions from the refused attempt");
}

/* ── CREATING: no details button, no auto re-quote ── */

{
  const { rail, el, calls } = await scenario({
    quoteRes: res(201, { ...quoteBody(), intent: { ...quoteBody().intent, status: "CREATING" } }),
    statusRes: res(200, statusBody("CREATING")),
  });
  ok(!el.innerHTML.includes("Show deposit details"), "CREATING offers no details press");
  ok(calls.filter((c) => c.url.includes("/quote")).length === 1, "CREATING never triggers an automatic re-quote");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
