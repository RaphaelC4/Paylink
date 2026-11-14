/* Creator cancellation tests — run with: node frontend/test/cancel.test.mjs
 *
 * Source-level regression tests for the cancellation contract (L-03):
 * cancel belongs to the creator alone, only while the invoice holds no
 * money, it is irreversible, and after it the app must treat the invoice
 * as dead on every surface — while a cross-chain attempt still in flight
 * keeps its state visible (warn, never block) and the payment flow and
 * 99.5% / 0.5% economics stay untouched. The flows are sliced out of
 * app.js and asserted directly — no browser needed.
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const htmlSrc = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cssSrc = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/* ── slices ── */
const timeline = src.slice(src.indexOf("function timeline("), src.indexOf("function payError("));
const ready = src.slice(src.indexOf("async function renderReady("), src.indexOf("cross-chain settlement visibility"));
const rpa = src.slice(src.indexOf("function renderPayActions("), src.indexOf("async function payLink("));
const helpers = src.slice(src.indexOf("const cancelButtonHtml"), src.indexOf("async function renderReady("));
const arm = src.slice(src.indexOf("async function armCancel("), src.indexOf("async function cancelLink("));
const cancel = src.slice(src.indexOf("async function cancelLink("), src.indexOf("faucet + swap (Tidepool)"));
const settle = src.slice(src.indexOf("function settlementHtml("), src.indexOf("async function paintSettlement("));

ok(timeline.length > 50 && ready.length > 500 && rpa.length > 1000 &&
   helpers.length > 100 && arm.length > 200 && cancel.length > 800 && settle.length > 200,
  "every cancellation slice found in app.js");

/* ── 1. status plumbing: the chain state flows through every surface ── */

ok(src.includes('CANCELLED: "pill cancelled"'), "STATUS_PILL knows CANCELLED");
ok(timeline.includes('st === "CANCELLED"'), "timeline has a CANCELLED branch");
ok(timeline.includes("Cancelled &mdash; the contract refuses payment"),
  "the cancelled timeline says the contract refuses payment");
ok(src.includes('cancelled: { label: "cancelled"'), "the ledger filter knows cancelled");
ok(src.includes("cancelled: 0") && /st === "CANCELLED"\) counts\.cancelled\+\+;/.test(src),
  "cancelled links are counted in their own bucket");
ok(src.indexOf('st === "CANCELLED") counts.cancelled++') < src.indexOf("counts.paid++"),
  "cancelled is counted BEFORE the paid fallthrough (never as paid)");
ok(src.indexOf('counts.cancelled++') > 0 && src.slice(src.indexOf('counts.cancelled++'), src.indexOf('counts.cancelled++') + 120)
    .indexOf("awaiting +=") === -1,
  "cancelled never adds to the awaiting-payment total");
ok(htmlSrc.includes('data-filter="cancelled"') && htmlSrc.includes('data-f="cancelled"'),
  "index.html carries the Cancelled filter chip with its count slot");
ok(cssSrc.includes(".pill.cancelled"), "styles.css styles the cancelled pill");

/* ── 2. the two creator homes carry the button — and only the creator ── */

ok(ready.includes("cancelSlotHtml(link.link_id)"), "the ready card carries the cancel slot");
ok(ready.includes('st === "OPEN" || st === "EXPIRED"'),
  "the ready card offers cancel only while the invoice holds no money (OPEN or EXPIRED)");
ok((rpa.match(/cancelSlotHtml\(link\.link_id\)/g) || []).length === 2,
  "the pay page offers cancel in exactly two places: creator view of OPEN, and creator view of EXPIRED");

const mineBranch = rpa.slice(rpa.indexOf("if (mine) {"), rpa.indexOf("/* Phase 7"));
ok(mineBranch.includes("cancelSlotHtml(link.link_id)"),
  "the creator's own unpaid-link view carries the cancel slot");

const payerBranch = rpa.slice(rpa.indexOf("/* Phase 7"), rpa.indexOf('if (st === "PAID")'));
ok(!payerBranch.includes("cancelSlotHtml") && !payerBranch.includes("data-cancel"),
  "a payer is never offered cancel — it is the creator's action alone");

const releaseBranch = rpa.slice(rpa.indexOf('if (st === "PAID")'), rpa.indexOf('if (st === "CANCELLED")'));
ok(!releaseBranch.includes("cancelSlotHtml"),
  "PAID and CLAIMED carry no cancel button — only an unpaid invoice is cancellable");

/* ── 3. a cancelled invoice is dead on every pay-page surface ── */

const cancelledBranch = rpa.slice(rpa.indexOf('if (st === "CANCELLED")'), rpa.indexOf("This link expired"));
ok(cancelledBranch.includes('"CANCELLED"') && cancelledBranch.includes("refuses payment"),
  "the pay actions say the link was cancelled and refuses payment");
ok(!cancelledBranch.includes("data-pay") && !cancelledBranch.includes("data-claim"),
  "no Pay and no Release button can ever render for a cancelled link");
ok(cancelledBranch.includes("tpPayBlockReason()") && cancelledBranch.includes("tpPayBlockHtml()"),
  "an in-flight cross-chain attempt keeps its own state line above the cancelled note");
