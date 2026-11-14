/* rpc() failover tests — run with: node frontend/test/rpc-failover.test.mjs
 *
 * Fix D: the browser read client carries CONFIG.rpcUrls (the same alternates
 * the Workers hold in wrangler RPC_URLS). The one permitted retry is spent on
 * the NEXT endpoint instead of repeating a dead primary — but nothing else
 * changes: still max two fetches, still reads-only, still never on 429/404/
 * chain-error/timeout.
 *
 * rpc-retry.test.mjs pins the single-endpoint discipline (counts, never-
 * retry set). This suite is independent and pins the ROUTING: WHICH url each
 * fetch lands on when alternates are configured. The rpc block is sliced out
 * of app.js the same marker-bounded way and run against a scripted fetch, so
 * every assertion below is behavioural, not a source-pattern guess.
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");

/* ── slice the rpc block out of app.js (marker-bounded, no brace guessing) ── */

const start = src.indexOf("const RPC_TIMEOUT_MS");
const end = src.indexOf("/** Unsigned view call");
ok(start >= 0, "rpc block start marker found");
ok(end > start, "rpc block end marker found after start");
const block = src.slice(start, end);
ok(block.includes("async function rpc(method, params)"), "block contains rpc()");
ok(block.includes("async function rpcOnce(method, params)"), "block contains rpcOnce() with the pinned signature");
ok(block.includes("async function rpcOnceAt("), "block contains rpcOnceAt(url, …), the URL-carrying attempt");
ok(block.includes("RPC_READ_METHODS.has(method)"),
  "the retry is gated on the read-method list (writes can never retry)");
ok(block.includes("RPC_ENDPOINTS"), "the block derives the endpoint list from CONFIG");

/* ── scripted fetch: records the URL of every call, exact counts asserted ── */

const PRIMARY = "https://primary.test/";
const ALT_1 = "https://alternate-one.test/";
const ALT_2 = "https://alternate-two.test/";
const CFG_WITH_ALTS = { rpcUrl: PRIMARY, rpcUrls: [ALT_1, ALT_2] };
const CFG_SINGLE = { rpcUrl: PRIMARY }; // what rpc-retry.test.mjs injects

const makeRpc = (fetchImpl, CONFIG) =>
  new Function("fetch", "CONFIG", `${block}\nreturn rpc;`)(fetchImpl, CONFIG);

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const netErr = () => new TypeError("Failed to fetch");
const abortErr = () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};

function harness(steps, CONFIG) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error("unexpected extra fetch call");
    if (step instanceof Error) throw step;
    return step;
  };
  return { rpc: makeRpc(fetchImpl, CONFIG), calls };
}

async function rejects(promise, pattern, label) {
  try {
    await promise;
    ok(false, `${label} — did not reject`);
  } catch (e) {
    ok(pattern.test(String(e.message)), `${label} (${e.message})`);
  }
}

/* ── 1. happy path: alternates configured, primary answers → one fetch ── */

{
  const h = harness([reply({ result: "first" })], CFG_WITH_ALTS);
  ok((await h.rpc("query", {})) === "first" && h.calls.length === 1,
    "success on the primary → one fetch, no failover");
  ok(h.calls[0].url === PRIMARY, "the first attempt goes to the primary");
}

/* ── 2. THE failover assertion: the retry lands on the alternate ── */

{
  const h = harness([netErr(), reply({ result: "recovered" })], CFG_WITH_ALTS);
  ok((await h.rpc("query", {})) === "recovered" && h.calls.length === 2,
    "network error → exactly two fetches (failover, not a loop)");
  ok(h.calls[0].url === PRIMARY, "attempt 1 went to the primary");
  ok(h.calls[1].url === ALT_1,
    "attempt 2 ROUTED TO THE ALTERNATE — the dead primary was not repeated");
}
{
  const h = harness([reply({}, 503), reply({ result: "recovered" })], CFG_WITH_ALTS);
  ok((await h.rpc("query", {})) === "recovered" && h.calls.length === 2,
    "5xx → exactly two fetches");
  ok(h.calls[1].url === ALT_1, "the 5xx retry also fails over to the alternate");
}

