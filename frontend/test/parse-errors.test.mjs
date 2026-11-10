/* Parse-error handling tests — run with: node frontend/test/parse-errors.test.mjs
 *
 * L-06: the browser -> Parse-Worker leg must be bounded too, and every
 * failure the Worker can produce must surface as a usable note with the
 * button re-enabled. Two layers, mirroring one-approval.test.mjs:
 *
 *   1. source-level guards — the AbortController, the 20 s budget (strictly
 *      above the Worker's 15 s so Gemini stalls answer as the Worker's
 *      precise 504), and the clearTimeout ordering are all visible in
 *      app.js and cannot be quietly removed;
 *   2. a functional slice — parseInvoice() is sliced out of app.js and run
 *      against a stubbed $/aiNote/CONFIG/fetch/applyParsed, so each Worker
 *      error shape, a network failure, an abort and a success are exercised
 *      end to end. No browser, no network, no real parser.
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const workerSrc = readFileSync(new URL("../../workers/parse/src/index.js", import.meta.url), "utf8");

/* ── 1. source-level guards (L-06 wiring cannot vanish silently) ── */

const constLine = src.match(/const PARSE_CLIENT_TIMEOUT_MS = ([\d_]+);/);
ok(!!constLine, "PARSE_CLIENT_TIMEOUT_MS is declared");
ok(constLine && Number(constLine[1].replace(/_/g, "")) === 20_000, "the client budget is 20 s");

const workerTimeout = workerSrc.match(/const UPSTREAM_TIMEOUT_MS = ([\d_]+);/);
ok(!!workerTimeout, "the Worker declares UPSTREAM_TIMEOUT_MS");
ok(!!constLine && !!workerTimeout
  && Number(constLine[1].replace(/_/g, "")) > Number(workerTimeout[1].replace(/_/g, "")),
  "the client budget sits strictly ABOVE the Worker's — Gemini stalls surface as the Worker's 504, not a client abort");

const parseStart = src.indexOf("async function parseInvoice(");
const parseEnd = src.indexOf("/** Validate the model's output");
ok(parseStart >= 0 && parseEnd > parseStart, "parseInvoice found");
const slice = src.slice(parseStart, parseEnd);

ok(slice.includes("signal: ctl.signal"), "parseInvoice passes an AbortSignal to fetch");
ok(slice.includes("const ctl = new AbortController()"), "parseInvoice owns an AbortController");
ok(slice.includes("setTimeout(() => ctl.abort(), PARSE_CLIENT_TIMEOUT_MS)"), "the budget aborts the request");
ok(slice.indexOf("const ctl") < slice.indexOf("await fetch"),
  "the controller is armed before the fetch (and before the file read)");
ok((slice.match(/clearTimeout\(timer\)/g) || []).length >= 2,
  "the timer is cleared on both exits (exchange end + outer finally)");
const clearIdx = slice.indexOf("clearTimeout(timer)");
const applyIdx = slice.indexOf("await applyParsed(parsed)");
ok(clearIdx >= 0 && applyIdx > clearIdx,
  "the timer is cleared BEFORE applyParsed — validation errors cannot be misread as timeouts");
ok(slice.indexOf("ctl.signal.aborted") < slice.indexOf('note = "The parser took too long'),
  "an abort is classified before any other message");

/* ── 2. functional slice of parseInvoice ── */

