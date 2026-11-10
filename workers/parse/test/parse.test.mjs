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
       logs it server-side as a structured upstream_error line with the
       configured key REDACTED by value (asserted in 11b below) and must
       never hand it to the client. */
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

  /* ── 11b. M-01: structured logging, correlation ids, alert triggers ──
     One JSON line per event. `around` captures ONLY the console output of
     the request under test (ok/FAIL lines keep printing) and returns the
     parsed events that call produced, so assertions never see a previous
     test's lines. globalThis.fetch stays stubbed as in section 11. */
  {
    const captured = [];
    const baseLog = console.log;
    const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
    const around = async (fn) => {
      const start = captured.length;
      console.log = (...a) => captured.push(a.join(" "));
      try {
        const value = await fn();
        return { value, evs: captured.slice(start).map(parse).filter(Boolean) };
      } finally {
        console.log = baseLog;
      }
    };

    /* a. parse_ok: envelope + correlation, and NO user data in the line */
    globalThis.fetch = geminiOk();
    {
      const sample = "Chidi owes me 400 USDC for the logo work";
      const ip = "198.51.100.211";
      const { value: { res }, evs } = await around(() =>
        post({ text: sample }, baseEnv(), { "CF-Connecting-IP": ip }));
      ok(res.status === 200, "M-01: a valid request still 200 under structured logging");
      const ridHdr = res.headers.get("x-request-id");
      ok(typeof ridHdr === "string" && ridHdr.length === 8, "POST response carries an 8-char X-Request-Id");
      const [ev] = evs.filter((e) => e.event === "parse_ok");
      ok(ev && ev.rid === ridHdr, "parse_ok shares the response's rid (one trace end to end)");
      ok(ev && ev.svc === "paylink-parse" && ev.build === "20261110b" && ev.level === "info"
        && typeof ev.ts === "string", "line carries the ts/svc/build/level envelope");
      ok(ev && ev.source === "text" && ev.chars === sample.length && typeof ev.ms === "number"
        && ev.ip === ip, "parse_ok records source/size/duration/ip — operational facts only");
      const line = JSON.stringify(evs);
      ok(!line.includes("Chidi owes") && !line.includes("chidi.testnet") && !line.includes("Logo work"),
        "no request text and no parsed field values appear in any line");
      ok(!line.includes(KEY), "the API key appears in no line");
    }

    /* b. the GET-signal contract: 405 + Allow: POST, untouched by M-01 */
    {
      const res = await worker.fetch(new Request("https://parse.test/"), baseEnv());
      ok(res.status === 405 && res.headers.get("allow") === "POST",
        "GET / still 405 with Allow: POST (deploy signal preserved)");
      ok(res.headers.get("x-request-id") === null,
        "the 405 response gains no correlation header — only POST / is instrumented");
    }

    /* c. parse_rejected: reason codes + rid correlation */
    {
      const { value: r, evs } = await around(() => post("this is not json", baseEnv()));
      ok(r.res.status === 400, "malformed body still 400");
      const [ev] = evs.filter((e) => e.event === "parse_rejected");
      ok(ev && ev.reason === "bad_json" && ev.status === 400
        && ev.rid === r.res.headers.get("x-request-id"),
        "bad_json reject logged with status and the response's rid");

      const r2 = await around(() => post({}, baseEnv()));
      ok(r2.value.res.status === 400, "empty object still 400");
      ok(r2.evs.some((e) => e.event === "parse_rejected" && e.reason === "no_content"),
        "empty body logs reason no_content");

      const r3 = await around(() => post({ text: "hi" }, baseEnv(), { Origin: "https://evil.example" }));
      ok(r3.value.res.status === 403, "cross-origin still 403");
      ok(r3.evs.some((e) => e.event === "parse_rejected" && e.reason === "origin_not_allowed"
        && e.status === 403), "origin gate logs reason origin_not_allowed");
    }

    /* d. rate_limited: the 11th request logs a warn with the rid */
    {
      const ip = "203.0.113.70";
      let last = null;
      for (let i = 0; i < 10; i++) {
        last = await around(() => post({ text: "invoice" }, baseEnv(), { "CF-Connecting-IP": ip }));
      }
      ok(last.value.res.status === 200, "the first 10 from one IP pass");
      const { value: r, evs } = await around(() =>
        post({ text: "invoice" }, baseEnv(), { "CF-Connecting-IP": ip }));
      ok(r.res.status === 429, "the 11th -> 429");
      const [ev] = evs.filter((e) => e.event === "rate_limited");
      ok(ev && ev.level === "warn" && ev.status === 429 && ev.retry_after === 60 && ev.ip === ip,
        "429 logs rate_limited/warn with retry_after and the limiter key");
      ok(ev && ev.rid === r.res.headers.get("x-request-id"),
        "rate_limited is correlated to the 429 response");
    }

    /* e. upstream_error: bounded detail, key redacted BY VALUE */
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "UPSTREAM-DETAIL-MARKER key=" + KEY } }), { status: 500 });
    {
      const { value: r, evs } = await around(() => post({ text: "hi" }, baseEnv()));
      ok(r.res.status === 502, "upstream 500 still maps to 502");
      const [ev] = evs.filter((e) => e.event === "upstream_error");
      ok(ev && ev.level === "error" && ev.kind === "http_status" && ev.status === 500,
        "upstream failure logs upstream_error with kind and status");
      ok(ev && ev.detail.includes("UPSTREAM-DETAIL-MARKER"),
        "bounded upstream detail is kept server-side for debugging");
      ok(ev && ev.detail.includes("[redacted-key]") && !ev.detail.includes(KEY),
        "…but the configured API key is redacted out of it");
      ok(ev && ev.detail.length <= 240, "upstream detail capped at 240 chars");
      ok(ev && ev.rid === r.res.headers.get("x-request-id"), "upstream_error carries the rid");
    }

    /* f. upstream_degraded: the fifth failure in five minutes alerts once,
       delivered to the webhook. Earlier suite failures already filled the
       window, so the clock slides forward to start a fresh one. */
    {
      const posts = [];
      const realNow = Date.now;
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith("https://hooks.test/")) {
          posts.push(JSON.parse(init.body));
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 });
      };
      const wEnv = { ...baseEnv(), ALERT_WEBHOOK_URL: "https://hooks.test/parse" };
      let all = [];
      try {
        Date.now = () => realNow() + 6 * 60_000;
        for (let i = 0; i < 5; i++) {
          const c = await around(() => post({ text: "hi" }, wEnv));
          all = all.concat(c.evs);
        }
      } finally {
        Date.now = realNow;
        globalThis.fetch = geminiOk();
      }
      ok(all.filter((e) => e.event === "upstream_error").length === 5,
        "each of the five failures logs upstream_error");
      const d = all.filter((e) => e.event === "upstream_degraded");
      ok(d.length === 1 && d[0].level === "alert" && d[0].count === 5 && d[0].window_s === 300,
        "the fifth failure fires exactly one upstream_degraded alert");
      await new Promise((resolve) => setTimeout(resolve, 30));
      ok(posts.length === 1 && posts[0].event === "upstream_degraded"
        && posts[0].svc === "paylink-parse" && posts[0].level === "alert",
        "the alert is POSTed to ALERT_WEBHOOK_URL as the full record");
      ok(!posts.some((p) => JSON.stringify(p).includes("hooks.test")),
        "the webhook payload never echoes its own destination URL");
    }

    /* g. service_error: an unexpected exception is logged, then generic 500 */
    {
      /* a bare object whose URL is syntactically invalid trips new URL()
         inside the handler — the one path no admission test can reach */
      const { value: res, evs } = await around(() =>
        worker.fetch({ method: "POST", url: "http://[bad", headers: { get: () => null } }, baseEnv()));
      ok(res.status === 500, "an unexpected exception answers a generic 500");
      const txt = await res.text();
      bodies.push(txt);
      ok(JSON.parse(txt).error === "internal error", "…with a generic message, no internals");
      const [ev] = evs.filter((e) => e.event === "service_error");
      ok(ev && ev.level === "error" && typeof ev.error === "string",
        "the exception is logged as service_error at level=error");
      ok(!txt.includes("index.js") && !txt.includes("at Object"),
        "the response carries no stack trace");
    }
  }

  /* ── 11c. L-06: one AbortController bounds the WHOLE Gemini exchange ──
     M-02 already aborted a hung fetch. L-06 covers the two legs the old
     code missed: a stall while reading the ERROR body (was misclassified
     as http_status -> 502; must be timeout -> 504) and timer cleanup on
     every exit path (single clearTimeout in a finally). Own console
     capture: these upstream_error lines must never be read by 11b's
     assertions, and none may open a fresh degraded-alert window (11b
     already alerted once, which keeps upAlerted set for this block). */
  {
    const captured = [];
    const baseLog = console.log;
    const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
    const around = async (fn) => {
      const start = captured.length;
      console.log = (...a) => captured.push(a.join(" "));
      try {
        const value = await fn();
        return { value, evs: captured.slice(start).map(parse).filter(Boolean) };
      } finally {
        console.log = baseLog;
      }
    };

    /* A stub whose RESPONSE BODY never arrives: the read settles only when
       the Worker's own abort signal fires — exactly what a stalled upstream
       leg does. status 200 exercises the success read (.json), 503 the
       error read (.text). */
    const stalledBody = (status) => (_url, init) =>
      Promise.resolve(new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => {
              try { controller.error(new Error("The operation was aborted")); }
              catch { /* stream already closed */ }
            });
          },
        }),
        { status },
      ));

    /* a. slow but inside the budget: parsing still succeeds, and the abort
       timer is cancelled afterwards — no late abort can fire post-success. */
    {
      let seen = null;
      globalThis.fetch = async (_url, init) => {
        seen = init.signal;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
            amount: "400", token: "USDC", payee: "chidi.testnet",
            description: "Slow but fine", expires_in_hours: 72,
          }) }] } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const { value: r } = await around(() =>
        post({ text: "hi" }, baseEnv({ PARSE_TIMEOUT_MS: "400" })));
      ok(r.res.status === 200, "L-06: a slow response inside the budget still parses");
      ok(JSON.parse(r.text).description === "Slow but fine", "…with its fields intact");
      await new Promise((resolve) => setTimeout(resolve, 450)); // past the 400 ms budget
      ok(seen && !seen.aborted, "the abort timer was cleared — no late abort after success");
    }

    /* b. stall during the SUCCESS body read: headers arrived, the body
       never does -> abort mid-read -> 504 kind=timeout, promptly. */
    {
      globalThis.fetch = stalledBody(200);
      const t0 = Date.now();
      const { value: r, evs } = await around(() =>
        post({ text: "hi" }, baseEnv({ PARSE_TIMEOUT_MS: "60" })));
      const elapsed = Date.now() - t0;
      ok(r.res.status === 504 && JSON.parse(r.text).error === "Gemini timed out",
        "stalled success body -> 504 Gemini timed out");
      ok(elapsed < 5_000, `the abort fires promptly (${elapsed} ms)`);
      const [ev] = evs.filter((e) => e.event === "upstream_error");
      ok(ev && ev.kind === "timeout" && ev.level === "error", "logged as upstream_error kind=timeout");
      ok(!r.text.includes(KEY), "the 504 body does not leak the key");
    }

    /* c. L-06 REGRESSION: stall during the ERROR body read (503). The old
       catch fell through to http_status and answered 502; the budget
       covers this leg too, so it must be 504 kind=timeout. */
    {
      globalThis.fetch = stalledBody(503);
      const t0 = Date.now();
      const { value: r, evs } = await around(() =>
        post({ text: "hi" }, baseEnv({ PARSE_TIMEOUT_MS: "60" })));
      const elapsed = Date.now() - t0;
      ok(r.res.status === 504 && JSON.parse(r.text).error === "Gemini timed out",
        "stalled ERROR body -> 504 (was 502 http_status before L-06)");
      ok(elapsed < 5_000, `the error-body abort fires promptly (${elapsed} ms)`);
      const [ev] = evs.filter((e) => e.event === "upstream_error");
      ok(ev && ev.kind === "timeout", "classified as kind=timeout, not http_status");
      ok(!r.text.includes(KEY) && !r.text.includes("503"),
        "the 504 echoes neither the key nor a status it never read");
    }

    /* d. upstream 4xx and 5xx: one safe 502 carrying only the status
       number — no upstream body, no key, kind=http_status in the log. */
    {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: { message: "UPSTREAM-DETAIL-MARKER key=" + KEY } }), { status: 429 });
      const a = await around(() => post({ text: "hi" }, baseEnv()));
      ok(a.value.res.status === 502 && JSON.parse(a.value.text).error === "Gemini returned 429",
        "upstream 429 -> 502 with the status only");
      ok(!a.value.text.includes(KEY) && !a.value.text.includes("UPSTREAM-DETAIL-MARKER"),
        "the 429 mapping leaks neither key nor upstream detail");
      const [evA] = a.evs.filter((e) => e.event === "upstream_error");
      ok(evA && evA.kind === "http_status" && evA.status === 429, "429 logged kind=http_status");

      globalThis.fetch = async () => new Response("bad request from upstream", { status: 400 });
      const b = await around(() => post({ text: "hi" }, baseEnv()));
      ok(b.value.res.status === 502 && JSON.parse(b.value.text).error === "Gemini returned 400",
        "upstream 400 -> 502 with the status only");
      ok(!b.value.text.includes("bad request from upstream"),
        "the upstream error text never reaches the client");
      const [evB] = b.evs.filter((e) => e.event === "upstream_error");
      ok(evB && evB.kind === "http_status" && evB.status === 400, "400 logged kind=http_status");
    }

    /* e. network failure and invalid JSON keep their OWN kinds — neither
       is ever reported as a timeout. */
    {
      globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
      const a = await around(() => post({ text: "hi" }, baseEnv()));
      ok(a.value.res.status === 502 && JSON.parse(a.value.text).error === "Could not reach Gemini",
        "network failure -> 502 generic message");
      const [evA] = a.evs.filter((e) => e.event === "upstream_error");
      ok(evA && evA.kind === "unreachable", "network failure logged kind=unreachable");

      globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 200 });
      const b = await around(() => post({ text: "hi" }, baseEnv()));
      ok(b.value.res.status === 502 && JSON.parse(b.value.text).error === "Gemini response was unreadable",
        "invalid JSON -> 502 unreadable");
      const [evB] = b.evs.filter((e) => e.event === "upstream_error");
      ok(evB && evB.kind === "unreadable", "invalid JSON logged kind=unreadable, not timeout");
    }

    globalThis.fetch = geminiOk();
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
