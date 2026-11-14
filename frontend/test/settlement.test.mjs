/* Settlement tests — run with: node frontend/test/settlement.test.mjs
 *
 * The invoice-viewer lookup: GET /status?linkId=… (NO capability id) →
 * tpParseSettlement's exact allowlist — deposit date, intent id, VERIFIED
 * payout hashes — fail closed on anything malformed, with capability-only
 * fields (deposit address, memo, refund, signature, upstream bodies) never
 * read even when a response carries them. Plus the app-side rendering
 * contract: invoice surfaces paint deposit date · intent id · explorer tx
 * links, keep the on-chain pill honestly OPEN, and prompt the payee to
 * cancel an OPEN invoice after a verified cross-chain settlement.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tpParseSettlement } from "../tidepool.js";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, "..", "app.js"), "utf8");
const htmlSrc = readFileSync(join(here, "..", "index.html"), "utf8");

const HASH = "9".repeat(44); // base58-shaped 32-byte NEAR tx hash
const INTENT = "pi_0123456789abcdef";
const DEPOSIT = "2026-11-13T18:45:44.194Z";
const VERIFIED_AT = "2026-11-13T18:50:04.749Z";

const good = (settlementOver = {}, bodyOver = {}) => ({
  ok: true,
  settlement: {
    intentId: INTENT,
    status: "VERIFIED",
    depositSeenAt: DEPOSIT,
    verifiedAt: VERIFIED_AT,
    payoutTx: [HASH],
    ...settlementOver,
  },
  onChainStatus: "OPEN",
  onChainStatusCheckedAt: VERIFIED_AT,
  ...bodyOver,
});

/* ── the parser: valid shapes ── */
{
  const s = tpParseSettlement(good());
  ok(!!s, "a valid settlement body parses");
  ok(s && s.intentId === INTENT && s.status === "VERIFIED", "intent id and status survive");
  ok(s && s.depositSeenAt === DEPOSIT && s.verifiedAt === VERIFIED_AT, "deposit + verified dates survive");
  ok(s && JSON.stringify(s.payoutTx) === JSON.stringify([HASH]), "payout hash survives");
  ok(s && s.onChainStatus === "OPEN", "on-chain status rides along");

  const nulls = tpParseSettlement(good({ depositSeenAt: null, verifiedAt: null, payoutTx: [] }));
  ok(nulls && nulls.depositSeenAt === null && nulls.verifiedAt === null && nulls.payoutTx.length === 0,
    "null dates and an empty hash list are legitimate (history trimmed / no deposit)");

  const noChain = tpParseSettlement({ ok: true, settlement: good().settlement });
  ok(noChain && noChain.onChainStatus === null, "onChainStatus absent -> parses with null");
}

/* ── the parser: fail closed on anything malformed ── */
{
  ok(tpParseSettlement(null) === null, "null body -> null");
  ok(tpParseSettlement("nope") === null, "string body -> null");
  ok(tpParseSettlement([good()]) === null, "array body -> null");
  ok(tpParseSettlement({ ok: false, settlement: good().settlement }) === null, "ok:false -> null");
  ok(tpParseSettlement({ ok: true }) === null, "missing settlement -> null");
  ok(tpParseSettlement({ ok: true, settlement: [good().settlement] }) === null, "settlement as array -> null");
  ok(tpParseSettlement(good({ intentId: "not-an-id" })) === null, "malformed intent id -> null");
  ok(tpParseSettlement(good({ status: 42 })) === null, "non-string status -> null");
  ok(tpParseSettlement(good({ depositSeenAt: "yesterday" })) === null, "non-ISO deposit date -> null");
  ok(tpParseSettlement(good({ verifiedAt: 1794591424074 })) === null, "numeric verified date -> null");
  ok(tpParseSettlement(good({ depositSeenAt: undefined })) === null, "missing deposit date key -> null");
  ok(tpParseSettlement(good({ payoutTx: HASH })) === null, "payoutTx not an array -> null");
  ok(tpParseSettlement(good({ payoutTx: ["0xdeadbeef"] })) === null, "non-base58 hash -> null");
  ok(tpParseSettlement(good({ payoutTx: ["9".repeat(99)] })) === null, "oversized hash -> null");
  ok(tpParseSettlement(good({ payoutTx: Array(9).fill(HASH) })) === null, "more than 8 hashes -> null");
  ok(tpParseSettlement(good({}, { onChainStatus: 7 })) === null, "non-string onChainStatus -> null");
}

/* ── the parser: capability-only fields are never read ── */
{
  const leaky = good(
    {
      depositAddress: "pa000001abab",
      depositMemo: "memo-12345",
      refundTo: "payer.testnet",
      signature: "ed25519:LEAK",
      correlationId: "cid-test-leak",
      swapDetails: { nearTxHashes: [HASH] },
      history: [{ to: "VERIFIED" }],
      lastReason: "payout_verified",
    },
    { intent: { intentId: INTENT }, conflict: null, changed: true }
  );
  const s = tpParseSettlement(leaky);
  const wire = JSON.stringify(s);
  ok(!!s, "a body carrying extra capability fields still parses the allowlist");
  ok(!wire.includes("depositAddress") && !wire.includes("depositMemo") &&
     !wire.includes("refundTo") && !wire.includes("ed25519") &&
     !wire.includes("correlationId") && !wire.includes("swapDetails") &&
     !wire.includes('"history"') && !wire.includes("lastReason") &&
     !wire.includes('"intent"') && !wire.includes("conflict"),
    "no capability-only field is copied into the parsed result");
  ok(JSON.stringify(Object.keys(s)) ===
     JSON.stringify(["intentId", "status", "depositSeenAt", "verifiedAt", "payoutTx", "onChainStatus"]),
    "parsed keys are exactly the allowlist");
}

/* ── the app: lookup wiring + rendering contract ── */
{
  ok(appSrc.includes("/status?linkId="), "app.js fetches the linkId-only settlement endpoint");
  ok(appSrc.includes("tpParseSettlement"), "app.js parses responses through the allowlist");
  ok(appSrc.includes("settlementCache"), "settlement lookups are cached (no request storm)");
  ok((appSrc.match(/id="settleBox"/g) || []).length >= 2,
    "both invoice surfaces (ready + pay card) carry the settleBox slot");
  ok(appSrc.includes("Paid via cross-chain"), "verified settlements render the paid-via-cross-chain headline");
  ok(appSrc.includes("Paid on both rails"), "both-rail settlements render the double-pay warning");
  ok(appSrc.includes("cancel it or let it expire"), "the payee is prompted to cancel an OPEN invoice");
  ok(appSrc.includes("/transactions/"), "payout hashes render as explorer transaction links");
  ok(appSrc.includes("deposit") && appSrc.includes("attempt") && appSrc.includes("payout tx"),
    "the block shows deposit date, intent id and payout tx rows");
  ok(appSrc.includes("pill xchain"), "ledger rows get the cross-chain chip");
  ok(appSrc.includes("paintLedgerSettlements"), "the ledger paints settlement chips after render");
  ok(appSrc.includes('title="invoice status on chain"') || appSrc.includes("invoice status on chain"),
    "the on-chain pill stays present and honestly labelled");
  ok(htmlSrc.includes("app.js?v=20261114a"), "index.html cache-busts the changed app.js");
  ok(appSrc.includes('tidepool.js?v=20261114a'), "app.js cache-busts the changed tidepool.js");
  ok(htmlSrc.includes("styles.css?v=20261114a"), "index.html cache-busts the changed styles.css");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
