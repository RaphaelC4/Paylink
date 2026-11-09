/* One-approval flow tests — run with: node frontend/test/one-approval.test.mjs
 *
 * Source-level regression tests for the acceptance criterion: the payer
 * approves exactly ONE wallet transaction, and nothing in the pay flow can
 * ever prompt them again. The payment function is sliced out of app.js and
 * asserted against directly — no browser needed, and any future edit that
 * reintroduces a second payer signature fails here.
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");

const payStart = src.indexOf("async function payLink(");
const claimStart = src.indexOf("async function claimLink(");
ok(payStart >= 0, "payLink found");
ok(claimStart > payStart, "claimLink found after payLink");
const pay = src.slice(payStart, claimStart);

/* ── 1+2. one wallet approval, and it is only the payment ── */

const walletCalls = [...pay.matchAll(/await call\(/g)].length;
ok(walletCalls === 1, `pay flow issues exactly one wallet transaction (found ${walletCalls})`);
ok(pay.includes('call("ft_transfer_call"'), "that one transaction is the payment (ft_transfer_call)");
ok(!pay.includes('call("claim"'), "pay flow never calls claim — no second payer signature can be requested");
ok(!pay.includes("claimLink("), "pay flow never invokes claimLink (the auto-claim is gone)");
ok(!src.includes("auto: true"), "no auto-claim invocation left anywhere in the app");
ok(!src.includes("{ auto = false }"), "claimLink has no auto path to fall back to");

/* ── 3-6. the four status messages, spoken in order of the lifecycle ── */

ok(pay.includes("Your payment is being confirmed."), "payment-submitted message present");
ok(pay.includes("Payment confirmed! Your funds are being released automatically."), "payment-confirmed message present");
ok(pay.includes("Payment completed successfully. The recipient has received the funds."), "settlement-completed message present");
ok(pay.includes("Your payment is confirmed. Automatic settlement is in progress."), "settlement-pending message present");

/* ── it watches both transitions, is bounded, and stops on completion ── */

ok(pay.includes('st === "PAID" || st === "CLAIMED"'), "polls for the PAID transition after the payment tx");
ok(pay.includes('statusOf(fresh) === "CLAIMED"'), "polls for the PAID → CLAIMED transition");
ok(pay.includes("for (let i = 0; i < 10; i++)") && pay.includes("for (let i = 0; i < 60; i++)"),
  "both polling loops are bounded (no endless polling)");
ok(/Payment completed successfully[^;]*;\s*await renderPay\(linkId\);[\s\S]{0,120}return;/.test(pay),
  "settlement-completed path re-renders and stops the loop");
ok(!pay.includes("await call(") || walletCalls === 1, "watching never signs anything");

/* read failures during polling are swallowed, not thrown at the user */
ok((pay.match(/\.catch\(\(\) => null\)/g) || []).length >= 2, "poll reads tolerate network errors gracefully");

/* ── manual recovery is untouched (keeper-outage fallback) ── */

ok(src.includes("data-claim="), "Release button still rendered (manual recovery intact)");
ok(src.includes('call("claim", { link_id: linkId }'), "manual claim path intact for that button");
ok(/async function claimLink\(linkId\)/.test(src), "claimLink is manual-only");
ok(pay.includes("rememberPaid(linkId)"), "payer's local activity record still written after payment");
ok(pay.includes('show("ok", `Your payment is being confirmed.'), "tx hash link kept alongside the confirmation message");

/* ── no stale copy promising a second approval ── */

ok(!src.includes("Two approvals"), "stale 'Two approvals' copy removed");
ok(!src.includes("second approval"), "stale 'second approval' copy removed");
ok(src.includes("One approval"), "one-approval copy present on the pay card");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
