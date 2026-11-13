/* Status tests — run with: node frontend/test/tidepool-status.test.mjs
 *
 * Phase 7 §status: all 12 intent states render their fixed presentation
 * labels with the right tone — only VERIFIED ever gets the success styling,
 * SETTLED stays "awaiting verification", UNKNOWN/RECONCILE/conflict never
 * read as success — plus upstream detail lines, conflict banners, cooldown
 * text, and the VERIFIED receipt that notifies the app exactly once.
 */

import { createTidepoolRail, TP_STATES, TP_TERMINAL, tpParseStatus, tpStateView, tpConflictText } from "../tidepool.js";

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

const quoteBody = () => ({
  ok: true, reused: false,
  intent: {
    intentId: INTENT_ID, linkId: LINK_ID, status: "AWAITING_DEPOSIT",
    depositAddress: "dep.tidepool.testnet", depositMemo: null,
    source: { assetId: "nep141:usdc.eth", blockchain: "ethereum", symbol: "USDC", decimals: 6 },
    destination: { assetId: "nep141:usdc.tidepool-sandbox.testnet", blockchain: "near", symbol: "USDC", decimals: 6 },
    merchant: "shop.testnet",
    invoiceAmount: "1000000", expectedInputAmount: "10050000", minInputAmount: "10000000",
    expectedOutputAmount: "1000000",
    quoteDeadline: new Date(Date.now() + 900000).toISOString(),
    tidepoolStatus: "PENDING_DEPOSIT",
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
  },
  onChainStatus: "OPEN",
});

const statusBody = (status, extra = {}) => ({
  ok: true,
  intent: {
    intentId: INTENT_ID, linkId: LINK_ID, status,
    tidepoolStatus: extra.tidepoolStatus ?? null,
    quoteDeadline: extra.quoteDeadline ?? null,
    lastReason: "SECRET-REASON-NEVER-SHOWN",
    createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:01:00Z",
  },
  onChainStatus: extra.onChainStatus ?? "OPEN",
  conflict: extra.conflict ?? null,
  changed: false,
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

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || "GET" });
    const r = routes.find((x) => u.includes(x.match));
    if (!r) throw new Error(`no route for ${u}`);
    return typeof r.res === "function" ? r.res() : r.res;
  };
  fn.calls = calls;
  return fn;
}

/* Quoted journey + scripted status response, then one status tick. */
async function railAtStatus(status, extra = {}) {
  const el = fakeEl();
  const store = fakeStore();
  const timers = fakeTimers();
  let sRes = res(200, statusBody(status, extra));
  const fetchImpl = makeFetch([
    { match: "/networks", res: res(200, NETS) },
    { match: "/quote", res: res(201, quoteBody()) },
    { match: "/status", res: () => sRes },
  ]);
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
  await rail.quote();
  await timers.runNext(); // the immediate status read
  return { rail, el, store, timers, fetchImpl, seen, setStatus: (r) => { sRes = r; } };
}

/* ── pure: the 12 states and their fixed labels ── */

const LABELS = {
  CREATING: "Preparing payment",
  QUOTE_ISSUED: "Quote ready",
  AWAITING_DEPOSIT: "Waiting for your deposit",
  DEPOSIT_SEEN: "Deposit seen",
  SETTLING: "Converting",
  SETTLED: "Converted — awaiting verification",
  VERIFIED: "Payment verified",
  EXPIRED: "Quote expired",
  REFUNDED: "Refunded",
  FAILED: "Failed",
  UNKNOWN: "Status unavailable",
  RECONCILE: "Under review",
};

ok(Object.keys(TP_STATES).length === 12, "exactly 12 intent states");
for (const [state, label] of Object.entries(LABELS)) {
  ok(TP_STATES[state] && TP_STATES[state].label === label, `${state} label is "${label}"`);
  const v = tpStateView(state);
  ok(v.label === label && v.terminal === TP_TERMINAL.has(state), `${state} view carries label + terminal flag`);
}
ok(TP_STATES.VERIFIED.tone === "ok", "VERIFIED is the success tone");
ok(Object.entries(TP_STATES).filter(([, s]) => s.tone === "ok").length === 1,
  "VERIFIED is the ONLY state with the success tone");
ok(TP_STATES.SETTLED.tone !== "ok" && TP_STATES.UNKNOWN.tone !== "ok" && TP_STATES.RECONCILE.tone !== "ok",
  "SETTLED / UNKNOWN / RECONCILE are never styled as success");
ok(tpStateView("SOMETHING_ELSE").terminal === false && tpStateView("SOMETHING_ELSE").tone === "pending",
  "unrecognized state fails closed to non-final");

{
  const s = tpParseStatus(statusBody("SETTLED", { conflict: { kind: "invoice_paid" } }));
  ok(s && s.conflict.kind === "invoice_paid", "conflict parsed");
  ok(!("lastReason" in s), "lastReason never parsed into the view");
  ok(tpParseStatus({ ok: true, intent: { intentId: "x", linkId: "y", status: "A" } }) === null, "bad ids reject");
  ok(tpConflictText("invoice_paid").includes("Do not send another payment"), "conflict text refuses re-payment");
}

