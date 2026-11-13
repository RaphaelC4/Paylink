/* Phase 2 tests: dynamic network/token discovery for the Tidepool Worker.
 *
 * Covers the spec's list end to end — successful discovery, multiple
 * networks, multiple tokens on one network, empty results, unavailable
 * chains, upstream errors, timeouts, malformed responses, cache behaviour,
 * CORS restrictions and invalid requests — plus two repo-standard sweeps:
 * no response ever exposes an upstream detail or a stack trace, and every
 * log line carries the M-01 envelope.
 *
 * globalThis.fetch is stubbed throughout — nothing here contacts
 * Tidepool. Fixtures are trimmed captures of the real /v0/tokens and
 * /v0/health shapes (assetId/decimals/blockchain/symbol/price/
 * contractAddress/coingeckoId; bridges.chains.<chain>.{ok,name}), so the
 * curation assertions prove real upstream keys get dropped. The cache is
 * disabled by default (TIDEPOOL_CACHE_MS=0) so tests stay hermetic;
 * cache tests opt in explicitly and reset through clearDiscoveryCache().
 */

import worker, { clearDiscoveryCache, discoveryTtlMs, logEvent, tidepoolTimeoutMs } from "../src/index.js";

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
const BASE = "https://tidepool.test";
const realFetch = globalThis.fetch;
const realNow = Date.now;

const baseEnv = (over = {}) => ({
  ALLOWED_ORIGIN: ORIGIN,
  TIDEPOOL_ORIGIN: BASE,
  TIDEPOOL_CACHE_MS: "0", // hermetic default; cache tests opt in
  ...over,
});

/* Every response body is recorded for the leak sweep at the end. */
const bodies = [];

/* Trimmed captures of the live response shapes (11 Nov 2026). The extra
   keys (price, priceUpdatedAt, coingeckoId, note, vault, chainId…) exist
   to prove curation strips them. */
const TOKENS = [
  {
    assetId: "nep141:usdc.tidepool-sandbox.testnet",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    price: 0.999531,
    priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "usdc.tidepool-sandbox.testnet",
    coingeckoId: "usd-coin",
  },
  {
    assetId: "nep141:wnear.tidepool-sandbox.testnet",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 1.19,
    priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "wnear.tidepool-sandbox.testnet",
    coingeckoId: "near",
  },
  {
    assetId: "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 0.999571,
    priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    contractAddress: "0x38d81431B9f76d9699AF7517040D5221D9dEA252",
    coingeckoId: "usd-coin",
  },
  {
    // native-asset wrapper: upstream omits contractAddress entirely
    assetId: "nep141:xrp.tp-omft.testnet",
    decimals: 6,
    blockchain: "xrp",
    symbol: "XRP",
    price: 2.31,
    priceUpdatedAt: "2026-11-11T03:16:02.469Z",
    coingeckoId: "ripple",
  },
];

const HEALTH = {
  ok: true,
  service: "tidepool",
  network: "testnet",
  verifier: "verifier.tidepool-sandbox.testnet",
  checks: {
    rpc: { ok: true, height: 57227655, ms: 42 },
    verifier: { ok: true, codeHashHex: "a1afab98" },
    prices: { ok: true, source: "coingecko", updatedAt: "2026-11-11T03:16:00.000Z" },
    makerInventory: { ok: true, balances: { USDC: "199739.051353" } },
  },
  bridges: {
    note: "Testnet bridges (EVM chains, Solana devnet…): trusted relayer run by Tidepool.",
    chains: {
      base: { ok: true, name: "Base Sepolia", chainId: 84532, vault: "0x2e6AD9E6D59bB4585ea0E6762c3b637dde29DAD2" },
      xrp: { ok: false, name: "XRP Ledger Testnet" },
    },
  },
  swaps: { total: 621, success: 414, refunded: 26, failed: 3 },
};

/* Route stub: /v0/tokens vs /v0/health, with per-leg failure knobs.
   Returns the call log so tests can assert upstream hygiene. */
