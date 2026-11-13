/* Verifiable receipt tests — run with: node frontend/test/receipt.test.mjs
 *
 * The pay card must show a verifiable receipt after every successful
 * payment: amount received, transaction hashes, time, the sentence
 * "Payment delivered and verified on NEAR", explorer links, and a
 * one-click PDF. These guards cover three layers:
 *
 *   1. the PDF writer (receipt.js) — real PDF 1.4 bytes, exact xref
 *      offsets, ASCII-only output, safe filenames;
 *   2. the rendered panel — VERIFIED is the SINGLE success surface (the
 *      label appears once, one green line, upstream claims suppressed,
 *      no countdown), and the deposit countdown appears exactly once;
 *   3. the card wiring — hashes come only from the wallet's own returned
 *      transactions, the PDF buttons are routed, the amount/network/
 *      invoice furniture is present, and the light theme re-pins it.
 *
 * Pure + source-level + one scripted rail render: no network, no DOM.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReceiptPdf, receiptFilename, RECEIPT_SENTENCE } from "../receipt.js";
import { createTidepoolRail, tpReceiptHtml, tpStateView } from "../tidepool.js";

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
const css = read("styles.css");

/* ════════════════════════ 1. the PDF writer ═══════════════════════ */

const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const SAMPLE = [
  { text: "Paylink payment receipt", kind: "title" },
  { text: RECEIPT_SENTENCE, kind: "sub" },
  { kind: "rule" },
  { text: "Amount received: 5 USDC", kind: "row" },
  { text: `Transaction: ${HASH}`, kind: "row" },
  { text: "Verifiable on NEAR:", kind: "head" },
  { text: `https://nearblocks.io/transactions/${HASH}`, kind: "small" },
];
const pdf = buildReceiptPdf(SAMPLE);
const txt = Buffer.from(pdf).toString("latin1");

ok(pdf instanceof Uint8Array && pdf.length > 500, "buildReceiptPdf returns a real byte array");
ok(txt.startsWith("%PDF-1.4"), "file starts with the PDF 1.4 header");
ok(txt.trimEnd().endsWith("%%EOF"), "file ends with %%EOF");
ok(txt.includes(RECEIPT_SENTENCE), "the receipt sentence is printed in the PDF");
ok(txt.includes(HASH), "the transaction hash is printed in the PDF");
ok(txt.includes("Amount received: 5 USDC"), "the amount row is printed");
ok(Array.from(pdf).every((b) => b <= 0x7f), "every byte is printable ASCII (offsets stay exact)");
ok(txt.includes("0.85 G 40 "), "a rule line is drawn as a hairline");

{
  const sx = txt.match(/startxref\n(\d+)\n%%EOF/);
  ok(!!sx, "startxref marker present");
  if (sx) ok(txt.slice(Number(sx[1]), Number(sx[1]) + 4) === "xref", "startxref offset lands exactly on the xref table");
}

{
  const block = txt.slice(txt.indexOf("xref\n"));
  const entries = [...block.matchAll(/^(\d{10}) 00000 n $/gm)];
  ok(entries.length === 6, `xref table lists all six objects (found ${entries.length})`);
  const allHit = entries.every((e, i) => txt.slice(Number(e[1]), Number(e[1]) + 7) === `${i + 1} 0 obj`);
  ok(allHit, "every xref offset points at the start of its own object");
}