{
  /* Regression (Phase 8, found live): the Worker's statusBody sends conflict
     as a bare STRING kind ("invoice_paid" | null), not an object — if the
     parser only accepts the object form, every conflicted status response
     fails to parse and the browser loops on bad_shape forever. */
  const s = tpParseStatus(statusBody("AWAITING_DEPOSIT", { conflict: "invoice_paid" }));
  ok(s !== null && s.conflict !== null && s.conflict.kind === "invoice_paid",
    "real Worker string conflict parses (statusBody wire shape)");
  ok(tpConflictText(s.conflict.kind).includes("Do not send another payment"),
    "string conflict still renders the kind-specific warning");
  ok(tpParseStatus(statusBody("AWAITING_DEPOSIT", { conflict: 12 })) === null,
    "malformed conflict (number) fails closed");
  ok(tpParseStatus(statusBody("AWAITING_DEPOSIT", { conflict: ["invoice_paid"] })) === null,
    "malformed conflict (array) fails closed");
  ok(tpParseStatus(statusBody("AWAITING_DEPOSIT", { conflict: "" })) === null,
    "malformed conflict (empty string) fails closed");
}

/* ── rail: every state renders its label ── */

for (const [state, label] of Object.entries(LABELS)) {
  const { rail, el } = await railAtStatus(state);
  ok(el.innerHTML.includes(label), `${state} renders "${label}"`);
  if (state === "VERIFIED") ok(el.innerHTML.includes("tx-line ok"), "VERIFIED gets the success line");
  else ok(!el.innerHTML.includes("tx-line ok"), `${state} never gets the success line`);
  if (state !== "VERIFIED") ok(!el.innerHTML.includes("Payment verified"), `${state} never says "Payment verified"`);
}

/* ── SETTLED continues as a claim, not a success ── */

{
  const { rail, el, timers, fetchImpl } = await railAtStatus("SETTLED", { tidepoolStatus: "SUCCESS" });
  ok(el.innerHTML.includes("awaiting verification"), "SETTLED reads as awaiting verification");
  ok(el.innerHTML.includes("provider claim, not proof"), "SETTLED detail says the claim is not proof");
  ok(el.innerHTML.includes("Tidepool reports SUCCESS"), "upstream SUCCESS detail line shown");
  ok(timers.nextDelay() === 5000, "polling CONTINUES through SETTLED at the verification cadence");
  await timers.runNext();
  ok(fetchImpl.calls.filter((c) => c.url.includes("/status")).length === 2, "a second status read happened");
}

/* ── upstream detail for the four spec-named statuses ── */

for (const [tp, frag] of [["PENDING_DEPOSIT", "waiting for the deposit"], ["KNOWN_DEPOSIT_TX", "deposit transaction is known"],
                          ["INCOMPLETE_DEPOSIT", "deposit still completing"], ["PROCESSING", "processing the conversion"]]) {
  const { el } = await railAtStatus("DEPOSIT_SEEN", { tidepoolStatus: tp });
  ok(el.innerHTML.includes(frag), `tidepoolStatus ${tp} shows its detail line`);
}

/* ── conflict + invoice paid ── */

{
  const { rail, el, seen } = await railAtStatus("SETTLING", { conflict: { kind: "invoice_paid" }, onChainStatus: "PAID" });
  ok(el.innerHTML.includes("Do not send another payment"), "recorded conflict rendered as a warning");
  ok(seen.stale === 1, "invoice paid notifies the card once");
  await rail.sync(LINK, CTX);
  await flush();
  ok(seen.stale === 1, "notification is not repeated on re-sync");
  ok(rail.blockReason() === "conflict", "conflict gates the pay buttons");
  ok(rail.blockHtml().includes("already marked"), "block copy warns, never offers payment");
}

{
  /* invoice PAID under a non-terminal attempt, no recorded conflict */
  const { rail } = await railAtStatus("AWAITING_DEPOSIT", { onChainStatus: "PAID" });
  ok(rail.blockReason() === "conflict", "invoice paid under an open attempt → conflict, even without record conflict");
}

{
  /* Regression (Phase 8): full rail render with the Worker's REAL conflict
     wire shape — a bare string. Parses, renders the warning, gates the pay
     buttons, and never enters the bad_shape retry loop. */
  const { rail, el } = await railAtStatus("AWAITING_DEPOSIT", { conflict: "invoice_paid", onChainStatus: "PAID" });
  ok(el.innerHTML.includes("Do not send another payment"),
    "string conflict renders the kind-specific warning (no bad_shape loop)");
  ok(!el.innerHTML.includes("unexpected response"), "string conflict never shows the bad_shape error");
  ok(rail.blockReason() === "conflict", "string conflict gates the pay buttons");
}