function stub(opts = {}) {
  clearDiscoveryCache();
  const calls = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const isTokens = u.includes("/v0/tokens");
    const leg = isTokens ? "tokens" : "health";
    if (opts.hang === leg) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    }
    if (opts[`${leg}Error`]) return Promise.reject(new TypeError("fetch failed"));
    const status = opts[`${leg}Status`] ?? 200;
    let body = opts[`${leg}Body`];
    if (body === undefined) {
      body = status === 200
        ? JSON.stringify(isTokens ? TOKENS : HEALTH)
        : JSON.stringify({ error: { message: `UPSTREAM-DETAIL-MARKER ${leg} ${"x".repeat(1000)}` } });
    }
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  };
  return calls;
}

async function get(path = "/networks", env = baseEnv(), headers = {}) {
  const res = await worker.fetch(new Request(`https://paylink.test${path}`, { method: "GET", headers }), env);
  const text = await res.clone().text();
  bodies.push(text);
  let out = null;
  try { out = JSON.parse(text); } catch { /* error bodies are asserted as text */ }
  return { res, text, out };
}

async function method(m, path = "/networks", env = baseEnv(), headers = {}) {
  const res = await worker.fetch(new Request(`https://paylink.test${path}`, { method: m, headers }), env);
  const text = await res.clone().text();
  bodies.push(text);
  return { res, text };
}

/* Capture only the console output produced inside fn (ok/FAIL lines keep
   printing) and return the parseable events it emitted. */
