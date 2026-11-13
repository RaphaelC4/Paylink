/* Discovery tests — run with: node frontend/test/tidepool-discovery.test.mjs
 *
 * Phase 7 §discovery: the payer's network/token choices come ONLY from the
 * Paylink Worker's GET /networks — nothing hardcoded, every state (loading,
 * empty, error, malformed) rendered, unselectable networks visible but
 * disabled, and tokens filtered to the chosen network so an unsupported
 * combination can never be requested. Pure parsers/builders first, then the
 * rail against a scripted fetch and a fake #tpWrap element (production code,
 * injected dependencies — no browser needed).
 */

import { createTidepoolRail, tpParseNetworks, tpNetworkOptionsHtml, tpTokenOptionsHtml, tpAvailabilityHtml } from "../tidepool.js";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

const ENDPOINT = "https://paylink-tidepool.example.workers.dev";
const LINK = { link_id: "demo-004" };
const CTX = { st: "OPEN", mine: false, accountId: "bob.testnet" };
const flush = () => new Promise((r) => setTimeout(r, 0));

/* Trimmed capture of the Worker's /networks shape: three networks, four
   tokens, one of each availability class. */
const NETS = {
  networks: [
    { blockchain: "near", name: "NEAR", availability: "native",
      tokens: [{ assetId: "nep141:usdc.near", symbol: "USDC", decimals: 6, contractAddress: "usdc.near" }] },
    { blockchain: "ethereum", name: "Ethereum", availability: "bridge-ok",
      tokens: [
        { assetId: "nep141:usdc.eth", symbol: "USDC", decimals: 6, contractAddress: "0xeth" },
        { assetId: "nep141:weth.eth", symbol: "WETH", decimals: 18, contractAddress: "0xweth" },
      ] },
    { blockchain: "bsc", name: "BNB Smart Chain", availability: "bridge-down",
      tokens: [{ assetId: "nep141:usdc.bsc", symbol: "USDC", decimals: 6, contractAddress: "0xbsc" }] },
  ],
  count: { networks: 3, tokens: 4 },
  fetchedAt: "2026-11-12T00:00:00Z",
  cached: false,
  cacheSeconds: 60,
};

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (n) => {
    const k = Object.keys(headers).find((x) => x.toLowerCase() === String(n).toLowerCase());
    return k ? String(headers[k]) : null;
  } },
  json: async () => body,
});

function fakeEl() {
  return {
    innerHTML: "",
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    querySelector() { return null; },
    contains() { return false; },
  };
}
function fakeStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function defer() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function railWith(fetchImpl, extra = {}) {
  const el = fakeEl();
  const rail = createTidepoolRail({
    fetchImpl, getEl: () => el, storage: () => fakeStore(),
    schedule: () => 1, unschedule: () => {},
    ...extra,
  });
  rail.init({ endpoint: ENDPOINT });
  return { rail, el };
}

/* ── pure: response parsing ── */

{
  const nets = tpParseNetworks(NETS);
  ok(Array.isArray(nets) && nets.length === 3, "valid body parses to 3 networks");
  ok(nets[0].pickable === true && nets[1].pickable === true, "native and bridge-ok are selectable");
  ok(nets[2].pickable === false, "bridge-down is NOT selectable");
  ok(nets[1].tokens.length === 2, "all valid tokens on a network survive");
  ok(tpParseNetworks({ networks: [] })?.length === 0, "empty network list is a valid answer");
  ok(tpParseNetworks({ networks: "nope" }) === null, "non-array networks rejects the body");
  ok(tpParseNetworks(null) === null && tpParseNetworks([1]) === null, "null / bare array reject");
  ok(tpParseNetworks({ networks: [{ blockchain: 7, name: "x", availability: "native", tokens: [] }] }) === null,
    "malformed network entry rejects the whole body (fail closed)");
  /* name is nullable by contract (NEAR reports no display name). */
  const noName = tpParseNetworks({ networks: [{ blockchain: "near", name: null, availability: "native",
    tokens: [{ assetId: "nep141:usdc.tidepool-sandbox.testnet", symbol: "USDC", decimals: 6, contractAddress: null }] }] });
  ok(noName && noName[0].name === null && noName[0].tokens[0].contractAddress === null,
    "null name and null contractAddress are valid, not dropped");
  ok(tpNetworkOptionsHtml(noName, "near").includes(">near</option>"),
    "a null name falls back to the chain code in the option label");
  ok(tpAvailabilityHtml(noName, "near").includes("near: live"),
    "a null name falls back to the chain code in the caption");
  const drop = tpParseNetworks({ networks: [{ blockchain: "near", name: "N", availability: "native",
    tokens: [{ assetId: "ok", symbol: "USDC", decimals: 6, contractAddress: "c" },
             { assetId: "bad", symbol: "X", decimals: "6", contractAddress: "c" }] }] });
  ok(drop && drop[0].tokens.length === 1, "malformed token is dropped, good tokens kept");
}