ok(cancelledBranch.includes("fundRail") && cancelledBranch.includes("fundPollTimer"),
  "the payer's fund rail is torn down with the cancelled state");
ok(src.includes("This link is ${statusOf(link)}, not open"),
  "a stale Pay button is refused with words before any wallet prompt");
ok(!src.toLowerCase().includes("uncancel") && !src.includes("restore_link"),
  "cancellation is irreversible: nothing in the app can lift it");

/* ── 4. settlement block: cancelled rides along as honest state ── */

ok(settle.includes('onChain === "CANCELLED"'), "the settlement block renders a cancelled invoice");
ok(settle.includes("CANCELLED</strong> on chain"), "…and says so on the card");
ok(settle.includes("already settled to the payee"),
  "a verified attempt on a cancelled invoice states the money already settled once");

/* ── 5. two-step: arm warns, only the confirm button signs ── */

ok(helpers.includes('data-cancel="${esc(linkId)}"'), "the cancel button marks itself for arming");
ok(helpers.includes('data-cancel-slot="${esc(linkId)}"'), "every cancel home is a stable slot");
ok(helpers.includes("this cannot be undone"), "the confirm step says it is irreversible");
ok(helpers.includes('data-cancel-go="${esc(linkId)}"') && helpers.includes('data-cancel-back="${esc(linkId)}"'),
  "the confirm step has exactly two exits: confirm or stand down");
ok(arm.includes("getSettlement(linkId)"), "arming reads the settlement record first");
ok(arm.includes("TP_TERMINAL.has(s.status)"),
  "arming checks whether the attempt is still running (non-terminal)");
ok(arm.includes("does not stop it") && arm.includes("no money is lost either way"),
  "an in-flight attempt is WARNED about, with the no-money-lost fact spelled out");
ok(arm.includes("cancelConfirmHtml(linkId, warn)"), "arming lands on the confirm state");
ok(!arm.includes("callViaRelayer(") && !arm.includes("await call(") &&
   !arm.includes("signAndSendTransaction") && !arm.includes("signDelegateActions"),
  "arming NEVER signs anything — step one is read-only");
ok(src.includes("armCancel(cancelArm)"), "the document handler wires data-cancel to armCancel");
ok(src.includes("cancelLink(cancelGo.dataset.cancelGo"), "data-cancel-go is the only submit path");
ok(src.includes("cancelButtonHtml(cancelBack.dataset.cancelBack)"),
  "Never mind stands down in place, back to the plain button");

/* ── 6. submit re-reads the chain: creator + unpaid, proven fresh ── */

ok(cancel.includes("await V.getLink(linkId)"),
  "submit re-reads the chain — the button's state is never trusted");
ok(cancel.includes("link.creator !== accountId"),
  "only the creator can cancel (re-proven on the fresh read)");
ok(cancel.includes('st !== "OPEN" && st !== "EXPIRED"'),
  "only an unpaid invoice is cancellable — OPEN or EXPIRED, never PAID/CLAIMED/CANCELLED");
ok(cancel.includes("connectWallet()"), "a wallet is required before anything is attempted");

/* ── 7. relayer first, direct only as the documented alternatives ── */

const relayerCall = 'callViaRelayer("cancel_link", { link_id: linkId }, { deposit: "0" })';
const directCalls = cancel.match(/call\("cancel_link", \{ link_id: linkId \}, \{ deposit: "0" \}\)/g) || [];
ok(cancel.includes(relayerCall), "the relayer path submits cancel_link with exactly 0 yocto");
ok(directCalls.length === 2,
  "two direct variants (wallet without delegate signing, no relayer) — both 0 yocto");
ok(cancel.indexOf(relayerCall) < cancel.indexOf(directCalls[0] || "@never"),
  "relayer is checked FIRST; direct only when the relayer cannot be used");
ok(!cancel.includes("CREATE_STAKE"), "cancel attaches no stake — it never touches the registration deposit");
ok(cancel.includes('relayerEligibility(relayerErr) === "declined"'),
  "a 4xx decline is final — nothing was broadcast, no silent retry");
ok(cancel.includes("statusOf(fresh) === \"CANCELLED\""),
  "an unconfirmed reply is resolved against the chain (landed-but-reply-lost is a success)");

/* ── 8. economics and the settlement gate stay exactly as they were ── */

ok(!cancel.includes("feeBps") && !cancel.includes("payoutOf"),
  "the cancel flow never touches the 99.5% / 0.5% fee economics");
ok(!cancel.includes("TP_TERMINAL") && !cancel.includes("getSettlement"),
  "submit is never gated on the attempt state — warn at arm time, allow at submit (design decision)");
ok(!cancel.includes(".signAndSendTransaction(") && !cancel.includes(".signDelegateActions({"),
  "wallet signing only ever happens inside call / callViaRelayer");
ok(cancel.includes('typeof relayerWallet.signDelegateActions === "function"'),
  "delegates are only capability-checked — direct runs when the wallet cannot sign them");
ok((cancel.match(/await callViaRelayer\(/g) || []).length === 1 &&
   (cancel.match(/await call\(/g) || []).length === 2,
  "one relayer site + two direct sites, if/else — exactly one signature per attempt");

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