/* ── status errors: retry text + cooldown ── */

{
  const { rail, el, timers, fetchImpl, setStatus } = await railAtStatus("AWAITING_DEPOSIT");
  setStatus(res(503, { error: "Status temporarily unknown", code: "status_unknown", retryAfterSec: 4 }));
  await timers.runNext();
  const snap = rail.snapshot();
  ok(snap.lastStatusMsg && snap.lastStatusMsg.message.includes("Status temporarily unknown"), "503 message shown");
  ok(el.innerHTML.includes("Retrying in 4s."), "retryAfterSec surfaced to the payer");
  ok(timers.nextDelay() === 4000, "next hop waits the full cooldown (≥ 2 s floor)");
  ok(snap.journey !== null, "a 503 is a retry, never a payment failure");
}

{
  /* stored-conflict hold must never auto-verify: 503 record_invalid */
  const { rail, timers, setStatus } = await railAtStatus("SETTLED");
  setStatus(res(503, { error: "Record needs reconciliation", code: "record_invalid", retryAfterSec: 30 }));
  await timers.runNext();
  ok(rail.snapshot().status.status === "SETTLED", "hold keeps the previous state, never VERIFIED");
  ok(timers.nextDelay() === 30000, "long cooldown honoured");
  ok(rail.snapshot().verifiedNotified === false, "no verification notification during a hold");
}

/* ── VERIFIED: receipt, one notification, polling stops ── */

{
  const { rail, el, timers, fetchImpl, seen, setStatus } = await railAtStatus("AWAITING_DEPOSIT");
  setStatus(res(200, statusBody("VERIFIED")));
  await timers.runNext();
  ok(el.innerHTML.includes("Payment verified"), "receipt rendered");
  ok(el.innerHTML.includes("authoritative NEAR transaction evidence"), "receipt names the evidence basis");
  ok(seen.verified === 1, "onVerified fired exactly once");
  ok(timers.pending.size === 0, "polling stops at the terminal state");
  ok(rail.blockReason() === "verified", "pay buttons gated after verification");
  ok(rail.blockHtml().includes("Nothing more to pay"), "block copy says nothing more to pay");
  await rail.sync(LINK, CTX);
  await flush();
  ok(fetchImpl.calls.filter((c) => c.url.includes("/status")).length === 2, "no further reads after VERIFIED");
  ok(seen.verified === 1, "re-sync does not re-notify");
}

/* ── unknown state stays non-final and keeps retrying ── */

{
  const { rail, timers, setStatus } = await railAtStatus("AWAITING_DEPOSIT");
  setStatus(res(200, statusBody("SOMETHING_ELSE")));
  await timers.runNext();
  const snap = rail.snapshot();
  ok(snap.status.status === "SOMETHING_ELSE" && !TP_TERMINAL.has("SOMETHING_ELSE"), "unrecognized state kept non-final");
  ok(timers.nextDelay() !== null, "polling continues on an unrecognized state");
  ok(rail.blockReason() === "active", "unrecognized state keeps the pay buttons gated");
}

/* ── terminal non-verified releases the gate ── */

for (const state of ["EXPIRED", "REFUNDED", "FAILED"]) {
  const { rail, timers } = await railAtStatus(state);
  ok(rail.blockReason() === null, `${state} releases the pay-button gate`);
  ok(timers.pending.size === 0, `${state} stops polling`);
}

/* ── CREATING: status-only, with a late start-over ── */

{
  let clock = 1000000;
  const el = fakeEl();
  const store = fakeStore();
  const t = fakeTimers();
  const fetchImpl = makeFetch([
    { match: "/networks", res: res(200, NETS) },
    { match: "/quote", res: res(201, { ...quoteBody(), intent: { ...quoteBody().intent, status: "CREATING" } }) },
    { match: "/status", res: res(200, statusBody("CREATING")) },
  ]);
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => store,
    schedule: t.schedule, unschedule: t.unschedule,
    now: () => clock, onActionsChanged: () => {},
  });
  rail.init({ endpoint: ENDPOINT });
  await rail.sync(LINK, CTX);
  await flush();
  rail.setForm({ blockchain: "ethereum", assetId: "nep141:usdc.eth", refundTo: "alice.testnet" });
  await rail.quote();
  await t.runNext();
  const quoteCalls = () => fetchImpl.calls.filter((c) => c.url.includes("/quote")).length;
  ok(rail.snapshot().status.status === "CREATING", "CREATING renders as status-only");
  ok(quoteCalls() === 1, "no automatic re-quote for CREATING (never auto-mint)");
  rail.restart();
  ok(rail.snapshot().journey !== null, "restart refused before 90 s of CREATING");
  ok(quoteCalls() === 1, "refused restart issued nothing");
  clock += 91000;
  rail.restart();
  ok(rail.snapshot().journey === null, "start over offered once CREATING ages past 90 s");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