async function around(fn) {
  const captured = [];
  const baseLog = console.log;
  console.log = (...a) => captured.push(a.join(" "));
  try {
    const value = await fn();
    return { value, evs: captured.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
  } finally {
    console.log = baseLog;
  }
}

try {
  /* ── 1. successful discovery: grouping, curation, counts ── */
  {
    const calls = stub();
    const { res, out } = await get();
    ok(res.status === 200, "valid discovery -> 200");
    ok((res.headers.get("content-type") || "").includes("application/json"), "response content type is JSON");
    ok(res.headers.get("cache-control") === "no-store", "200 is Cache-Control: no-store (server cache owns freshness)");
    const rid = res.headers.get("x-request-id");
    ok(typeof rid === "string" && rid.length === 8 && /^[0-9a-f]{8}$/.test(rid), "200 carries an 8-hex X-Request-Id");

    ok(Array.isArray(out.networks) && out.networks.length === 3, "three networks grouped (near, base, xrp)");
    ok(out.count.networks === 3 && out.count.tokens === 4, "count matches the grouped reality (3/4)");
    ok(out.cached === false && out.cacheSeconds === 0, "first read is uncached; TTL 0 reported when caching is off");
    ok(typeof out.fetchedAt === "string" && !Number.isNaN(Date.parse(out.fetchedAt)), "fetchedAt is an ISO timestamp");

    const [near, baseG, xrp] = out.networks;
    ok(near.blockchain === "near" && baseG.blockchain === "base" && xrp.blockchain === "xrp",
      "networks keep upstream first-seen order");
    ok(near.tokens.length === 2, "multiple tokens on one network stay on one network");
    ok(baseG.tokens.length === 1 && xrp.tokens.length === 1, "single-token networks grouped correctly");

    ok(near.name === null, "NEAR has no bridge-chain name in health -> null (not invented)");
    ok(baseG.name === "Base Sepolia" && xrp.name === "XRP Ledger Testnet", "chain names come from health");
    ok(near.availability === "native", "NEAR with healthy rpc+verifier -> native");
    ok(baseG.availability === "bridge-ok", "bridge chain with ok:true -> bridge-ok");
    ok(xrp.availability === "bridge-down", "bridge chain with ok:false -> bridge-down");

    const usdc = near.tokens[0];
    ok(usdc.assetId === "nep141:usdc.tidepool-sandbox.testnet" && usdc.symbol === "USDC"
      && usdc.decimals === 6 && usdc.contractAddress === "usdc.tidepool-sandbox.testnet",
      "token carries exactly the documented fields with their values");
    ok(xrp.tokens[0].contractAddress === null, "absent upstream contractAddress becomes null, not undefined");
    for (const n of out.networks) {
      for (const t of n.tokens) {
        const keys = Object.keys(t).sort().join(",");
        if (keys !== "assetId,contractAddress,decimals,symbol") {
          ok(false, `token keys curated (got ${keys})`);
          pass--; fail++; // counted once above; keep the loop honest
        }
      }
    }
    ok(true, "every token exposes only assetId/symbol/decimals/contractAddress");
    const flat = JSON.stringify(out);
    ok(!flat.includes('"price"') && !flat.includes("priceUpdatedAt") && !flat.includes("coingeckoId"),
      "price/priceUpdatedAt/coingeckoId never leave the Worker");
    ok(!flat.includes("vault") && !flat.includes("makerInventory") && !flat.includes("swaps"),
      "health internals (vault/inventory/swap stats) are never exposed");

    ok(calls.length === 2, "exactly two upstream calls (tokens then health)");
    ok(calls[0].url === `${BASE}/v0/tokens` && calls[1].url === `${BASE}/v0/health`,
      "upstream URLs are the configured origin's /v0/tokens and /v0/health");
    ok(calls.every((c) => c.init.method === undefined || c.init.method === "GET"), "upstream calls are GET");
    const hdrs = calls[0].init.headers || {};
    ok(hdrs.accept === "application/json", "accept: application/json upstream");
    ok(!("authorization" in hdrs) && !("x-api-key" in hdrs),
      "no credential header is invented or sent (keyless API)");
  }

  /* ── 2. trailing-slash origin config still builds clean URLs ── */
  {
    stub();
    const { res, out } = await get("/networks", baseEnv({ TIDEPOOL_ORIGIN: `${BASE}///` }));
    ok(res.status === 200 && out.count.tokens === 4, "TIDEPOOL_ORIGIN with trailing slashes still works");
  }

  /* ── 3. health is optional: degradation never fails discovery ── */
  {
    /* a. health endpoint down */
    stub({ healthStatus: 503 });
    let r = await get();
    ok(r.res.status === 200, "health 503 -> discovery still 200 (health is optional)");
    ok(r.out.networks.every((n) => n.availability === "unverified"),
      "health failure degrades EVERY chain to unverified — fail closed, no guessing");
    ok(r.out.networks.every((n) => n.name === null), "no chain names when health is unavailable");

    /* b. health unreachable */
    stub({ healthError: true });
    r = await get();
    ok(r.res.status === 200 && r.out.networks.every((n) => n.availability === "unverified"),
      "health network failure -> 200 with unverified availability");

    /* c. health returns non-JSON / non-object */
    stub({ healthBody: "<html>gateway</html>" });
    r = await get();
    ok(r.res.status === 200 && r.out.networks.every((n) => n.availability === "unverified"),
      "health unreadable -> 200 with unverified availability");
    stub({ healthBody: JSON.stringify([1, 2, 3]) });
    r = await get();
    ok(r.res.status === 200 && r.out.networks.every((n) => n.availability === "unverified"),
      "health as a JSON array (wrong shape) -> 200 with unverified availability");

    /* d. NEAR's own checks say no */
    stub({ healthBody: JSON.stringify({ ...HEALTH, checks: { ...HEALTH.checks, rpc: { ok: false } } }) });
    r = await get();
    ok(r.res.status === 200 && r.out.networks[0].availability === "unverified",
      "NEAR with rpc check false -> unverified, not native");
    ok(r.out.networks[1].availability === "bridge-ok",
      "…while a healthy bridge chain is unaffected by NEAR's checks");

    /* e. health knows its bridges but not this chain */
    const ghost = [...TOKENS, { assetId: "nep141:ghost.tp-omft.testnet", decimals: 6, blockchain: "ghost", symbol: "GST" }];
    stub({ tokensBody: JSON.stringify(ghost) });
    r = await get();
    const ghostG = r.out.networks.find((n) => n.blockchain === "ghost");
    ok(r.res.status === 200 && ghostG && ghostG.availability === "unsupported",
      "a chain absent from health's bridge list -> unsupported (not ok)");
    ok(ghostG.name === null, "unsupported chain has no invented name");
  }

  /* ── 4. empty token results ── */
  {
    stub({ tokensBody: "[]" });
    const { res, out } = await get();
    ok(res.status === 200, "empty upstream list -> 200, not an error");
    ok(Array.isArray(out.networks) && out.networks.length === 0, "networks is an empty array");
    ok(out.count.networks === 0 && out.count.tokens === 0, "counts are zero");
    ok(out.cached === false, "empty result reports uncached");
  }

  /* ── 5. upstream errors on the essential leg stay safe ── */
  {
    stub({ tokensStatus: 500 });
    let r = await get();
    ok(r.res.status === 502 && r.out.error === "Tidepool returned 500", "tokens 500 -> 502 with the status only");
    ok(!r.text.includes("UPSTREAM-DETAIL-MARKER"), "upstream error body never reaches the client");

    stub({ tokensError: true });
    r = await get();
    ok(r.res.status === 502 && r.out.error === "Could not reach Tidepool", "network failure -> 502 generic message");

    stub({ tokensBody: "<html>gateway</html>" });
    r = await get();
    ok(r.res.status === 502 && r.out.error === "Tidepool response was unreadable", "non-JSON tokens -> 502 unreadable");

    stub({ tokensStatus: 429 });
    r = await get();
    ok(r.res.status === 502 && r.out.error === "Tidepool returned 429", "tokens 429 -> 502, upstream detail withheld");
    ok(!r.text.includes("UPSTREAM-DETAIL-MARKER"), "429 body does not leak the upstream message");
  }

  /* ── 6. malformed token payloads ── */
  {
    stub({ tokensBody: JSON.stringify({ tokens: TOKENS }) });
    let r = await get();
    ok(r.res.status === 502 && r.out.error === "Tidepool response was malformed",
      "JSON object instead of an array -> 502 malformed");

    stub({ tokensBody: JSON.stringify([{ junk: 1 }, { junk: 2 }]) });
    r = await get();
    ok(r.res.status === 502 && r.out.error === "Tidepool response was malformed",
      "array where NOTHING validates (schema drift) -> 502, not an empty list");

    stub({ tokensBody: JSON.stringify([null, "string", 42, { assetId: 5 }]) });
    r = await get();
    ok(r.res.status === 502, "array of non-objects -> 502");

    /* partially-valid payload: junk is dropped, good tokens survive */
    stub({ tokensBody: JSON.stringify([TOKENS[0], { bad: true }, { ...TOKENS[2], decimals: "six" }, null, TOKENS[3]]) });
    r = await get();
    ok(r.res.status === 200 && r.out.count.tokens === 2,
      "mixed payload -> 200 serving only the items that validate");
    ok(r.out.networks.length === 2, "dropped items do not create networks");
  }

  /* ── 7. timeouts ── */
  {
    stub({ hang: "tokens" });
    const started = Date.now();
    const r = await get("/networks", baseEnv({ TIDEPOOL_TIMEOUT_MS: "40" }));
    const elapsed = Date.now() - started;
    ok(r.res.status === 504 && r.out.error === "Tidepool timed out", "hung tokens -> 504 with the safe message");
    ok(elapsed < 5_000, `the abort fires promptly (${elapsed} ms)`);
    ok(!r.text.includes("UPSTREAM-DETAIL-MARKER"), "504 body leaks nothing");

    /* health hangs after tokens succeeded: discovery still answers */
    stub({ hang: "health" });
    const t0 = Date.now();
    const r2 = await get("/networks", baseEnv({ TIDEPOOL_TIMEOUT_MS: "60" }));
    ok(r2.res.status === 200 && r2.out.count.tokens === 4, "hung health -> tokens still served, 200");
    ok(r2.out.networks.every((n) => n.availability === "unverified"),
      "hung health -> availability unverified (the shared budget was spent)");
    ok(Date.now() - t0 < 5_000, "the health abort also fires promptly");

    /* unit: timeout bounds */
    ok(tidepoolTimeoutMs({ TIDEPOOL_TIMEOUT_MS: "40" }) === 40, "TIDEPOOL_TIMEOUT_MS overrides the timeout");
    ok(tidepoolTimeoutMs({}) === 5_000, "missing TIDEPOOL_TIMEOUT_MS -> 5 s default");
    ok(tidepoolTimeoutMs({ TIDEPOOL_TIMEOUT_MS: "abc" }) === 5_000, "non-numeric timeout -> default");
    ok(tidepoolTimeoutMs({ TIDEPOOL_TIMEOUT_MS: "0" }) === 5_000, "zero timeout -> default (1 ms floor)");
    ok(tidepoolTimeoutMs({ TIDEPOOL_TIMEOUT_MS: "-5" }) === 5_000, "negative timeout -> default");
    ok(tidepoolTimeoutMs({ TIDEPOOL_TIMEOUT_MS: "999999999" }) === 5_000, "absurd timeout -> default (60 s cap)");
    ok(tidepoolTimeoutMs(undefined) === 5_000, "no env at all -> default");
  }

  /* ── 8. cache behaviour ── */
  {
    /* a. hit within TTL: one upstream round-trip, then memory */
    let calls = stub();
    const env = baseEnv({ TIDEPOOL_CACHE_MS: "60000" });
    let r = await get("/networks", env);
    ok(r.res.status === 200 && r.out.cached === false, "first read is live");
    ok(calls.length === 2, "first read costs two upstream calls");
    r = await get("/networks", env);
    ok(r.out.cached === true && calls.length === 2, "second read within TTL is served from cache (no upstream)");
    ok(r.out.count.tokens === 4, "cached body is the full curated payload");
    ok(r.res.headers.get("cache-control") === "no-store", "cached response is still no-store for intermediaries");

    /* b. explicit reset forces a refetch */
    clearDiscoveryCache();
    r = await get("/networks", env);
    ok(r.out.cached === false && calls.length === 4, "clearDiscoveryCache() forces a fresh upstream round-trip");

    /* c. TTL expiry: move the clock past 60 s */
    try {
      Date.now = () => realNow() + 61_000;
      r = await get("/networks", env);
      ok(r.out.cached === false && calls.length === 6, "an expired entry is refetched, never served stale");
    } finally {
      Date.now = realNow;
    }

    /* d. caching off entirely */
    calls = stub();
    const off = baseEnv({ TIDEPOOL_CACHE_MS: "0" });
    await get("/networks", off);
    await get("/networks", off);
    ok(calls.length === 4, "TIDEPOOL_CACHE_MS=0 disables the cache (every read is live)");

    /* e. empty results are never cached */
    stub({ tokensBody: "[]" });
    let rEmpty = await get("/networks", baseEnv({ TIDEPOOL_CACHE_MS: "60000" }));
    ok(rEmpty.out.networks.length === 0, "empty discovery served");
    stub(); // upstream recovered
    rEmpty = await get("/networks", baseEnv({ TIDEPOOL_CACHE_MS: "60000" }));
    ok(rEmpty.out.count.tokens === 4, "an empty result was NOT cached — recovery is immediate");

    /* f. errors are never cached */
    stub({ tokensStatus: 500 });
    const rErr = await get("/networks", baseEnv({ TIDEPOOL_CACHE_MS: "60000" }));
    ok(rErr.res.status === 502, "upstream error served as 502");
    stub();
    const rOk = await get("/networks", baseEnv({ TIDEPOOL_CACHE_MS: "60000" }));
    ok(rOk.res.status === 200 && rOk.out.cached === false, "the error was not cached — next read retries upstream");

    /* unit: TTL bounds */
    ok(discoveryTtlMs({}) === 60_000, "missing TIDEPOOL_CACHE_MS -> 60 s default");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "0" }) === 0, "0 is honoured (cache off)");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "50" }) === 50, "small TTLs are honoured");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "600000" }) === 600_000, "10-minute cap is honoured");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "-1" }) === 60_000, "negative TTL -> default");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "abc" }) === 60_000, "non-numeric TTL -> default");
    ok(discoveryTtlMs({ TIDEPOOL_CACHE_MS: "999999999" }) === 60_000, "absurd TTL -> default (10 min cap)");
    ok(discoveryTtlMs(undefined) === 60_000, "no env at all -> default");
  }

  /* ── 9. CORS restrictions + origin gate ── */
  {
    stub();
    let r = await get("/networks", baseEnv(), { Origin: "https://evil.example" });
    ok(r.res.status === 403 && r.out.error === "Origin not allowed", "foreign Origin -> 403");
    r = await get("/networks", baseEnv(), { Origin: ORIGIN });
    ok(r.res.status === 200, "the hosted frontend's Origin -> 200");
    r = await get("/networks", baseEnv());
    ok(r.res.status === 200, "no Origin header (curl/README) -> 200");
    r = await get("/networks", baseEnv({ ALLOWED_ORIGIN: "*" }), { Origin: "https://anywhere.example" });
    ok(r.res.status === 200 && r.res.headers.get("access-control-allow-origin") === "*",
      "ALLOWED_ORIGIN=* disables the gate and echoes *");

    const pre = await method("OPTIONS");
    ok(pre.res.status === 204, "OPTIONS preflight -> 204");
    ok(pre.res.headers.get("access-control-allow-origin") === ORIGIN, "preflight echoes the allowed origin");
    ok((pre.res.headers.get("access-control-allow-methods") || "").includes("GET"),
      "preflight advertises GET");
    ok((pre.res.headers.get("access-control-allow-methods") || "").includes("OPTIONS"),
      "preflight advertises OPTIONS");
    ok(pre.res.headers.get("x-request-id") === null, "preflight carries no correlation id");
  }

  /* ── 10. invalid requests ── */
  {
    stub();
    let r = await method("POST");
    ok(r.res.status === 405, "POST -> 405");
    ok(r.res.headers.get("allow") === "GET", "405 carries Allow: GET");
    ok(r.res.headers.get("x-request-id") === null, "405 carries no correlation id (deploy signal untouched)");

    r = await method("DELETE");
    ok(r.res.status === 405 && r.res.headers.get("allow") === "GET", "DELETE -> 405 Allow: GET");

    r = await method("PUT", "/networks");
    ok(r.res.status === 405, "PUT -> 405");

    r = await get("/");
    ok(r.res.status === 404 && r.out.error === "not found", "GET / -> 404");
    r = await get("/networks/extra");
    ok(r.res.status === 404, "GET /networks/extra -> 404");
    r = await get("/admin");
    ok(r.res.status === 404, "GET /admin -> 404");
    ok(r.res.headers.get("x-request-id") === null, "404 carries no correlation id");

    r = await get("/networks?verbose=1");
    ok(r.res.status === 200, "query strings on /networks are ignored, not rejected");
  }

  /* ── 11. M-01: structured logging ── */
  {
    /* a. networks_ok envelope + correlation */
    stub();
    const ip = "198.51.100.7";
    const { value: r, evs } = await around(() => get("/networks", baseEnv(), { "CF-Connecting-IP": ip }));
    ok(r.res.status === 200, "a valid request still 200 under structured logging");
    const [ev] = evs.filter((e) => e.event === "networks_ok");
    ok(ev && ev.svc === "paylink-tidepool" && ev.build === "20261111a" && ev.level === "info"
      && typeof ev.ts === "string", "line carries the ts/svc/build/level envelope");
    ok(ev && ev.rid === r.res.headers.get("x-request-id"), "networks_ok shares the response's rid");
    ok(ev && ev.chains === 3 && ev.tokens === 4 && ev.cached === false
      && typeof ev.ms === "number" && ev.ip === ip, "records counts/cached/duration/ip — operational facts only");
    ok(!JSON.stringify(evs).includes("nep141:"), "no asset ids appear in any log line");

    /* b. origin rejection logs a reason code with the rid */
    const r403 = await around(() => get("/networks", baseEnv(), { Origin: "https://evil.example" }));
    const [rej] = r403.evs.filter((e) => e.event === "networks_rejected");
    ok(r403.value.res.status === 403, "cross-origin still 403 under logging");
    ok(rej && rej.reason === "origin_not_allowed" && rej.status === 403
      && rej.rid === r403.value.res.headers.get("x-request-id"),
      "origin gate logs networks_rejected with reason + rid");

    /* c. upstream_error: bounded detail server-side, nothing client-side */
    stub({ tokensStatus: 500 });
    const r500 = await around(() => get());
    ok(r500.value.res.status === 502, "upstream 500 still maps to 502");
    const [ue] = r500.evs.filter((e) => e.event === "upstream_error");
    ok(ue && ue.level === "error" && ue.target === "tokens" && ue.kind === "http_status" && ue.status === 500,
      "upstream failure logs upstream_error with target/kind/status");
    ok(ue && typeof ue.detail === "string" && ue.detail.includes("UPSTREAM-DETAIL-MARKER"),
      "bounded upstream detail is kept server-side for debugging");
    ok(ue && ue.detail.length <= 240, "upstream detail capped at 240 chars");
    ok(ue && ue.rid === r500.value.res.headers.get("x-request-id"), "upstream_error carries the rid");
    ok(!r500.value.text.includes("UPSTREAM-DETAIL-MARKER"), "…but the client body stays clean");

    /* d. health failures are logged too, with their leg named */
    stub({ healthStatus: 500 });
    const rH = await around(() => get());
    const [he] = rH.evs.filter((e) => e.event === "upstream_error");
    ok(rH.value.res.status === 200, "health failure still answers 200");
    ok(he && he.target === "health" && he.kind === "http_status" && he.status === 500,
      "health failure logs upstream_error with target=health");

    /* e. empty discovery is a warn, not silence */
    stub({ tokensBody: "[]" });
    const rE = await around(() => get());
    const [ee] = rE.evs.filter((e) => e.event === "networks_ok");
    ok(rE.value.res.status === 200, "empty result still 200");
    ok(ee && ee.level === "warn" && ee.tokens === 0, "empty discovery logs networks_ok at level=warn");

    /* f. service_error: unexpected exception -> generic 500 */
    const rEx = await around(() => worker.fetch(
      { method: "GET", url: "http://[bad", headers: { get: () => null } },
      baseEnv(),
    ));
    const txt = await rEx.value.text();
    bodies.push(txt);
    ok(rEx.value.status === 500, "an unexpected exception answers a generic 500");
    ok(JSON.parse(txt).error === "internal error", "…with a generic message, no internals");
    const [se] = rEx.evs.filter((e) => e.event === "service_error");
    ok(se && se.level === "error" && typeof se.error === "string", "exception logged as service_error");
    ok(!txt.includes("index.js") && !txt.includes("at Object"), "the response carries no stack trace");
  }

  /* ── 12. M-01: alert webhook delivery (logEvent's optional env) ── */
  {
    const HOOK = "https://hooks.alert.example.test/services/TOPSECRET-DESTINATION";

    /* Raw console capture: keeps unparseable lines too, so a URL leak of
       ANY shape would be visible here. */
    const capture = async (fn) => {
      const lines = [];
      const base = console.log;
      console.log = (...a) => lines.push(a.join(" "));
      try {
        const value = await fn();
        return { value, lines };
      } finally {
        console.log = base;
      }
    };
    const parsed = (lines) =>
      lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    /* a. missing secret: delivery off, log-only, not one fetch */
    const attempts = [];
    globalThis.fetch = (url, init = {}) => {
      attempts.push({ url: String(url), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const a = await capture(() => logEvent("record_invalid", {
      level: "alert", rid: "a1b2c3d4", linkId: "inv-0001",
      intentId: "pi_0123456789abcdef", reason: "status_invalid",
    }, baseEnv()));
    ok(a.value === false, "no ALERT_WEBHOOK_URL: delivery reports false (alerts degrade to log-only)");
    ok(attempts.length === 0, "no ALERT_WEBHOOK_URL: NOT ONE fetch is attempted");
    ok(parsed(a.lines).some((e) => e.event === "record_invalid" && e.level === "alert"),
      "the console JSON line is still emitted (Tier 0 log-only intact)");
    const a2 = await capture(() =>
      logEvent("record_invalid", { level: "alert", rid: "a1b2c3d4", reason: "status_invalid" }));
    ok(a2.value === false && attempts.length === 0,
      "the old two-argument call shape (no env) stays safe: no fetch, no throw");

    /* b. successful delivery: one JSON POST, payload = the logged line */
    const posts = [];
    globalThis.fetch = (url, init = {}) => {
      posts.push({ url: String(url), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const hookEnv = baseEnv({ ALERT_WEBHOOK_URL: HOOK });
    const b = await capture(() => logEvent("invoice_conflict", {
      level: "alert", rid: "a1b2c3d4", linkId: "inv-0001",
      intentId: "pi_0123456789abcdef", previous: "OPEN", onChainStatus: "PAID",
    }, hookEnv));
    ok(b.value === true, "delivery resolves true");
    ok(posts.length === 1, "exactly ONE POST per alert event");
    ok(posts[0].url === HOOK && posts[0].init.method === "POST",
      "the POST goes to ALERT_WEBHOOK_URL");
    ok((posts[0].init.headers || {})["content-type"] === "application/json",
      "sent as application/json");
    const sent = JSON.parse(posts[0].init.body);
    const logged = parsed(b.lines).filter((e) => e.event === "invoice_conflict")[0];
    ok(sent.event === "invoice_conflict" && sent.level === "alert" && sent.svc === "paylink-tidepool",
      "payload is the structured alert record");
    ok(logged && JSON.stringify(sent) === JSON.stringify(logged),
      "payload is EXACTLY the logged line — no extra fields, nothing hidden");
    ok(!b.lines.join("\n").includes(HOOK), "the webhook URL is never logged on success");
    const w = await capture(() => logEvent("networks_ok", { level: "warn", rid: "a1b2c3d4", tokens: 0 }, hookEnv));
    ok(w.value === null && posts.length === 1,
      "warn/info events are never POSTed — only level=alert is webhook-eligible");

    /* c. failed delivery: swallowed, console line intact, URL never logged */
    const tries = [];
    globalThis.fetch = (url) => {
      tries.push(String(url));
      return Promise.reject(new TypeError("connect ECONNREFUSED 10.0.0.1:443"));
    };
    const c = await capture(() => logEvent("payout_conflict", {
      level: "alert", rid: "a1b2c3d4", linkId: "inv-0001",
      intentId: "pi_0123456789abcdef", kind: "double_payout",
    }, hookEnv));
    ok(c.value === false, "failed delivery resolves false — the failure is swallowed, never thrown");
    ok(tries.length === 1, "the delivery was attempted exactly once (no retry loop)");
    ok(parsed(c.lines).some((e) => e.event === "payout_conflict" && e.level === "alert"),
      "the console JSON line is still emitted when delivery fails");
    ok(!c.lines.join("\n").includes(HOOK), "the webhook URL is never logged on failure");
    ok(!c.lines.join("\n").includes("ALERT_WEBHOOK_URL"),
      "the secret's NAME never appears in any line either");
  }

  /* ── 13. leak sweep across every captured response ── */
  {
    const all = bodies.join("\n");
    ok(!all.includes("UPSTREAM-DETAIL-MARKER"), "sweep: no upstream detail appears in any response");
    ok(!all.includes('"price"') && !all.includes("coingeckoId"), "sweep: no upstream token fields leak");
    ok(!all.includes("verifierWasmSha256") && !all.includes("codeHashHex"), "sweep: no health internals leak");
    ok(
      !all.includes("at Object.") && !all.includes("node:internal") && !all.includes("index.js:"),
      "sweep: no stack-trace fragment appears in any response",
    );
    ok(bodies.length >= 40, `sweep ran over a meaningful sample (${bodies.length} responses)`);
  }
} catch (e) {
  fail++;
  console.log("FAIL  unexpected error:", e && e.message);
  console.log(e && e.stack);
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  clearDiscoveryCache();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