/* ── 3. the budget is still two, even with alternates configured ── */

{
  const h = harness([netErr(), netErr()], CFG_WITH_ALTS);
  await rejects(h.rpc("query", {}), /Failed to fetch/,
    "both endpoints down → the original error surfaces");
  ok(h.calls.length === 2, "exactly two fetches — the second alternate is never reached");
  ok(h.calls[1].url === ALT_1, "the second fetch was the first alternate (ordered list)");
}

/* ── 4. the never-retry set still never fails over (one fetch, primary) ── */

{
  const h = harness([reply({}, 429)], CFG_WITH_ALTS);
  await rejects(h.rpc("query", {}), /RPC HTTP 429/, "429 surfaces as-is");
  ok(h.calls.length === 1 && h.calls[0].url === PRIMARY,
    "429 is NOT retried and does NOT fail over (one fetch, primary)");
}
{
  const h = harness([reply({}, 404)], CFG_WITH_ALTS);
  await rejects(h.rpc("query", {}), /RPC HTTP 404/, "404 surfaces as-is");
  ok(h.calls.length === 1 && h.calls[0].url === PRIMARY,
    "404 is NOT retried and does NOT fail over (one fetch, primary)");
}
{
  const h = harness([reply({ error: { message: "boom" } })], CFG_WITH_ALTS);
  await rejects(h.rpc("query", {}), /boom/, "JSON-RPC error surfaces");
  ok(h.calls.length === 1 && h.calls[0].url === PRIMARY,
    "a chain error is NOT retried and does NOT fail over (one fetch, primary)");
}
{
  const h = harness([abortErr()], CFG_WITH_ALTS);
  await rejects(h.rpc("query", {}), /did not respond in time/,
    "timeout keeps its friendly message");
  ok(h.calls.length === 1 && h.calls[0].url === PRIMARY,
    "a timeout is NOT retried and does NOT fail over (one fetch, primary)");
}

/* ── 5. writes can never retry or fail over, even through this read client ── */

{
  const h = harness([netErr()], CFG_WITH_ALTS);
  await rejects(h.rpc("broadcast_tx_commit", {}), /Failed to fetch/,
    "a non-read method's failure surfaces");
  ok(h.calls.length === 1 && h.calls[0].url === PRIMARY,
    "non-read method: NEVER retried, NEVER failed over (one fetch, primary)");
}

/* ── 6. single-endpoint config behaves exactly as before (the pinned world) ── */

{
  const h = harness([netErr(), reply({ result: "recovered" })], CFG_SINGLE);
  ok((await h.rpc("query", {})) === "recovered" && h.calls.length === 2,
    "no rpcUrls → the retry repeats the PRIMARY (historical behaviour)");
  ok(h.calls[0].url === PRIMARY && h.calls[1].url === PRIMARY,
    "no rpcUrls → both fetches hit the same primary url");
}

/* ── 7. config sanity: two alternates, matching the Workers' set ── */

{
  const cfg = readFileSync(new URL("../config.js", import.meta.url), "utf8");
  const m = cfg.match(/rpcUrls:\s*\[([^\]]*)\]/);
  ok(!!m, "config.js declares rpcUrls");
  const urls = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  ok(urls.length === 2, `exactly two alternates configured (got ${urls.length})`);
  ok(urls[0] === "https://near-testnet.drpc.org" && urls[1] === "https://testnet-rpc.intea.rs",
    "the two CORS-verified NEAR testnet alternates, in order");

  /* parity with the Workers: browser and backend fail over onto the same nodes */
  const wr = readFileSync(
    new URL("../../workers/relayer/wrangler.toml", import.meta.url), "utf8");
  const wm = wr.match(/RPC_URLS\s*=\s*"([^"]+)"/);
  const workerUrls = wm ? wm[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  ok(JSON.stringify(urls) === JSON.stringify(workerUrls),
    "browser alternates are byte-identical to the Workers' RPC_URLS");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
