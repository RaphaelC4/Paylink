/* rpc() retry tests — run with: node frontend/test/rpc-retry.test.mjs
 *
 * L-08 P2: reads retry ONCE on a network error or a 5xx reply — never on a
 * rate limit, a timeout, a chain error, and never for non-read methods.
 *
 * The rpc block (RPC_TIMEOUT_MS → the view helper) is sliced out of app.js
 * and executed against a scripted fetch, so these are behavioural tests, not
 * source-pattern guesses: every scenario asserts the exact number of fetch
 * calls, which is what pins "one retry" and "no retry for writes".
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
ok(block.includes("async function rpcOnce(method, params)"), "block contains rpcOnce()");
ok(block.includes("RPC_READ_METHODS.has(method)"),
  "the retry is gated on the read-method list (writes can never retry)");

const CONFIG = { rpcUrl: "https://rpc.test/" };
const makeRpc = (fetchImpl) =>
  new Function("fetch", "CONFIG", `${block}\nreturn rpc;`)(fetchImpl, CONFIG);

/* ── scripted fetch: one step per call, exact call counts asserted ── */

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

function harness(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[calls.length - 1];
    if (step === undefined) throw new Error("unexpected extra fetch call");
    if (step instanceof Error) throw step;
    return step;
  };
  return { rpc: makeRpc(fetchImpl), calls };
}

async function rejects(promise, pattern, label) {
  try {
    await promise;
    ok(false, `${label} — did not reject`);
  } catch (e) {
    ok(pattern.test(String(e.message)), `${label} (${e.message})`);
  }
}

/* ── 1. no gratuitous retry: the happy path still costs exactly one call ── */

{
  const h = harness([reply({ result: "first" })]);
  ok((await h.rpc("query", {})) === "first" && h.calls.length === 1,
    "success on first attempt → one fetch, no retry");
}

/* ── 2+3. the two retryable conditions: network error, then 5xx ── */

{
  const h = harness([netErr(), reply({ result: "recovered" })]);
  ok((await h.rpc("query", {})) === "recovered" && h.calls.length === 2,
    "network error retried once and succeeds (2 fetches)");
}
{
  const h = harness([reply({}, 503), reply({ result: "recovered" })]);
  ok((await h.rpc("query", {})) === "recovered" && h.calls.length === 2,
    "5xx retried once and succeeds (2 fetches)");
}
{
  const h = harness([reply({}, 500), netErr()]);
  await rejects(h.rpc("status", ["FINAL"]), /Failed to fetch/,
    "a retryable failure on the retry attempt also gives up");
  ok(h.calls.length === 2,
    "mixed retryable failures still stop at two fetches (bounded)");
}

/* ── 4+5. rate limits and client errors are never hammered ── */

{
  const h = harness([reply({}, 429)]);
  await rejects(h.rpc("query", {}), /RPC HTTP 429/, "429 surfaces as-is");
  ok(h.calls.length === 1, "429 is NOT retried (one fetch)");
}
{
  const h = harness([reply({}, 404)]);
  await rejects(h.rpc("query", {}), /RPC HTTP 404/, "404 surfaces as-is");
  ok(h.calls.length === 1, "404 is NOT retried (one fetch)");
}

/* ── 6. the chain answered — a JSON-RPC error is final ── */

{
  const h = harness([reply({ error: { message: "boom" } })]);
  await rejects(h.rpc("query", {}), /boom/, "JSON-RPC error surfaces");
  ok(h.calls.length === 1, "a chain error is NOT retried (one fetch)");
}

/* ── 7. a timeout already waited 12 s — it is never retried ── */

{
  const h = harness([abortErr()]);
  await rejects(h.rpc("query", {}), /did not respond in time/,
    "timeout keeps its friendly message");
  ok(h.calls.length === 1, "timeout is NOT retried (one fetch)");
}

/* ── 8. the retry is bounded: exactly two attempts, then it throws ── */

{
  const h = harness([netErr(), netErr()]);
  await rejects(h.rpc("query", {}), /Failed to fetch/,
    "both attempts failed → original error surfaces");
  ok(h.calls.length === 2, "exactly two fetches — one retry, never a loop");
}

/* ── 9. writes can never be retried, even through this read client ── */

{
  const h = harness([netErr()]);
  await rejects(h.rpc("broadcast_tx_commit", {}), /Failed to fetch/,
    "a non-read method's failure surfaces");
  ok(h.calls.length === 1, "non-read method is NEVER retried (one fetch)");
}

/* ── 10. the caller surface is still reads only ── */

{
  ok(!/rpc\("broadcast/.test(src) && !/rpc\('broadcast/.test(src),
    "app.js never routes a broadcast through rpc()");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