{
  /* Non-ASCII folds to "?"; parens and backslashes escape; a runaway token
     wraps instead of running off the page; a runaway page count is clipped. */
  const folded = Buffer.from(buildReceiptPdf([{ text: "naïve → ✓", kind: "body" }])).toString("latin1");
  ok(folded.includes("na?ve ? ?"), "non-ASCII input folds to '?'");
  ok(Array.from(folded).every((c) => c.codePointAt(0) <= 0x7f), "folded file is still pure ASCII");

  const escaped = Buffer.from(buildReceiptPdf([{ text: "Back (slash) \\ and (parens)", kind: "body" }])).toString("latin1");
  ok(escaped.includes("Back \\(slash\\) \\\\ and \\(parens\\)"), "parens and backslashes are PDF-escaped");

  const long = Buffer.from(buildReceiptPdf([{ text: "a".repeat(300), kind: "body" }])).toString("latin1");
  const segs = [...long.matchAll(/\(([^)]*)\) Tj ET/g)].map((m) => m[1]);
  ok(segs.length > 2 && segs.every((s) => s.length <= 96), "a 300-char token is hard-wrapped to the line width");

  const flood = Buffer.from(buildReceiptPdf(Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}`, kind: "body" })))).toString("latin1");
  const drawn = (flood.match(/\) Tj ET/g) || []).length;
  ok(drawn > 0 && drawn < 100 && flood.trimEnd().endsWith("%%EOF"), `a 100-line page clips at the bottom (${drawn} lines), never paginates`);
}

{
  ok(receiptFilename("demo-004") === "paylink-receipt-demo-004.pdf", "filename carries the invoice id");
  ok(receiptFilename("") === "paylink-receipt-payment.pdf", "empty id falls back to 'payment'");
  ok(receiptFilename(null) === "paylink-receipt-payment.pdf", "missing id falls back to 'payment'");
  const nasty = receiptFilename("../../etc/passwd");
  ok(!/[/\\:]/.test(nasty) && nasty.endsWith(".pdf"), "path characters can never escape the download directory");
  ok(receiptFilename("x".repeat(200)).length <= 84, "runaway ids are truncated");
}

ok(RECEIPT_SENTENCE === "Payment delivered and verified on NEAR", "the shared sentence is exactly the spec's wording");

/* ════════════════ 2. rendered: one success surface ════════════════ */

const ENDPOINT = "https://paylink-tidepool.example.workers.dev";
const LINK_ID = "demo-004";
const LINK = { link_id: LINK_ID };
const CTX = { st: "OPEN", mine: false, accountId: "bob.testnet", amountLabel: "10 USDC" };
const INTENT_ID = "pi_0123456789abcdef";
const flush = () => new Promise((r) => setTimeout(r, 0));
const count = (hay, needle) => hay.split(needle).length - 1;

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
  const fn = async (url) => {
    const u = String(url);
    const r = routes.find((x) => u.includes(x.match));
    if (!r) throw new Error(`no route for ${u}`);
    return typeof r.res === "function" ? r.res() : r.res;
  };
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
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => store,
    schedule: timers.schedule, unschedule: timers.unschedule,
    onVerified: () => {}, onInvoiceStale: () => {}, onActionsChanged: () => {},
  });
  rail.init({ endpoint: ENDPOINT });
  await rail.sync(LINK, CTX);
  await flush();
  rail.setForm({ blockchain: "ethereum", assetId: "nep141:usdc.eth", refundTo: "alice.testnet" });
  await rail.quote();
  await timers.runNext(); // the immediate status read
  return { rail, el };
}

{
  const { rail, el } = await railAtStatus("VERIFIED", { tidepoolStatus: "SUCCESS" });
  const html = el.innerHTML;
  ok(count(html, "Payment verified") === 1, "VERIFIED says 'Payment verified' exactly once (the receipt is the only surface)");
  ok(count(html, "tx-line ok") === 1, "exactly one green success line in the panel");
  ok(html.includes(RECEIPT_SENTENCE), "the receipt carries the verification sentence");
  ok(html.includes("Amount received") && html.includes("10 USDC"), "the receipt shows the amount received");
  ok(html.includes(INTENT_ID), "the receipt shows the payment reference");
  ok(html.includes("rcpt-rows") && html.includes("rcpt-foot"), "receipt rows and foot render");
  ok(html.includes(`data-receipt-pdf="cross"`), "the one-click PDF button is present");
  ok(html.includes("Download PDF receipt"), "the PDF button says what it does");
  ok(!html.includes("Tidepool reports SUCCESS"), "the upstream claim is suppressed at VERIFIED (the receipt supersedes it)");
  ok(!html.includes("Quote expires in"), "no countdown on a terminal receipt");
  ok(!html.includes("SECRET-REASON-NEVER-SHOWN"), "lastReason never reaches the DOM");
  ok(rail.snapshot().panelOpen === true, "the receipt pins the panel open — the proof stays on screen");
}

{
  const { el } = await railAtStatus("AWAITING_DEPOSIT", {
    quoteDeadline: new Date(Date.now() + 900000).toISOString(),
    tidepoolStatus: "PENDING_DEPOSIT",
  });
  const html = el.innerHTML;
  ok(count(html, "Quote expires in") === 1, "the deposit countdown renders exactly once (instructions are its single home)");
  ok(!html.includes("Tidepool: quote still waiting for the deposit."),
    "the AWAITING_DEPOSIT upstream line is suppressed — it only restates the label");
  ok(html.includes("Waiting for your deposit"), "the state label still renders");
}

{
  const { el } = await railAtStatus("DEPOSIT_SEEN", { tidepoolStatus: "PENDING_DEPOSIT" });
  ok(el.innerHTML.includes("waiting for the deposit"),
    "the upstream line still shows when it ADDS to the state (DEPOSIT_SEEN + PENDING_DEPOSIT)");
}

{
  /* The pure receipt: label + detail once, facts as rows, PDF button. */
  const facts = {
    amountLabel: "5 USDC",
    time: "2026-11-12T10:00:00Z",
    reference: "pi_abc",
    invoice: "demo-004",
    explorerUrl: "https://nearblocks.io/accounts/paylink-v2.testnet",
    sentence: RECEIPT_SENTENCE,
  };
  const html = tpReceiptHtml(tpStateView("VERIFIED"), facts);
  ok(count(html, "Payment verified") === 1, "pure receipt renders the label once");
  ok(html.includes("5 USDC") && html.includes("Payment reference") && html.includes("demo-004"), "fact rows render");
  ok(html.includes("https://nearblocks.io/accounts/paylink-v2.testnet"), "the explorer link renders");
  ok(html.includes(`data-receipt-pdf="cross"`), "the cross-chain PDF button renders");
}

/* ═══════════════════ 3. card wiring (source-level) ═══════════════════ */

{
  const receiptFn = app.slice(app.indexOf("function payReceiptHtml("), app.indexOf("function receiptPdfDoc("));
  ok(receiptFn !== "", "payReceiptHtml exists on the card");
  ok(receiptFn.includes("RECEIPT_SENTENCE"), "the card receipt uses the shared sentence");
  ok(receiptFn.includes(`data-receipt-pdf="near"`), "the card receipt carries its PDF button");
  ok(receiptFn.includes("Amount received") && receiptFn.includes("Time") && receiptFn.includes("Invoice"),
    "the card receipt shows amount, time and invoice rows");
  ok(receiptFn.includes("txs.payment ?") && receiptFn.includes("txs.release ?"),
    "hash rows render only when this device holds a real hash");
  ok(!/[0-9a-f]{56,}/i.test(receiptFn), "no transaction hash is ever hardcoded into the card");
  ok(app.includes("celebrated && landed ? payReceiptHtml(link, st)"),
    "the receipt replaces the success block behind the same landed gate");

  const pdfDoc = app.slice(app.indexOf("function receiptPdfDoc("), app.indexOf("async function renderPay("));
  ok(pdfDoc.includes("tpReceiptFacts()"), "the cross-chain PDF reads the panel receipt's facts");
  ok(pdfDoc.includes("kind === \"cross\""), "near and cross receipts build different models");
  ok(pdfDoc.includes("txs.payment || txs.release"), "the closing line only claims hashes when hashes exist");

  const handler = app.slice(app.indexOf(`const pdfBtn = e.target.closest("[data-receipt-pdf]")`), app.indexOf("const copyBtn ="));
  ok(handler.includes("buildReceiptPdf(") && handler.includes("receiptFilename("), "the click router builds and names the PDF");
  ok(handler.includes("URL.createObjectURL") && handler.includes("a.click()"), "the PDF downloads through a temporary anchor");

  ok(app.includes('from "./receipt.js?v='), "app.js imports the receipt module with a cache-bust version");
  ok(app.includes("tpReceiptFacts"), "tpReceiptFacts is imported into app.js");
}

{
  /* Hashes come from this device's wallet only, at the two signing sites. */
  ok(app.includes(`"paylink:txReceipt:v1"`), "the receipt store has its own storage key");
  ok(app.includes("function rememberTx(") && app.includes("function txReceiptFor("), "store helpers exist");
  const paySlice = app.slice(app.indexOf("async function payLink("), app.indexOf("async function claimLink("));
  ok(paySlice.includes("rememberTx(linkId, { payment: hash })"), "payLink remembers the payment hash the wallet returned");
  ok(paySlice.indexOf("rememberPaid(linkId)") < paySlice.indexOf("rememberTx(linkId, { payment: hash })"),
    "the hash is remembered alongside the paid marker");
  const claimSlice = app.slice(app.indexOf("async function claimLink("), app.indexOf("faucet + swap (Tidepool)"));
  ok(claimSlice.includes("rememberTx(linkId, { release: hash })"), "claimLink remembers the release hash");
}

{
  /* Card furniture: invoice-keyed pill, amount block, network chip, rail divider. */
  const pay = app.slice(app.indexOf("async function renderPay("), app.indexOf("function renderPayActions("));
  ok(pay.includes(`<span class="pill-k">invoice</span>`), "the pill says WHICH status it shows (invoice)");
  ok(pay.includes(`title="invoice status on chain"`), "the pill is labelled for screen readers");
  ok(pay.includes(`<div class="pay-amount">`), "the amount is grouped in its own block");
  ok(pay.includes(`pay-net`) && pay.includes("on NEAR"), "the card answers 'which network?' at a glance");

  const actions = app.slice(app.indexOf("function renderPayActions("), app.indexOf("function wireFundRail("));
  ok((actions.match(/data-pay=/g) || []).length === 1, "still exactly one NEAR pay button");
  ok(actions.includes("One approval"), "the one-approval copy is untouched");
  ok(actions.includes("pay-or") && actions.includes("tpToggle ?"),
    "the or-divider renders only when the cross-chain toggle does");
  ok(actions.indexOf("data-pay=") < actions.indexOf("pay-or"), "the NEAR button comes before the rail divider");
}

{
  /* Wiring into the rail: amount, explorer, contract. */
  const init = app.slice(app.indexOf("initTidepool({"), app.indexOf("loadNetwork();"));
  ok(init.includes("explorer:") && init.includes("contractId:"), "the rail is given the explorer + contract for receipt links");
  ok(app.includes("syncTidepool(link, { st, mine, accountId, amountLabel:"), "the card passes its formatted amount label to the rail");
}

{
  /* tidepool.js: dedup + receipt architecture. */
  ok((tp.match(/tpReceiptHtml\(/g) || []).length === 2, "tpReceiptHtml has one definition and one call site (no duplicate push)");
  ok(!tp.includes("out.push(tpReceiptHtml(TP_STATES.VERIFIED))"), "the old standalone VERIFIED receipt push is gone");
  ok((tp.match(/tp-deadline/g) || []).length === 1, "the countdown class renders from exactly one place");
  ok(tp.includes(`!(st === "AWAITING_DEPOSIT" && up === "PENDING_DEPOSIT")`), "the restating upstream line is suppressed at AWAITING_DEPOSIT");
  ok(tp.includes(`st === TP_VERIFIED` ) && tp.includes("receiptFacts()"), "journey renders the receipt with facts at VERIFIED");
  ok(tp.includes(`verified: "Nothing more to pay for this invoice."`), "the verified gate no longer repeats the receipt headline");
  ok(!tp.includes("Payment verified — Paylink confirmed"), "the old duplicated gate sentence is gone");
  ok(tp.includes("S.panelOpen = true"), "the receipt pins the panel open");
  ok(tp.includes('import { RECEIPT_SENTENCE } from "./receipt.js"'), "tidepool.js shares the sentence from receipt.js (plain path for node tests)");
  ok(tp.includes("amountLabel") && tp.includes("opts.explorer") && tp.includes("opts.contractId"), "sync/init accept the receipt context");
}

{
  /* stylesheet: the receipt and its furniture, pinned for the light theme */
  for (const sel of [".pay-receipt{", ".rcpt-rows{", ".rcpt-foot{", ".rcpt-sig{", ".pay-amount{", ".pay-net{", ".pay-or{", ".pill-k{"]) {
    ok(css.includes(sel), `styles.css defines ${sel.slice(0, sel.length - 1)}`);
  }
  ok(css.includes(`[data-theme="light"] .pay-card .pay-net`), "light theme re-pins the network chip to the dark card");
  ok(css.includes(`[data-theme="light"] .pay-card .pay-or`), "light theme re-pins the or-divider to the dark card");
  ok(css.includes(".pay-receipt a:focus-visible"), "receipt links get a visible focus ring");
  ok(css.includes(".rcpt-foot") && /@media \(max-width:560px\)\{[^}]*\.rcpt-foot/s.test(css), "the receipt foot stacks on phones");
  ok(!css.includes(".pay-success"), "the old success banner styles are gone");
  ok(!app.includes("pay-success"), "the old success banner markup is gone");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
