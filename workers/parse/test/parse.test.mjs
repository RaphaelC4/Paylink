/* M-02 tests: admission control for the Parse Worker.
 *
 * Covers valid requests (text + file), missing fields, malformed input,
 * oversized payloads, content types, method/path gates, the Origin gate,
 * both rate-limiter paths (durable binding + per-isolate fallback), the
 * upstream timeout, upstream failure mapping, and a sweep proving no
 * response ever exposes the API key, the system prompt or a stack trace.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts Gemini and
 * the key is a throwaway literal that exists only in this file. Every
 * ordinary test auto-increments its client IP (198.51.100.x, TEST-NET-2) so
 * the in-code rate-limit window cannot bleed between tests; the fixed
 * 203.0.113.x addresses (TEST-NET-3) are reserved for the limiter tests.
 */

import worker, { parseTimeoutMs } from "../src/index.js";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

const KEY = "test-key-4f9c1d-not-a-real-secret";
const ORIGIN = "https://paylink-near.vercel.app";
const realFetch = globalThis.fetch;

const baseEnv = (over = {}) => ({
  GEMINI_API_KEY: KEY,
  ALLOWED_ORIGIN: ORIGIN,
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  ...over,
});

let ipN = 0;
const nextIp = () => `198.51.100.${++ipN}`;

/* Every response body is recorded for the leak sweep at the end. */
const bodies = [];
/* Every stubbed upstream call is recorded for request-side hygiene checks. */
const geminiCalls = [];

