/* The deterministic network layer for the E2E smoke suite.
 *
 * ONE catch-all page.route dispatches by host:
 *   - 127.0.0.1 / localhost  → continue (the committed frontend under test);
 *   - chain RPC, FX, wallet registry, all four Worker hosts, faucet origin
 *     → canned fixtures, fulfilled in-process — the suite needs no network
 *     egress and can never touch a live endpoint;
 *   - anything else          → recorded in scenario.unexpected and aborted,
 *     so a spec can assert the page reached beyond its allowlist.
 *
 * No secrets exist in this layer: every body is a fixture written here, and
 * the suite never carries a key, a token or a webhook URL to assert on.
 */

import {
  makeLinks,
  TP_ENDPOINT,
  TP_NETWORKS,
  tpStatusBody,
  WALLET_MANIFEST,
  FX_BODY,
} from "./links.mjs";

const RPC_HOST = "test.rpc.fastnear.com";
const FX_HOST = "open.er-api.com";
const TP_HOST = new URL(TP_ENDPOINT).hostname;
const PARSE_HOST = "paylink-parse.g32772584.workers.dev";
const RELAYER_HOST = "paylink-relayer.g32772584.workers.dev";
const FAUCET_HOST = "www.usetidepool.tech";
const REGISTRY_HOSTS = ["raw.githubusercontent.com", "cdn.jsdelivr.net"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "86400",
};

/** Fresh per-test scenario. Mutate flags mid-test (e.g. rpcDown = false). */
export function makeScenario(over = {}) {
  return {
    links: makeLinks(),
    /* true → every chain RPC answers HTTP 500 (endpoint-down behaviour,
       including the one automatic retry rpc() is allowed). */
    rpcDown: false,
    /* set → get_link answers a JSON-RPC error object instead (the chain
       answered: rpc() must NOT retry — defence in depth, asserted). */
    getLinkError: null,
    /* read log of every chain request, for exact-call assertions. */
    rpcLog: [],
    tpStatusBody: tpStatusBody("VERIFIED"),
    tpNetworks: TP_NETWORKS,
    fxBody: FX_BODY,
    /* true → wallet-registry fetches are left unanswered, so a wallet
       prompt can never resolve — nothing is ever signed by a test. */
    hangWalletManifest: false,
    /* every external URL this page tried (fixtures + denials). */
    seen: [],
    unexpected: [],
    ...over,
  };
}

const json = (route, status, body) =>
  route.fulfill({
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(body),
  });

function handleRpc(route, scenario) {
  if (scenario.rpcDown) {
    /* ACAO included so the page sees the 500 itself (a CORS-less reply would
       surface as a generic TypeError — a different, less honest failure). */
    return route.fulfill({
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS },
      body: JSON.stringify({ error: "e2e mock: chain RPC is down" }),
    });
  }

  let msg = {};
  try {
    msg = JSON.parse(route.request().postData() || "{}");
  } catch {
    /* fall through with defaults below */
  }
  const id = msg.id ?? 1;
  const ok = (result) => json(route, 200, { jsonrpc: "2.0", id, result });

  if (msg.method === "status") {
    scenario.rpcLog.push({ method: "status" });
    return ok({ sync_info: { latest_block_height: 1, latest_block_time: "2026-11-13T00:00:00Z" } });
  }

  if (msg.method === "query" && msg.params && msg.params.request_type === "call_function") {
    const p = msg.params;
    scenario.rpcLog.push({ method: "query", name: p.method_name });

    if (p.method_name === "get_link" && scenario.getLinkError) {
      /* body.error → rpcOnce throws and rpc() treats it as "the chain
         answered": exactly one request, never a retry storm. */
      return json(route, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: scenario.getLinkError },
      });
    }

    let args = {};
    try {
      args = JSON.parse(Buffer.from(p.args_base64 || "", "base64").toString("utf8") || "{}");
    } catch {
      /* unparseable args → the mock answers null, like an empty view */
    }

    const view = (value) =>
      ok({
        signer_id: p.account_id,
        block_hash: "E2EMOCKBLOCKHASH",
        block_height: 1,
        result: [...Buffer.from(JSON.stringify(value === undefined ? null : value), "utf8")],
      });

    switch (p.method_name) {
      case "get_link":
        return view(scenario.links[typeof args.link_id === "string" ? args.link_id : ""] ?? null);
      case "get_links_by_creator":
        return view([]);
      case "is_token_allowed":
        return view(true);
      case "fee_bps":
        return view(50);
      case "ft_metadata":
        return view({ name: "USD Coin", symbol: "USDC", decimals: 6, icon: null });
      case "ft_balance_of":
        return view("0");
      default:
        return view(null);
    }
  }

  /* Anything else (view_account, block, tx …) is not exercised by the smoke
     suite; answering null keeps the page deterministic if it ever tries. */
  scenario.rpcLog.push({ method: msg.method || "unknown" });
  return ok(null);
}

function handleTidepool(route, scenario) {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/networks")) return json(route, 200, scenario.tpNetworks);
  if (url.pathname.startsWith("/status")) return json(route, 200, scenario.tpStatusBody);
  /* /quote and every other route: fail closed. The smoke suite never creates
     a payment intent; if a code path ever tried, the answer is a deterministic
     error against the mock host — no real Worker, no real intent, ever. */
  return json(route, 400, {
    ok: false,
    error: "e2e mock: this endpoint is never exercised by the smoke suite",
  });
}

/**
 * Install the whole network layer on a page and start watching console
 * errors. Call BEFORE page.goto().
 *
 * Returns { errors, seen, scenario } — assert errors == [] and
 * scenario.unexpected == [] at the end of a spec.
 */
export async function installMocks(page, scenario = makeScenario()) {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));

  await page.route("**/*", async (route) => {
    const request = route.request();
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort();
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return route.continue();
    }
    scenario.seen.push(`${request.method()} ${request.url()}`);

    /* CORS preflight for the JSON POSTs (if the browser sends one through
       the interceptor, answer it here — never by reaching the real host). */
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS, body: "" });
    }

    if (url.hostname === RPC_HOST) return handleRpc(route, scenario);
    if (url.hostname === FX_HOST) return json(route, 200, scenario.fxBody);
    if (url.hostname === TP_HOST) return handleTidepool(route, scenario);
    if (url.hostname === PARSE_HOST || url.hostname === RELAYER_HOST || url.hostname === FAUCET_HOST) {
      return json(route, 400, {
        ok: false,
        error: "e2e mock: never exercised by the smoke suite",
      });
    }
    if (REGISTRY_HOSTS.includes(url.hostname)) {
      if (scenario.hangWalletManifest) return; // leave pending: nothing signs
      return json(route, 200, WALLET_MANIFEST);
    }

    /* Off-allowlist host: record it and fail the request on the spot. */
    scenario.unexpected.push(request.url());
    return route.abort();
  });

  return { errors, scenario };
}

/** Convenience: install mocks, then navigate. */
export async function openApp(page, scenario, path = "/?flat=1") {
  await installMocks(page, scenario);
  await page.goto(path);
}
