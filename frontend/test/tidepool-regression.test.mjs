/* Regression guards — run with: node frontend/test/tidepool-regression.test.mjs
 *
 * Phase 7 §11: source-level assertions that the integration cannot silently
 * regress the NEAR one-approval flow, leak forbidden patterns into the
 * Tidepool module, or break the wiring app.js depends on. These read the
 * production files directly — no DOM, no network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

const app = read("app.js");
const tp = read("tidepool.js");
const cfg = read("config.js");
const html = read("index.html");
const css = read("styles.css");

/* ── NEAR one-approval flow untouched ── */

{
  /* renderPay ordering: discovery sync happens between the card paint and
     the action buttons, so the gate is decided before buttons lay out. */
  const pay = app.slice(app.indexOf("async function renderPay("), app.indexOf("function renderPayActions("));
  const iPaint = pay.indexOf("paintNgn(card, value)");
  const iSync = pay.indexOf("syncTidepool(link,");
  const iActions = pay.indexOf("renderPayActions(link, st)");
  ok(iPaint !== -1 && iSync !== -1 && iActions !== -1, "renderPay contains paint, sync and actions");
  ok(iPaint < iSync && iSync < iActions, "ordering: paint < syncTidepool < renderPayActions");

  const actions = app.slice(app.indexOf("function renderPayActions("), app.indexOf("function wireFundRail("));
  const pays = actions.match(/data-pay=/g) || [];
  ok(pays.length === 1, "exactly one data-pay button in renderPayActions");
  ok(actions.includes("One approval"), "'One approval' copy intact on the pay card");
  ok(actions.includes("data-wallet=\"connect\""), "connect-a-wallet branch intact");
  ok(actions.includes("Pay ${formatAmount(link.amount)}"), "NEAR pay button label intact");

  /* The block gate replaces the button area but never edits the NEAR
     button markup: the same template literal still exists below it. */
  const paySlice = app.slice(app.indexOf("const tpBlock = tpPayBlockReason();"));
  ok(paySlice.indexOf("tpPayBlockReason()") < paySlice.indexOf("data-pay="), "block gate runs before the pay button render");

  /* payLink / claimLink: no Tidepool coupling at all. */
  const payLinkFn = app.slice(app.indexOf("async function payLink("), app.indexOf("async function claimLink("));
  const cIdx = app.indexOf("async function claimLink(");
  const claimFn = app.slice(cIdx, app.indexOf("\n/* ", cIdx));
  ok(!/tidepool|tpToggle|syncTidepool/i.test(payLinkFn), "payLink has no tidepool references");
  ok(!/tidepool|tpToggle|syncTidepool/i.test(claimFn), "claimLink has no tidepool references");
  ok(app.includes("function rememberPaid(id)"), "rememberPaid (local history) still present");
}

/* ── module hygiene ── */

{
  ok(!/usetidepool/i.test(tp), "no stale usetidepool hook");
  ok(!/SWAP_SOURCES/.test(tp), "swap-funding vocabulary not imported into the rail");
  ok(!/localStorage/.test(tp), "no localStorage — journey is sessionStorage only");
  ok(!/\beval\(/.test(tp) && !/new Function/.test(tp), "no eval / new Function");
  ok(!/innerHTML\s*\+=/.test(tp), "no innerHTML += (whole-panel repaint only)");
  ok(!/document\.write/.test(tp), "no document.write");
  ok(!/\bsourceMappingURL/.test(tp), "no sourcemap references");

  /* No hardcoded chain slugs driving behavior: chain identity comes from
     /networks; the only literals are in example fixtures, which live in the
     test files, not here. */
  const chainLiterals = tp.match(/"(ethereum|bsc|polygon|arbitrum|base|solana)"/g) || [];
  ok(chainLiterals.length === 0, "no hardcoded chain slugs in the rail module");

  /* Only VERIFIED may carry the success tone. */
  const okTones = tp.match(/tone: "ok"/g) || [];
  ok(okTones.length === 1 && tp.includes("VERIFIED"), "exactly one success tone, and it is VERIFIED's");

  /* Quote body never carries an amount field. */
  ok(!/amount:/.test(tp.slice(tp.indexOf("function tpBuildQuoteBody("), tp.indexOf("function tpStateView("))),
    "tpBuildQuoteBody builds no amount field");

  /* Storage keys are exact. */
  ok(tp.includes('"paylink:tp-journey:v1"'), "journey storage key is the v1 key");
  ok(!/sessionStorage\.(get|set)Item\(\s*"(?!paylink:tp-journey:v1)/.test(tp.replace(/TP_STORE_KEY/g, '"paylink:tp-journey:v1"')),
    "sessionStorage touched only through the journey key");

  /* Poll floor mirrors the backend. */
  ok(tp.includes("FLOOR: 2000"), "2 s poll floor constant present");
}

/* ── wiring between app.js, tidepool.js and index.html ── */

{
  ok(app.includes('from "./tidepool.js?v='), "app.js imports the rail module");
  ok(app.includes("initTidepool({") && app.includes("endpoint:"), "rail initialised with the config endpoint");
  ok(app.includes('id="tpWrap"') || app.includes('<div id="tpWrap"></div>'), "pay card contains #tpWrap");
  ok(app.includes("teardownTidepool()"), "pay-card error paths stop the rail");
  ok(app.includes('closest("[data-tp-toggle]")'), "toggle delegated through the existing click router");
  ok(app.includes("onVerified:"), "verified callback wired to app-level actions");

  /* version pairing: the import in app.js must match the module file, and
     index.html must cache-bust both app.js and styles.css. */
  const m = app.match(/from "\.\/tidepool\.js\?v=([^"]+)"/);
  ok(!!m, "tidepool import carries a cache-bust version");
  ok(html.includes(`app.js?v=`), "index.html cache-busts app.js");
  ok(html.includes(`styles.css?v=`), "index.html cache-busts styles.css");
  if (m) ok(app.includes(`config.js?v=`), "config import also versioned (pairs with app.js)");

  /* config carries the endpoint field. */
  ok(/tidepoolWorker/.test(cfg), "config.js defines tidepoolWorker");
  ok(/endpoint/.test(cfg.slice(cfg.indexOf("tidepoolWorker"))), "tidepoolWorker.endpoint present");

  /* stylesheet covers the rail's classes. */
  for (const cls of [".tp-panel", ".tp-instr", ".tp-code", ".tp-receipt", ".tp-toggle", ".tp-deadline", ".tp-fields"]) {
    ok(css.includes(cls), `styles.css defines ${cls}`);
  }
  ok(css.includes('[data-theme="light"] .pay-card .tp-panel'), "light theme re-pins the panel to the dark pay card");
}

/* ── CI wires the new files in ── */

{
  const ci = readFileSync(join(root, "..", ".github", "workflows", "ci.yml"), "utf8");
  ok(ci.includes("frontend/tidepool.js"), "ci.yml syntax-checks tidepool.js");
  for (const f of ["tidepool-discovery", "tidepool-quote", "tidepool-status", "tidepool-polling", "tidepool-deposit", "tidepool-regression"]) {
    ok(ci.includes(`${f}.test.mjs`), `ci.yml runs ${f}.test.mjs`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