function geminiOk(fields = {
  amount: "400",
  token: "USDC",
  payee: "chidi.testnet",
  description: "Logo work",
  expires_in_hours: 72,
}) {
  return async (url, init) => {
    geminiCalls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

/* Headers with a null value mean "omit this header" (the Headers constructor
   would otherwise stringify null into the literal "null"). */
async function post(body, env, headers = {}) {
  const h = { "content-type": "application/json", "CF-Connecting-IP": nextIp(), ...headers };
  for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
  const res = await worker.fetch(
    new Request("https://parse.test/", {
      method: "POST",
      headers: h,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.clone().text();
  bodies.push(text);
  return { res, text };
}

try {
  /* ── 1. valid requests ── */
  globalThis.fetch = geminiOk();
  {
    const { res, text } = await post({ text: "Chidi owes me 400 USDC for the logo work" }, baseEnv());
    const out = res.status === 200 ? JSON.parse(text) : null;
    ok(res.status === 200, "valid text request -> 200");
    ok(
      out &&
        out.amount === "400" &&
        out.token === "USDC" &&
        out.payee === "chidi.testnet" &&
        out.description === "Logo work" &&
        out.expires_in_hours === 72,
      "returns exactly the five fields with their values",
    );
    ok((res.headers.get("content-type") || "").includes("application/json"), "response content type is JSON");

    const call = geminiCalls.at(-1);
    ok(geminiCalls.length === 1, "exactly one upstream call for one request");
    ok(!call.url.includes(KEY), "API key never appears in the upstream URL");
    ok(call.url.includes("gemini-3.5-flash-lite"), "the configured model is used");
    ok(call.init.headers["x-goog-api-key"] === KEY, "API key travels only in the x-goog-api-key header");
    ok(call.init.body.includes("You extract payment request fields"), "system prompt is assembled server-side");
  }

  /* Field coercion: odd upstream types must still yield form-safe values. */
  {
    globalThis.fetch = geminiOk({
      amount: 400,
      token: null,
      payee: "  x  ",
      description: "d".repeat(300),
      expires_in_hours: -5,
    });
    const { res, text } = await post({ text: "anything" }, baseEnv());
    const out = JSON.parse(text);
    ok(res.status === 200, "odd upstream types still answer 200");
    ok(out.amount === "400" && out.token === "" && out.expires_in_hours === 0, "numbers/NULLs/negatives coerced to form-safe values");
    ok(out.payee === "x", "payee trimmed");
    ok(out.description.length === 200, "description clipped to 200 chars");
  }

  /* Valid file request, mirroring what frontend/app.js sends. */
  {
    globalThis.fetch = geminiOk();
    const data = Buffer.from("pretend png bytes").toString("base64");
    const { res } = await post({ filename: "shot.png", mime: "image/png", data }, baseEnv());
    ok(res.status === 200, "valid file request -> 200");
    const call = geminiCalls.at(-1);
    ok(call.init.body.includes(data), "upstream receives the base64 payload");
    ok(call.init.body.includes("Filename: shot.png"), "upstream receives the filename part");

    const longName = "n".repeat(180) + ".pdf";
    await post({ filename: longName, mime: "application/pdf", data }, baseEnv());
    const c2 = geminiCalls.at(-1);
    ok(
      c2.init.body.includes("Filename: " + "n".repeat(120)) && !c2.init.body.includes(longName),
      "filename capped at 120 chars before it leaves the Worker",
    );
  }

  /* ── 2. required fields ── */
  {
    const env = baseEnv();
    const cases = [
      [{}, "empty object"],
      [{ text: "   " }, "whitespace-only text"],
      [{ text: 123 }, "non-string text and no file"],
      [{ filename: "a.pdf", mime: "application/pdf" }, "file metadata without data"],
      [{ data: "", mime: "image/png" }, "empty file data"],
    ];
    for (const [body, label] of cases) {
      const { res, text } = await post(body, env);
      ok(res.status === 400 && JSON.parse(text).error === "Send text or a file", `400 for ${label}`);
    }
  }

  /* ── 3. malformed input ── */
  {
    const env = baseEnv();
    let r = await post('{"text": "unterminated', env);
    ok(r.res.status === 400 && JSON.parse(r.text).error === "Body must be JSON", "400 for broken JSON");

    r = await post(null, env);
    ok(
      r.res.status === 400 && JSON.parse(r.text).error === "Body must be a JSON object",
      "400 for JSON null (previously an unhandled 500)",
    );

    r = await post([1, 2, 3], env);
    ok(r.res.status === 400 && JSON.parse(r.text).error === "Body must be a JSON object", "400 for a JSON array");

    r = await post('"just a string"', env);
    ok(r.res.status === 400 && JSON.parse(r.text).error === "Body must be a JSON object", "400 for a JSON scalar string");

    r = await post(42, env);
    ok(r.res.status === 400 && JSON.parse(r.text).error === "Body must be a JSON object", "400 for a JSON number");

    r = await post({ filename: "a.pdf", mime: "application/pdf", data: "not base64!!" }, env);
    ok(
      r.res.status === 400 && JSON.parse(r.text).error === "File data is not valid base64",
      "400 for junk base64 (bad charset)",
    );

    r = await post({ filename: "a.pdf", mime: "application/pdf", data: "aGVsbG8" }, env);
    ok(
      r.res.status === 400 && JSON.parse(r.text).error === "File data is not valid base64",
      "400 for junk base64 (length not a multiple of 4)",
    );
  }

  /* ── 4. oversized payloads ── */
  {
    const env = baseEnv();
    let r = await post({ text: "x".repeat(4000) }, env);
    ok(r.res.status === 200, "exactly 4000 characters of text accepted");
    r = await post({ text: "x".repeat(4001) }, env);
    ok(r.res.status === 413 && JSON.parse(r.text).error === "Text is too long", "4001 characters -> 413");

    r = await post({ text: "small" }, env, { "content-length": "99999999" });
    ok(
      r.res.status === 413 && JSON.parse(r.text).error === "Request body too large",
      "declared Content-Length above 5.5 MB -> 413 before the body is read",
    );

    r = await post({ text: "x".repeat(5_800_000) }, env);
    ok(
      r.res.status === 413 && JSON.parse(r.text).error === "Request body too large",
      "undeclared 5.8 MB body -> 413 at the read-back gate",
    );

    r = await post({ filename: "big.pdf", mime: "application/pdf", data: "A".repeat(4_900_000) }, env);
    ok(
      r.res.status === 413 && JSON.parse(r.text).error === "File is too large (3.5 MB max)",
      "file over 3.5 MB decoded -> 413",
    );
  }

  /* ── 5. content types ── */
  {
    const env = baseEnv();
    let r = await post({ text: "hi" }, env, { "content-type": "application/x-www-form-urlencoded" });
    ok(r.res.status === 415 && JSON.parse(r.text).error === "Content-Type must be application/json", "form-encoded -> 415");
    r = await post({ text: "hi" }, env, { "content-type": "multipart/form-data; boundary=x" });
    ok(r.res.status === 415, "multipart -> 415");
    r = await post({ text: "hi" }, env, { "content-type": "application/json; charset=UTF-8" });
    ok(r.res.status === 200, "application/json with charset suffix -> 200");
    r = await post({ text: "hi" }, env, { "content-type": null });
    ok(r.res.status === 200, "no explicit content type (Node/curl default) -> 200");
  }

  /* ── 6. method + path gates ── */
  {
    const env = baseEnv();
    let res = await worker.fetch(new Request("https://parse.test/", { method: "GET" }), env);
    bodies.push(await res.clone().text());
    ok(res.status === 405, "GET -> 405");
    ok(res.headers.get("allow") === "POST", "405 carries Allow: POST");

    res = await worker.fetch(new Request("https://parse.test/", { method: "DELETE" }), env);
    bodies.push(await res.clone().text());
    ok(res.status === 405, "DELETE -> 405");

    res = await worker.fetch(new Request("https://parse.test/", { method: "OPTIONS" }), env);
    ok(res.status === 204, "OPTIONS preflight -> 204");
    ok(res.headers.get("access-control-allow-origin") === ORIGIN, "preflight echoes the allowed origin");

    res = await worker.fetch(
      new Request("https://parse.test/admin", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": nextIp() },
        body: JSON.stringify({ text: "hi" }),
      }),
      env,
    );
    bodies.push(await res.clone().text());
    ok(res.status === 404, "POST to a wrong path -> 404");
  }

  /* ── 7. origin gate ── */
  {
    const env = baseEnv();
    let r = await post({ text: "hi" }, env, { Origin: "https://evil.example" });
    ok(r.res.status === 403 && JSON.parse(r.text).error === "Origin not allowed", "foreign Origin -> 403");
    r = await post({ text: "hi" }, env, { Origin: ORIGIN });
    ok(r.res.status === 200, "the hosted frontend's Origin -> 200");
    r = await post({ text: "hi" }, env);
    ok(r.res.status === 200, "no Origin header (curl/README) -> 200");
    r = await post({ text: "hi" }, baseEnv({ ALLOWED_ORIGIN: "*" }), { Origin: "https://anywhere.example" });
    ok(r.res.status === 200, "ALLOWED_ORIGIN=* disables the gate (local testing)");
  }

  /* ── 8. rate limit: per-isolate fallback (no binding provisioned) ── */
  {
    const env = baseEnv();
    const ip = "203.0.113.60";
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const { res } = await post({ text: "invoice" }, env, { "CF-Connecting-IP": ip });
      statuses.push(res.status);
    }
    ok(statuses.every((s) => s === 200), "the first 10 requests in the window succeed");
    const eleventh = await post({ text: "invoice" }, env, { "CF-Connecting-IP": ip });
    ok(eleventh.res.status === 429, "the 11th request from the same IP -> 429");
    ok(eleventh.res.headers.get("retry-after") === "60", "429 carries Retry-After: 60");
    ok(JSON.parse(eleventh.text).error === "Too many requests", "429 body is a safe JSON error");
    const twelfth = await post({ text: "invoice" }, env, { "CF-Connecting-IP": ip });
    ok(twelfth.res.status === 429, "the window keeps rejecting (no single-burst bypass)");
    const other = await post({ text: "invoice" }, env, { "CF-Connecting-IP": "203.0.113.62" });
    ok(other.res.status === 200, "a different IP in the same window is unaffected");
  }

  /* ── 9. rate limit: durable binding path ── */
  {
    const keys = [];
    const bindingEnv = baseEnv({
      RATE_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: true };
        },
      },
    });
    let r = await post({ text: "hi" }, bindingEnv, { "CF-Connecting-IP": "203.0.113.61" });
    ok(r.res.status === 200, "binding success=true passes");
    r = await post({ text: "hi" }, bindingEnv, { "CF-Connecting-IP": "203.0.113.61" });
    ok(r.res.status === 200, "binding result is authoritative across requests");
    ok(
      keys.length === 2 && keys[0] === "203.0.113.61" && keys[1] === "203.0.113.61",
      "binding asked once per request with the client IP as the key",
    );

    const denyEnv = baseEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
    r = await post({ text: "hi" }, denyEnv, { "CF-Connecting-IP": "203.0.113.61" });
    ok(r.res.status === 429, "binding success=false -> 429");
    ok(r.res.headers.get("retry-after") === "60", "binding 429 also carries Retry-After");

    const brokenEnv = baseEnv({
      RATE_LIMITER: {
        limit: async () => {
          throw new Error("binding down");
        },
      },
    });
    r = await post({ text: "hi" }, brokenEnv, { "CF-Connecting-IP": "203.0.113.61" });
    ok(r.res.status === 200, "a throwing binding falls back to the local window instead of failing the request");

    const malformedEnv = baseEnv({ RATE_LIMITER: {} });
    r = await post({ text: "hi" }, malformedEnv, { "CF-Connecting-IP": "203.0.113.61" });
    ok(r.res.status === 200, "a binding without limit() degrades to the local window");
  }

  /* ── 10. upstream timeout ── */
  {
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const started = Date.now();
    const r = await post({ text: "hi" }, baseEnv({ PARSE_TIMEOUT_MS: "40" }));
    const elapsed = Date.now() - started;
    ok(r.res.status === 504, "hung upstream -> 504");
    ok(JSON.parse(r.text).error === "Gemini timed out", "504 body is the safe timeout message");
    ok(elapsed < 5_000, `the abort fires promptly (${elapsed} ms)`);
    ok(!r.text.includes(KEY), "504 body does not leak the key");
  }

  /* PARSE_TIMEOUT_MS bounds (unit). */
  ok(parseTimeoutMs({ PARSE_TIMEOUT_MS: "40" }) === 40, "PARSE_TIMEOUT_MS overrides the timeout");
  ok(parseTimeoutMs({}) === 15_000, "missing PARSE_TIMEOUT_MS -> 15 s default");
  ok(parseTimeoutMs({ PARSE_TIMEOUT_MS: "abc" }) === 15_000, "non-numeric timeout -> default");
  ok(parseTimeoutMs({ PARSE_TIMEOUT_MS: "-5" }) === 15_000, "negative timeout -> default");
  ok(parseTimeoutMs({ PARSE_TIMEOUT_MS: "999999999" }) === 15_000, "absurd timeout -> default (capped at 60 s)");

  /* ── 11. upstream failures stay safe ── */
  {
    /* This 500 body deliberately contains the key and a marker; the Worker
       logs it server-side (visible in this test's output on purpose) and
       must never hand it to the client. */
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "UPSTREAM-DETAIL-MARKER key=" + KEY } }), { status: 500 });
    let r = await post({ text: "hi" }, baseEnv());
    ok(r.res.status === 502 && JSON.parse(r.text).error === "Gemini returned 500", "Gemini 500 -> 502 with the status only");
    ok(!r.text.includes("UPSTREAM-DETAIL-MARKER"), "upstream detail never reaches the client");
    ok(!r.text.includes(KEY), "upstream 500 body does not leak the key");

    globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
    r = await post({ text: "hi" }, baseEnv());
    ok(r.res.status === 502 && JSON.parse(r.text).error === "Could not reach Gemini", "network failure -> 502 generic message");

    globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 200 });
    r = await post({ text: "hi" }, baseEnv());
    ok(r.res.status === 502 && JSON.parse(r.text).error === "Gemini response was unreadable", "non-JSON upstream body -> 502");

    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    r = await post({ text: "hi" }, baseEnv());
    ok(r.res.status === 422 && JSON.parse(r.text).error === "No reading came back", "empty candidate list -> 422");

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I refuse" }] } }] }), { status: 200 });
    r = await post({ text: "hi" }, baseEnv());
    ok(r.res.status === 422 && JSON.parse(r.text).error === "The reading was not JSON", "unparseable model output -> 422");

    r = await post({ text: "hi" }, baseEnv({ GEMINI_API_KEY: "" }));
    ok(r.res.status === 500 && JSON.parse(r.text).error === "GEMINI_API_KEY is not set", "missing key -> 500, never a silent pass");
  }

  /* ── 12. leak sweep across every captured response ── */
  {
    const all = bodies.join("\n");
    ok(!all.includes(KEY), `sweep: the API key appears in none of the ${bodies.length} captured bodies`);
    ok(!all.includes("You extract payment request fields"), "sweep: the system prompt appears in no response");
    ok(
      !all.includes("at Object.") && !all.includes("node:internal") && !all.includes("index.js:"),
      "sweep: no stack-trace fragment appears in any response",
    );
    ok(!all.includes("UPSTREAM-DETAIL-MARKER"), "sweep: no upstream detail appears in any response");
    ok(bodies.length >= 45, `sweep ran over a meaningful sample (${bodies.length} responses)`);
  }
} catch (e) {
  fail++;
  console.log("FAIL  unexpected error:", e && e.message);
  console.log(e && e.stack);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