function harness(fetchImpl, applyImpl, timeoutMs = 20_000) {
  const state = { notes: [], applied: [], btn: { disabled: false } };
  const els = {
    aiText: { value: "Chidi owes me 400 USDC" },
    aiFile: { files: [] },
    aiFill: state.btn,
  };
  const $ = (id) => els[String(id).replace(/^#/, "")];
  const aiNote = (msg, kind = "") => state.notes.push({ msg, kind });
  const CONFIG = { parseEndpoint: "https://parse.test/" };
  const fileToBase64 = async () => "";
  const build = new Function(
    "PARSE_CLIENT_TIMEOUT_MS", "$", "aiNote", "CONFIG", "fetch", "applyParsed", "fileToBase64",
    `${slice}\nreturn parseInvoice;`,
  );
  const parseInvoice = build(timeoutMs, $, aiNote, CONFIG, fetchImpl, applyImpl, fileToBase64);
  return { state, parseInvoice };
}

const workerReply = (status, error) => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

/* a. successful response: fields handed to applyParsed, button re-enabled */
{
  const parsed = { amount: "400", token: "USDC", payee: "chidi.testnet", description: "Logo", expires_in_hours: 72 };
  let disabledDuring = null;
  let gotSignal = null;
  const { state, parseInvoice } = harness(
    async (_url, init) => {
      disabledDuring = state.btn.disabled;
      gotSignal = init.signal;
      return { ok: true, json: async () => parsed };
    },
    async (p) => { state.applied.push(p); },
  );
  await parseInvoice();
  ok(disabledDuring === true, "the button is disabled while the request runs");
  ok(!!gotSignal && typeof gotSignal.aborted === "boolean", "a real AbortSignal reaches fetch");
  ok(state.applied.length === 1 && state.applied[0] === parsed, "a successful parse reaches applyParsed intact");
  ok(state.btn.disabled === false, "the button is re-enabled after success");
}

/* b. every Worker error shape surfaces its own message, verbatim */
{
  const cases = [
    [504, "Gemini timed out", "the Worker's 504 timeout message is surfaced as-is"],
    [502, "Could not reach Gemini", "the Worker's 502 unreachable message is surfaced as-is"],
    [502, "Gemini response was unreadable", "the Worker's invalid-JSON message is surfaced as-is"],
    [422, "The reading was not JSON", "the Worker's 422 bad-payload message is surfaced as-is"],
    [429, "Too many requests", "the Worker's rate-limit message is surfaced as-is"],
    [413, "Text is too long", "the Worker's size-limit message is surfaced as-is"],
  ];
  for (const [status, error, label] of cases) {
    const { state, parseInvoice } = harness(
      async () => workerReply(status, error),
      async () => { state.applied.push("should not run"); },
    );
    await parseInvoice();
    const note = state.notes[state.notes.length - 1];
    ok(note && note.msg === error && note.kind === "warn", label);
    ok(state.applied.length === 0, `…and nothing is applied for ${error}`);
    ok(state.btn.disabled === false, `…and the button is re-enabled for ${error}`);
  }
}

/* c. network failure: friendly message, never a raw fetch error */
{
  const { state, parseInvoice } = harness(
    async () => { throw new TypeError("Failed to fetch"); },
    async () => {},
  );
  await parseInvoice();
  const note = state.notes[state.notes.length - 1];
  ok(note && note.msg === "Could not reach the parser service. Check your connection and try again.",
    "a network failure maps to the friendly connection message");
  ok(note.kind === "warn", "…at warn level");
  ok(state.btn.disabled === false, "…and the button is re-enabled");
}

/* d. slow / hung response: the budget aborts it and says so */
{
  const { state, parseInvoice } = harness(
    (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    }),
    async () => {},
    50, // fast budget so the test stays quick
  );
  const t0 = Date.now();
  await parseInvoice();
  const elapsed = Date.now() - t0;
  const note = state.notes[state.notes.length - 1];
  ok(note && note.msg === "The parser took too long to respond. Try again.",
    "a hung parser is aborted and reports the timeout note (not a raw DOMException)");
  ok(note.kind === "warn", "…at warn level");
  ok(elapsed < 5_000, `the abort fires promptly (${elapsed} ms)`);
  ok(state.applied.length === 0, "nothing is applied after a timeout");
  ok(state.btn.disabled === false, "…and the button is re-enabled");
}

/* e. an invalid JSON body from the Worker never crashes the handler */
{
  const { state, parseInvoice } = harness(
    async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } }),
    async () => {},
  );
  await parseInvoice();
  const note = state.notes[state.notes.length - 1];
  ok(!!note && note.msg.length > 0 && note.msg !== "[object Object]",
    "unparseable Worker response -> a real message, never [object Object]");
  ok(note.kind === "warn", "…at warn level");
  ok(state.applied.length === 0 && state.btn.disabled === false,
    "…nothing applied, button re-enabled");
}

/* f. a validation failure after the exchange stays a validation failure —
   the timer was cleared before applyParsed, so it cannot be misread */
{
  const { state, parseInvoice } = harness(
    async () => ({ ok: true, json: async () => ({ amount: "999" }) }),
    async () => { throw new Error("That amount is not valid."); },
    1, // budget already expired by the time applyParsed runs
  );
  await parseInvoice();
  const note = state.notes[state.notes.length - 1];
  ok(note && note.msg === "That amount is not valid.",
    "a post-exchange validation error keeps ITS message, not the timeout note");
  ok(note.kind === "warn", "…at warn level");
  ok(state.btn.disabled === false, "…and the button is re-enabled");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
