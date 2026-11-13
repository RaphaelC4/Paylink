/* Relayer origin/CORS tests — run with: node workers/relayer/test/origin.test.mjs
 *
 * The relayer is CORS-only by design (no 403 gate — a script ignores the
 * header, see src/index.js). ALLOWED_ORIGIN is a comma-separated
 * exact-match allowlist: every response must echo the REQUESTING origin
 * only when it is on that list, never a wildcard, never a foreign origin,
 * and preflight must behave exactly like actual requests.
 */

import worker from "../src/index.js";

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

const ORIGIN = "https://paylink-near.vercel.app";
const STAGING = "https://paylink-git-staging-raphael-c4.vercel.app";

const baseEnv = (over = {}) => ({
  CONTRACT_ID: "paylink-v2.testnet",
  RELAYER_ACCOUNT: "paylink-relay.testnet",
  ALLOWED_ORIGIN: `${ORIGIN},${STAGING}`,
  ...over,
});

const acao = (res) => res.headers.get("access-control-allow-origin");

const run = (path, env, headers = {}, method = "GET") =>
  worker.fetch(new Request(`https://relayer.test${path}`, { method, headers }), env);

try {
  /* 1. Both allowed origins pass and are echoed back. */
  {
    let res = await run("/", baseEnv(), { Origin: ORIGIN });
    const body = JSON.parse(await res.text());
    ok(res.status === 200 && body.ok === true, "two origins: production Origin -> 200 ok");
    ok(acao(res) === ORIGIN, "two origins: production Origin is echoed in ACAO");

    res = await run("/", baseEnv(), { Origin: STAGING });
    ok(res.status === 200, "two origins: staging Origin -> 200");
    ok(acao(res) === STAGING, "two origins: staging Origin is echoed in ACAO");
  }

  /* 2. An unapproved origin is never 403-gated (CORS-only design) but never
        receives an ACAO matching itself either. */
  {
    const res = await run("/", baseEnv(), { Origin: "https://evil.example" });
    ok(res.status === 200, "unapproved Origin is not 403-gated (relayer stays CORS-only)");
    ok(acao(res) === ORIGIN, "unapproved Origin is never echoed (first configured origin)");
    ok(acao(res) !== "https://evil.example", "ACAO never matches the unapproved origin");

    const sup = await run("/", baseEnv(), { Origin: `${ORIGIN}.evil.example` });
    ok(acao(sup) !== `${ORIGIN}.evil.example`, "a superstring of an allowed origin does not match (exact match only)");
  }

  /* 3. Missing Origin header: request passes, ACAO = first configured origin
        (single-origin deployments keep their exact previous bytes). */
  {
    const res = await run("/", baseEnv());
    ok(res.status === 200, "no Origin header -> 200");
    ok(acao(res) === ORIGIN, "no Origin header -> ACAO = first configured origin");
  }

  /* 4. OPTIONS preflight behaves exactly like actual requests. */
  {
    let res = await run("/", baseEnv(), { Origin: STAGING }, "OPTIONS");
    ok(res.status === 204, "preflight: staging Origin -> 204");
    ok(acao(res) === STAGING, "preflight: staging Origin is echoed");

    res = await run("/", baseEnv(), { Origin: ORIGIN }, "OPTIONS");
    ok(res.status === 204 && acao(res) === ORIGIN, "preflight: production Origin is echoed");

    res = await run("/", baseEnv(), { Origin: "https://evil.example" }, "OPTIONS");
    ok(res.status === 204 && acao(res) === ORIGIN,
      "preflight: unapproved Origin -> 204, ACAO never matches it");

    res = await run("/", baseEnv(), {}, "OPTIONS");
    ok(res.status === 204 && acao(res) === ORIGIN,
      "preflight: no Origin -> 204, ACAO = first configured origin");
  }

  /* 5. Configuration edge cases: single-origin parity, explicit * escape
        hatch, whitespace trimming. */
  {
    let res = await run("/", baseEnv({ ALLOWED_ORIGIN: ORIGIN }), { Origin: ORIGIN });
    ok(res.status === 200 && acao(res) === ORIGIN, "single-origin config behaves exactly as before");

    res = await run("/", baseEnv({ ALLOWED_ORIGIN: ORIGIN }), { Origin: STAGING });
    ok(acao(res) !== STAGING, "staging absent from config -> staging origin not echoed");

    res = await run("/", baseEnv({ ALLOWED_ORIGIN: "*" }), { Origin: "https://anywhere.example" });
    ok(acao(res) === "*", "explicit * still echoes * (local-testing escape hatch preserved)");

    res = await run("/", baseEnv({ ALLOWED_ORIGIN: ` ${STAGING} , ${ORIGIN} ` }), { Origin: STAGING });
    ok(res.status === 200 && acao(res) === STAGING, "allowlist entries are trimmed (whitespace around commas)");
  }
} catch (e) {
  fail++;
  console.log("FAIL  unexpected error:", e && e.message);
  console.log(e && e.stack);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
