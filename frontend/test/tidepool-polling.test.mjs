/* Polling tests — run with: node frontend/test/tidepool-polling.test.mjs
 *
 * Phase 7 §responsible polling: the pure planner (tpNextPoll) and the
 * engine against scripted fetches — Paylink Worker only, ≥2 s floor,
 * Retry-After / retryAfterSec honoured, no overlapping reads, pause when
 * hidden or off the pay panel, resume safely, stop on terminal, continue
 * through SETTLED, network errors are retries (never failures), and a
 * missing attempt is dropped rather than guessed at.
 */

import { createTidepoolRail, tpNextPoll, TP_POLL } from "../tidepool.js";

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
    quoteDeadline: null, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:01:00Z",
  },
  onChainStatus: extra.onChainStatus ?? "OPEN",
  conflict: null,
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
function defer() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/* Scripted fetch: /networks and /quote answer immediately; /status runs
   through the mutable status handler. */
async function quoted(opts = {}) {
  const el = fakeEl();
  const store = fakeStore();
  const timers = fakeTimers();
  let statusHandler = opts.statusHandler || (async () => res(200, statusBody("AWAITING_DEPOSIT")));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || "GET" });
    if (u.includes("/networks")) return res(200, NETS);
    if (u.includes("/quote")) return res(201, quoteBody());
    if (u.includes("/status")) return statusHandler(u);
    throw new Error(`unexpected request: ${u}`);
  };
  const seen = { verified: 0, stale: 0 };
  const state = { visible: opts.visible ?? true, active: opts.active ?? true };
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => store,
    schedule: timers.schedule, unschedule: timers.unschedule,
    isVisible: () => state.visible, isActive: () => state.active,
    onVerified: () => { seen.verified++; },
    onInvoiceStale: () => { seen.stale++; },
    onActionsChanged: () => {},
  });
  rail.init({ endpoint: ENDPOINT });
  await rail.sync(LINK, CTX);
  await flush();
  rail.setForm({ blockchain: "ethereum", assetId: "nep141:usdc.eth", refundTo: "alice.testnet" });
  await rail.quote();
  const statusCalls = () => calls.filter((c) => c.url.includes("/status")).length;
  return { rail, el, store, timers, calls, statusCalls, seen, state,
           setStatus: (h) => { statusHandler = h; } };
}

/* ── the pure planner ── */

{
  const base = { active: true, visible: true };
  for (const t of ["VERIFIED", "EXPIRED", "REFUNDED", "FAILED"]) {
    ok(tpNextPoll({ ...base, status: t }) === null, `${t} is terminal → no next poll`);
  }
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", visible: false }) === null, "hidden page → paused (null)");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", active: false }) === null, "inactive view → paused (null)");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT" }) === TP_POLL.BASE, "steady cadence is the base delay");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", retryAfterSec: 9 }) === 9000, "retryAfterSec honoured verbatim");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", retryAfterSec: 0 }) === TP_POLL.FLOOR,
    "stated delay never undercuts the 2 s floor");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", retryAfterSec: 7200 }) === TP_POLL.MAX_WAIT,
    "cooldown clamped to one hour");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", errCount: 1 }) === 3000, "error backoff step 1");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", errCount: 3 }) === 12000, "error backoff doubles");
  ok(tpNextPoll({ ...base, status: "AWAITING_DEPOSIT", errCount: 9 }) === TP_POLL.ERR_CAP, "error backoff capped");
  ok(tpNextPoll({ ...base, status: "SETTLED" }) === TP_POLL.SETTLED, "SETTLED keeps polling at the verification cadence");
  ok(tpNextPoll({ ...base, status: "RECONCILE" }) === TP_POLL.SLOW && tpNextPoll({ ...base, status: "UNKNOWN" }) === TP_POLL.SLOW,
    "uncertain states poll slowly, but keep polling");
  ok(tpNextPoll(null) === undefined || tpNextPoll(null) === null, "no argument → no poll");
}

/* ── engine: cadence after each state ── */

{
  const a = await quoted();
  ok(a.timers.nextDelay() === 0, "the first status read is immediate after a quote");
  await a.timers.runNext();
  ok(a.timers.nextDelay() === TP_POLL.BASE, "pending deposit → base cadence");
  a.setStatus(async () => res(200, statusBody("SETTLED")));
  await a.timers.runNext();
  ok(a.timers.nextDelay() === TP_POLL.SETTLED, "SETTLED reschedules (verification continues)");
  a.setStatus(async () => res(200, statusBody("DEPOSIT_SEEN")));
  await a.timers.runNext();
  ok(a.timers.nextDelay() === TP_POLL.BASE, "back to base cadence after SETTLED→DEPOSIT_SEEN read");
}