/* ── pure: option builders ── */

{
  const nets = tpParseNetworks(NETS);
  const netOpts = tpNetworkOptionsHtml(nets, "ethereum");
  ok(netOpts.includes('value="ethereum" selected'), "chosen network renders selected");
  ok(!netOpts.includes('""') && !netOpts.includes('selected"'), "option markup has no stray quotes (clean attributes)");
  ok(netOpts.includes('value="bsc" disabled'), "bridge-down network renders disabled");
  ok(netOpts.includes("BNB Smart Chain — bridge down"), "disabled network shows its reason");
  ok(!netOpts.includes('value="bsc" selected'), "unselectable network is never the selection");
  const tokEth = tpTokenOptionsHtml(nets, "ethereum", "nep141:usdc.eth");
  ok(tokEth.includes("WETH · 18 decimals") && tokEth.includes('selected'), "network tokens listed, choice selected");
  ok(!tokEth.includes("nep141:usdc.near"), "tokens from other networks absent");
  ok(tpTokenOptionsHtml(nets, "bsc", "").includes("no tokens available"),
    "an unselectable network yields no token choices");
  ok(tpAvailabilityHtml(nets, "near").includes("NEAR: live"), "availability caption names the network");
  ok(tpAvailabilityHtml(nets, "bsc").includes("err"), "unavailable caption carries the error tone");
}

/* ── rail: the four panel states ── */

{
  const d = defer();
  const calls = [];
  const fetchImpl = (url) => { calls.push(String(url)); return d.promise; };
  const { rail, el } = railWith(fetchImpl);

  await rail.sync(LINK, CTX);
  ok(calls.length === 1 && calls[0].includes("/networks"), "sync kicks off discovery against the Worker");
  ok(el.innerHTML === "", "closed panel renders nothing before the toggle");
  rail.toggle();
  ok(el.innerHTML.includes("Loading available networks"), "loading state shown while discovery is in flight");
  ok(rail.toggleHtml().includes("Hide cross-chain pay"), "open panel's toggle reads Hide");

  d.resolve(res(200, NETS));
  await flush();
  ok(el.innerHTML.includes('<select id="tpNet"'), "form renders after discovery resolves");
  ok(el.innerHTML.includes('value="bsc" disabled'), "disabled network visible in the rendered form");
  ok(el.innerHTML.includes('id="tpRef"'), "refund address field present");
  ok(el.innerHTML.includes('data-tp-action="quote"'), "Get quote button present");

  rail.setForm({ blockchain: "ethereum", assetId: "nep141:weth.eth" });
  ok(el.innerHTML.includes("WETH · 18 decimals"), "switching network rebuilds the token list in place");
  ok(!el.innerHTML.includes('value="nep141:usdc.near" selected'), "no cross-network token stays selected");
}

{
  /* unreachable Worker */
  const { rail, el } = railWith(() => Promise.reject(new Error("net down")));
  await rail.sync(LINK, CTX);
  rail.toggle();
  await flush();
  ok(el.innerHTML.includes("Could not reach the payment service"), "network failure renders an error state");
  ok(el.innerHTML.includes('data-tp-action="retry-nets"'), "error state offers a retry");
}

{
  /* 500 with a backend message */
  const { rail, el } = railWith(() => Promise.resolve(res(500, { error: "boom", code: "x" })));
  await rail.sync(LINK, CTX);
  rail.toggle();
  await flush();
  ok(el.innerHTML.includes("boom"), "500 shows the backend's own words");
}

{
  /* empty discovery */
  const { rail, el } = railWith(() => Promise.resolve(res(200, { networks: [] })));
  await rail.sync(LINK, CTX);
  rail.toggle();
  await flush();
  ok(el.innerHTML.includes("No networks are available for cross-chain payment"), "empty list renders the empty state");
  ok(el.innerHTML.includes("Use the NEAR button"), "empty state points at the native flow");
}

{
  /* malformed 200 */
  const { rail, el } = railWith(() => Promise.resolve(res(200, { networks: "nope" })));
  await rail.sync(LINK, CTX);
  rail.toggle();
  await flush();
  ok(el.innerHTML.includes("unexpected response"), "malformed body renders the error state, never a partial form");
  ok(!el.innerHTML.includes("<select"), "malformed body never renders selects");
}

{
  /* disabled endpoint: the feature is simply absent */
  const el = fakeEl();
  const rail = createTidepoolRail({
    fetchImpl: () => Promise.reject(new Error("must not fetch")),
    getEl: () => el, storage: () => fakeStore(),
    schedule: () => 1, unschedule: () => {},
  });
  rail.init({ endpoint: "" });
  await rail.sync(LINK, CTX);
  ok(rail.blockReason() === null && rail.toggleHtml() === "", "empty endpoint: no gate, no toggle, no fetch");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
