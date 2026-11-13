/* Quote tests — run with: node frontend/test/tidepool-quote.test.mjs
 *
 * Phase 7 §quote: exact request shape (four routing fields + idempotency
 * key, NO amount — the Worker derives the invoice amount from the
 * contract), one key per attempt reused across retries, duplicate-press
 * suppression, full error-code handling, journey persistence limited to the
 * resume minimum, and the never-auto-mint guarantee (a response naming a
 * different attempt is refused, never adopted).
 */

import { createTidepoolRail, tpBuildQuoteBody, tpParseQuote, tpErrorMessage } from "../tidepool.js";

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

const quoteBody = (intentOver = {}) => ({
  ok: true, reused: false,
  intent: {
    intentId: INTENT_ID, linkId: LINK_ID, status: "AWAITING_DEPOSIT",
    depositAddress: "dep.tidepool.testnet", depositMemo: "memo42",
    source: { assetId: "nep141:usdc.eth", blockchain: "ethereum", symbol: "USDC", decimals: 6 },
    destination: { assetId: "nep141:usdc.tidepool-sandbox.testnet", blockchain: "near", symbol: "USDC", decimals: 6 },
    merchant: "shop.testnet",
    invoiceAmount: "1000000", expectedInputAmount: "10050000", minInputAmount: "10000000",
    expectedOutputAmount: "1000000",
    quoteDeadline: new Date(Date.now() + 900000).toISOString(),
    correlationId: "CORR-SECRET", signature: "SIG-SECRET",
    tidepoolStatus: "PENDING_DEPOSIT",
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
    ...intentOver,
  },
  onChainStatus: "OPEN",
});

function fakeEl() {
  return { innerHTML: "", addEventListener() {}, querySelector() { return null; }, contains() { return false; } };
}
function fakeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    const call = { url: u, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = routes.find((x) => u.includes(x.match));
    if (!r) throw new Error(`no route for ${u}`);
    const out = typeof r.res === "function" ? r.res(call) : r.res;
    if (out instanceof Promise) return out;
    return out;
  };
  fn.calls = calls;
  return fn;
}

/* Fresh rail: discovery resolved, form set, quote response scripted. */
async function fresh(quoteRes) {
  const el = fakeEl();
  const store = fakeStore();
  let qRes = quoteRes || res(201, quoteBody());
  const fetchImpl = makeFetch([
    { match: "/networks", res: res(200, NETS) },
    { match: "/quote", res: () => (typeof qRes === "function" ? qRes() : qRes) },
  ]);
  const seen = { stale: 0, verified: 0 };
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => store,
    schedule: () => 1, unschedule: () => {},
    onInvoiceStale: () => { seen.stale++; },
    onVerified: () => { seen.verified++; },
    onActionsChanged: () => {},
  });
  rail.init({ endpoint: ENDPOINT });
  await rail.sync(LINK, CTX);
  await flush();
  rail.toggle();
  rail.setForm({ blockchain: "ethereum", assetId: "nep141:usdc.eth", refundTo: "alice.testnet" });
  return { rail, el, store, fetchImpl, seen, setQuote: (r) => { qRes = r; } };
}

/* ── pure: request body ── */

{
  const b = tpBuildQuoteBody({ linkId: LINK_ID, assetId: "a", blockchain: "ethereum", refundTo: "alice.testnet", idempotencyKey: "ik_1" });
  ok(JSON.stringify(Object.keys(b).sort()) === JSON.stringify(["assetId", "blockchain", "idempotencyKey", "linkId", "refundTo"]),
    "body carries exactly the four routing fields + idempotencyKey");
  ok(!("amount" in b) && !("invoiceAmount" in b) && !("price" in b), "NO amount field — the backend reads the invoice from the contract");
  const b2 = tpBuildQuoteBody({ linkId: LINK_ID, assetId: "a", blockchain: "ethereum", refundTo: "alice.testnet" });
  ok(!("idempotencyKey" in b2), "key omitted when absent (never null)");
}

/* ── pure: response parsing ── */

{
  ok(!!tpParseQuote(quoteBody()), "valid quote parses");
  ok(tpParseQuote(quoteBody()) !== null && !("correlationId" in tpParseQuote(quoteBody())), "correlationId never survives parsing");
  ok(!("signature" in tpParseQuote(quoteBody())), "signature never survives parsing");
  ok(tpParseQuote({ ok: true, intent: { intentId: "bogus" } }) === null, "bad intentId rejects");
  ok(tpParseQuote({ ok: false, intent: {} }) === null, "ok:false rejects");
  ok(tpParseQuote(null) === null && tpParseQuote([]) === null, "null / array reject");
  const missing = quoteBody();
  delete missing.intent.depositAddress;
  ok(tpParseQuote(missing) === null, "missing depositAddress rejects the quote");
  ok(tpErrorMessage({ code: "invoice_expired", error: "Invoice has expired" }).hint.includes("new link"),
    "known code gets its guidance hint");
}

/* ── rail: happy path ── */