/* ── engine: no overlapping reads ── */

{
  const d = defer();
  const a = await quoted({ statusHandler: () => d.promise });
  const running = a.timers.runNext(); // tick starts, fetch hangs
  await flush();
  ok(a.rail.snapshot().inFlight === true, "read marked in flight while pending");
  a.rail.recheck();
  ok(a.timers.pending.size === 0, "recheck during an in-flight read schedules NOTHING (no overlap)");
  d.resolve(res(200, statusBody("AWAITING_DEPOSIT")));
  await running;
  ok(a.statusCalls() === 1, "exactly one status read for that cycle");
  ok(a.timers.pending.size === 1, "the loop reschedules after the read lands");
}

/* ── engine: network error is a retry, never a failure ── */

{
  let fail = true;
  const a = await quoted({ statusHandler: async () => {
    if (fail) throw new Error("net down");
    return res(200, statusBody("AWAITING_DEPOSIT"));
  } });
  await a.timers.runNext();
  const snap = a.rail.snapshot();
  ok(snap.errCount === 1 && snap.journey !== null, "network error: journey kept, error counted");
  ok(snap.lastStatusMsg && snap.lastStatusMsg.message.includes("Could not reach"), "network error explained, not fatal");
  ok(a.el.innerHTML.includes("Retrying automatically"), "payer told it retries by itself");
  ok(a.timers.nextDelay() === 3000, "backoff scheduled");
  fail = false;
  await a.timers.runNext();
  ok(a.rail.snapshot().errCount === 0 && a.rail.snapshot().lastStatusMsg === null, "recovery clears the error state");
}

/* ── engine: pause when hidden, resume on demand ── */

{
  const a = await quoted({ visible: false });
  ok(a.timers.pending.size === 0, "hidden page never schedules a read");
  a.state.visible = true;
  a.rail.recheck();
  ok(a.timers.pending.size === 1, "becoming visible arms the loop again");
  await a.timers.runNext();
  ok(a.statusCalls() >= 1, "reads resume after visibility returns");
}

/* ── engine: off the pay panel pauses; re-sync resumes ── */

{
  const a = await quoted({ active: false });
  ok(a.timers.pending.size === 0, "off-panel view never schedules a read");
  a.state.active = true;
  await a.rail.sync(LINK, CTX); // the card re-render that brings the payer back
  await flush();
  ok(a.timers.pending.size === 1, "returning to the pay panel resumes via sync");
  ok(a.timers.nextDelay() === TP_POLL.BASE, "resume uses the planner's cadence, not a burst");
}

/* ── engine: Retry-After header on any response ── */

{
  const a = await quoted({ statusHandler: async () =>
    res(429, { error: "slow down", code: "status_unknown" }, { "Retry-After": "6" }) });
  await a.timers.runNext();
  ok(a.rail.snapshot().retryAfterSec === 6, "Retry-After header parsed when the body has none");
  ok(a.timers.nextDelay() === 6000, "header delay scheduled");
}

/* ── engine: missing attempt → drop, never guess ── */

{
  const a = await quoted({ statusHandler: async () =>
    res(404, { error: "Payment intent not found", code: "intent_not_found" }) });
  await a.timers.runNext();
  ok(a.rail.snapshot().journey === null, "404 intent_not_found drops the local journey");
  ok(a.store.getItem("paylink:tp-journey:v1") === null, "storage cleared with it");
  ok(a.timers.pending.size === 0, "polling stops with the journey");
  ok(a.el.innerHTML.includes("start again"), "the payer is told to start again");
}

/* ── engine: bad ids in a 200 response are not believed ── */

{
  const a = await quoted({ statusHandler: async () => res(200, {
    ok: true,
    intent: { intentId: "pi_abcdef0123456789", linkId: LINK_ID, status: "VERIFIED" },
    onChainStatus: "OPEN", conflict: null, changed: false,
  }) });
  await a.timers.runNext();
  ok(a.rail.snapshot().journey !== null, "a status for a DIFFERENT attempt is refused");
  ok(a.rail.snapshot().status.status !== "VERIFIED", "refused response cannot mark the payment verified");
  ok(a.rail.snapshot().errCount === 1 && a.timers.pending.size === 1, "refusal becomes a backed-off retry");
}

/* ── every request went to the Worker, never Tidepool ── */

{
  const a = await quoted();
  await a.timers.runNext(); // the first status read
  ok(a.calls.every((c) => c.url.startsWith(ENDPOINT)), "every request targets the Paylink Worker endpoint");
  ok(a.calls.some((c) => c.url.includes("/status?linkId=demo-004&id=")), "status carries both validated ids");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