{
  const { rail, el, store, fetchImpl } = await fresh();
  await rail.quote();
  const qCalls = fetchImpl.calls.filter((c) => c.url.includes("/quote"));
  ok(qCalls.length === 1, "one quote request for one press");
  ok(qCalls[0].method === "POST" && qCalls[0].url.includes("/quote"), "POST /quote against the Worker only");
  const body = qCalls[0].body;
  ok(Object.keys(body).sort().join(",") === "assetId,blockchain,idempotencyKey,linkId,refundTo",
    "wire body is the exact five fields");
  ok(!("amount" in body), "wire body has no amount");
  ok(/^ik_[0-9a-f]{32}$/.test(body.idempotencyKey), "idempotency key is ik_ + 32 hex");
  ok(body.refundTo === "alice.testnet" && body.linkId === LINK_ID, "routing fields passed through");

  const snap = rail.snapshot();
  ok(snap.journey && snap.journey.intentId === INTENT_ID, "journey recorded after success");
  ok(snap.status && snap.status.status === "AWAITING_DEPOSIT", "status seeded from the quote");
  ok(snap.idemKey === null, "key discarded once the attempt landed");
  ok(snap.block === "active", "an open attempt gates the pay buttons");

  const stored = JSON.parse(store.getItem("paylink:tp-journey:v1"));
  ok(JSON.stringify(Object.keys(stored).sort()) === JSON.stringify(["assetId", "at", "blockchain", "intentId", "linkId", "refundTo"]),
    "storage holds ONLY the resume minimum");
  ok(!("depositAddress" in stored) && !("intent" in stored), "no deposit instructions in browser storage");
  ok(el.innerHTML.includes("Waiting for your deposit"), "progress panel renders the state");
  ok(rail.toggleHtml() === "", "toggle hidden while the attempt is active");
  ok(rail.blockHtml().includes("in progress"), "blocked actions point at the panel");
}

/* ── rail: retry reuses the SAME idempotency key ── */

{
  const { rail, fetchImpl, setQuote } = await fresh(res(502, { error: "Tidepool quote failed", code: "quote_failed" }));
  await rail.quote();
  const first = fetchImpl.calls.filter((c) => c.url.includes("/quote"))[0].body.idempotencyKey;
  ok(rail.snapshot().quoteErr !== null && rail.el === undefined, "first failure recorded");
  ok(rail.snapshot().idemKey === first, "failed attempt keeps its key");
  ok(fetchImpl.calls.filter((c) => c.url.includes("/quote"))[0] !== undefined, "failure happened");

  setQuote(res(201, quoteBody()));
  await rail.quote();
  const q = fetchImpl.calls.filter((c) => c.url.includes("/quote"));
  ok(q.length === 2, "retry issued a second request");
  ok(q[1].body.idempotencyKey === first, "retry REUSES the same idempotency key — no second intent can be minted");
  ok(rail.snapshot().journey !== null, "retry succeeds and records the journey");
}

/* ── rail: duplicate press ── */

{
  const { rail, fetchImpl } = await fresh();
  const p1 = rail.quote();
  const p2 = rail.quote();
  await Promise.all([p1, p2]);
  ok(fetchImpl.calls.filter((c) => c.url.includes("/quote")).length === 1, "double press issues ONE request");
}

/* ── rail: validation refuses bad input without a request ── */

{
  const { rail, fetchImpl, el } = await fresh();
  rail.setForm({ refundTo: "NOT AN ADDRESS!!" });
  await rail.quote();
  ok(fetchImpl.calls.filter((c) => c.url.includes("/quote")).length === 0, "invalid refund address → no request");
  ok(el.innerHTML.includes("NEAR account"), "inline validation message rendered");
  ok(rail.snapshot().journey === null, "no journey without a quote");
}

/* ── rail: error codes ── */

{
  const { rail, el, seen } = await fresh(res(409, { error: "Invoice has expired", code: "invoice_expired" }));
  await rail.quote();
  ok(el.innerHTML.includes("Invoice has expired"), "backend's own words shown");
  ok(el.innerHTML.includes("ask the payee for a new link"), "guidance hint appended");
  ok(seen.stale === 1, "invoice change notifies the card to re-read contract truth");
}

{
  const { rail, el, seen } = await fresh(res(409, { error: "Payment settled externally; awaiting verification", code: "payment_settled" }));
  await rail.quote();
  ok(el.innerHTML.includes("do not pay again"), "payment_settled never encourages another payment");
  ok(seen.stale === 1 && rail.snapshot().journey === null, "no journey minted; card re-reads");
}

{
  const { rail, el } = await fresh(res(503, { error: "Cooling down", code: "reconcile_cooldown", retryAfterSec: 7 }));
  await rail.quote();
  ok(el.innerHTML.includes("Try again in 7s."), "503 cooldown surfaces retryAfterSec");
}

{
  const { rail, el } = await fresh(res(400, { error: "assetId is not supported by Tidepool right now", code: "asset_unsupported" }));
  await rail.quote();
  ok(el.innerHTML.includes("pick another one"), "unsupported asset gets combination guidance");
}

{
  const { rail, el } = await fresh(res(201, { ok: true, intent: { intentId: "bogus" } }));
  await rail.quote();
  ok(el.innerHTML.includes("unexpected response"), "malformed 201 → bad shape, not a journey");
  ok(rail.snapshot().journey === null, "malformed 201 records no journey");
}

{
  const { rail } = await fresh(() => Promise.reject(new Error("net down")));
  await rail.quote();
  const snap = rail.snapshot();
  ok(snap.quoteErr && snap.quoteErr.code === "network", "network failure classified as network");
  ok(snap.quoteErr.hint.includes("no duplicate payment intent"), "network hint promises key reuse");
  ok(snap.idemKey !== null, "network failure keeps the key for the retry");
}

/* ── never auto-mint: a response naming a different attempt is refused ── */

{
  const { rail, el, store } = await fresh(res(201, quoteBody({ intentId: "pi_ffffffffffffffff" })));
  await rail.quote({ expectIntentId: INTENT_ID });
  const snap = rail.snapshot();
  ok(snap.journey === null, "mismatched attempt is never adopted");
  ok(el.innerHTML.includes("different payment attempt"), "the refusal is explained on screen");
  ok(store.getItem("paylink:tp-journey:v1") === null, "nothing persisted for the refused response");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
