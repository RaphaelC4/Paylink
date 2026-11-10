/* Keeper sweep tests — run with: node workers/keeper/test/sweep.test.mjs
 *
 * The sweep runs against a mocked RPC: contract state, access-key reads and
 * broadcasts are all served in-process, so these tests exercise discovery,
 * the exact claim transaction, retry/already-claimed/outage handling and the
 * structured log events without touching the network or a real key. The
 * signing key is generated fresh on every run — no secret lives in this file.
 */

import { generateKeyPairSync } from "node:crypto";
import worker, { sweep, decodeLink, parseSecretKey, logEvent, formatYoctoNEAR, secretMatches } from "../src/index.js";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ok  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}`); }
};

/* ── base58 / borsh helpers (mirror the Worker's formats) ── */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58encode = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s || "1";
};

const te = new TextEncoder();
const u32b = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const strB = (s) => { const b = te.encode(s); return [...u32b(b.length), ...b]; };
const u64b = (n) => { const out = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { out.push(Number(v & 255n)); v >>= 8n; } return out; };
const u128b = (n) => { const out = []; let v = BigInt(n); for (let i = 0; i < 16; i++) { out.push(Number(v & 255n)); v >>= 8n; } return out; };
const opt = (arr) => (arr === null || arr === undefined ? [0] : [1, ...arr]);

/** Borsh-encode one Link exactly as lib.rs stores it (field order = decodeLink). */
function encodeLink(l) {
  return Uint8Array.from([
    ...strB(l.link_id),
    ...strB(l.creator),
    ...u128b(l.amount),
    ...strB(l.token),
    ...strB(l.description || ""),
    ...u64b(l.created_at ?? 0),
    ...opt(l.expires_at == null ? null : u64b(l.expires_at)),
    l.status, // 0 OPEN, 1 PAID, 2 CLAIMED, 3 CANCELLED, 4 EXPIRED (never stored)
    ...opt(l.paid_by == null ? null : strB(l.paid_by)),
    ...opt(l.paid_amount == null ? null : u128b(l.paid_amount)),
    ...opt(l.paid_at == null ? null : u64b(l.paid_at)),
    ...opt(l.claimed_at == null ? null : u64b(l.claimed_at)),
  ]);
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/* Production key shape: l || borsh(String) = l || u32-LE length || bytes,
   verified against live testnet state — bAgAAABkZW1vLTAwNA== decodes to
   "l" || u32(8) || "demo-004". pfx() builds prefix_base64 the same way
   the Worker's b64fromBytes does, for knob lookups. */
const keyFor = (id) => {
  const b = te.encode(id);
  return btoa(String.fromCharCode(0x6c, ...u32b(b.length), ...b));
};
const pfx = (...bytes) => btoa(String.fromCharCode(...bytes));

/* A REAL record read from paylink-v2.testnet via view_state (M-06 layout
   fixture): key + value exactly as the node serves them. Status OPEN, so
   the sweep must scan but never claim it. */
const PROD_KEY = "bAgAAABkZW1vLTAwNA==";
const PROD_VAL = "CAAAAGRlbW8tMDA0FQAAAHBheWxpbmstcGF5ZWUudGVzdG5ldEB4fQEAAAAAAAAAAAAAAAAdAAAAdXNkYy50aWRlcG9vbC1zYW5kYm94LnRlc3RuZXQYAAAARGVzaWduIHJldGFpbmVyIC0gd2VlayAxNZaop6EBAAAAAAAAAAA=";

/* A real-shape 32-byte block hash (base58) — signTx decodes it. */
const BLOCK_HASH = "75xVe8oDH4VV9uKpcGsx7xTQFWtNsbngukNMC8qsqKTw";

/* ── runtime-generated keeper key (never a real account's) ── */

const kp = generateKeyPairSync("ed25519");
const pkcs8 = kp.privateKey.export({ type: "pkcs8", format: "der" });
const spki = kp.publicKey.export({ type: "spki", format: "der" });
const secret64 = Buffer.concat([pkcs8.subarray(16), spki.subarray(12)]); // seed || pub
const KEEPER_PUB = `ed25519:${b58encode(spki.subarray(12))}`;

const ENV = {
  RPC_URL: "https://rpc.test.invalid",
  CONTRACT_ID: "paylink-v2.testnet",
  KEEPER_ACCOUNT: "paylink-keeper.testnet",
  KEEPER_KEY: `ed25519:${b58encode(secret64)}`,
};

/* ── RPC mock ── */

let state;          // links currently in contract state
let broadcastMode;  // "ok" | "generic-fail" | "not-paid-fail" | "throw" | "throw-once" | "invalid-nonce-once"
let broadcasts;     // captured signed transactions
let keyQueries;     // captured view_access_key params
let nonceCounter = 41;
let scanFail;       // M-01: true -> view_state answers with a fatal query error
/* M-06 scan knobs — the walk is driven entirely by the mock's view_state: */
let failRoot = false;       // true -> the whole-state (prefix "l") read fails
let failPrefixTree = [];    // byte prefixes whose page AND descendants always fail
let failOnce = new Map();   // Map<prefixB64, remaining> -> fail N attempts, then heal
let injections = new Map(); // Map<prefixB64, entries> -> extra entries in that page (overlap)
const onceFlags = { throw: false, nonce: false }; // one-shot broadcast behaviors
const webhookPosts = []; // M-01: ALERT_WEBHOOK_URL deliveries captured here
let rpcUrlHits = [];     // L-08 P1: every RPC attempt, { url, method }, in order
let deadUrls = new Set(); // L-08 P1: URLs that reject at the network level

const link = (id, status, extra = {}) => ({
  link_id: id,
  creator: "alice.testnet",
  amount: 1_000_000,
  token: "usdc.tidepool-sandbox.testnet",
  description: "test",
  created_at: 1_794_000_000_000,
  expires_at: null,
  status, // 0 OPEN, 1 PAID, 2 CLAIMED, 3 CANCELLED (L-03), 4 EXPIRED
  /* payment fields exist only while the link was actually paid: a
     CANCELLED (3) record has none — cancel is pre-payment only */
  paid_by: status === 1 || status === 2 ? "bob.testnet" : null,
  paid_amount: status === 1 || status === 2 ? 1_000_000 : null,
  paid_at: status === 1 || status === 2 ? 1_794_000_100_000 : null,
  claimed_at: status === 2 ? 1_794_000_200_000 : null,
  ...extra,
});

globalThis.fetch = async (_url, opts) => {
  /* M-01: alert-webhook deliveries are captured here, not sent anywhere */
  if (String(_url).startsWith("https://hooks.test/")) {
    webhookPosts.push(JSON.parse(opts.body));
    return { json: async () => ({}) };
  }
  const body = JSON.parse(opts.body);
  /* L-08 P1: record every RPC attempt per endpoint, and let a test mark an
     endpoint dead (network-level rejection — DNS/connection failure). */
  rpcUrlHits.push({ url: String(_url), method: body.method });
  if (deadUrls.has(String(_url))) throw new TypeError("Failed to fetch");
  const json = (obj) => ({ json: async () => obj });

  if (body.method === "query" && body.params.request_type === "view_state") {
    if (scanFail) {
      /* deliberately carries a key-shaped string so the scrub backstop is
         exercised on the scan-failure path too */
      return json({
        result: { error: `node unreachable — last seen holding ed25519:${"A".repeat(64)}` },
      });
    }
    /* M-06: prefix-filtered pages over production-shape keys
       (l || u32-LE length || link_id, exactly as the contract stores
       them), with per-prefix failure and overlap knobs for the walk. */
    const p64 = body.params.prefix_base64 || "";
    const pBytes = Uint8Array.from(atob(p64), (c) => c.charCodeAt(0));
    const isRoot = pBytes.length === 1 && pBytes[0] === 0x6c;
    if (isRoot && failRoot) {
      return json({ result: { error: "node refused the whole-state response (too large)" } });
    }
    if (failPrefixTree.some((fp) => fp.length <= pBytes.length && fp.every((b, i) => pBytes[i] === b))) {
      return json({ result: { error: "page unavailable" } });
    }
    if (failOnce.has(p64) && failOnce.get(p64) > 0) {
      failOnce.set(p64, failOnce.get(p64) - 1);
      return json({ result: { error: "transient page failure" } });
    }
    const values = state
      .map((l) => ({ key: keyFor(l.link_id), value: b64(encodeLink(l)) }))
      .filter((e) => {
        const k = Uint8Array.from(atob(e.key), (c) => c.charCodeAt(0));
        return pBytes.length <= k.length && pBytes.every((b, i) => k[i] === b);
      })
      .concat(injections.get(p64) || []);
    return json({ result: { values, block_hash: BLOCK_HASH } });
  }
  if (body.method === "query" && body.params.request_type === "view_access_key") {
    keyQueries.push(body.params);
    return json({ result: { nonce: nonceCounter++, block_hash: BLOCK_HASH } });
  }
  if (body.method === "broadcast_tx_commit") {
    if (broadcastMode === "throw") throw new Error("network unreachable");
    if (broadcastMode === "throw-once" && !onceFlags.throw) {
      onceFlags.throw = true;
      throw new Error("network unreachable");
    }
    broadcasts.push(body.params[0]);
    if (broadcastMode === "ok") {
      return json({ result: { status: "SuccessValue", transaction: { hash: `Hash${broadcasts.length}` } } });
    }
    if (broadcastMode === "invalid-nonce-once" && !onceFlags.nonce) {
      /* executed-but-rejected: the tx was NOT included, so its nonce was
         not consumed — the keeper must re-read the chain, not continue. */
      onceFlags.nonce = true;
      return json({
        result: {
          status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Invalid transaction: InvalidNonce Expected 41 but got 42" } } } } },
          transaction: { hash: `Hash${broadcasts.length}` },
        },
      });
    }
    /* every mode reaches success here unless it was designed to fail:
       "ok" plainly, "throw-once"/"invalid-nonce-once" after their one
       scripted misbehaviour (so claim #2 lands) */
    if (broadcastMode === "ok" || broadcastMode === "throw-once" || broadcastMode === "invalid-nonce-once") {
      return json({ result: { status: "SuccessValue", transaction: { hash: `Hash${broadcasts.length}` } } });
    }
    if (broadcastMode === "not-paid-fail") {
      return json({
        result: {
          status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: link is not paid" } } } } },
          transaction: { hash: `Hash${broadcasts.length}` },
        },
      });
    }
    return json({
      result: {
        status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Something went wrong" } } } } },
        transaction: { hash: `Hash${broadcasts.length}` },
      },
    });
  }
  throw new Error(`unexpected rpc method ${body.method}`);
};

/* ── log capture ── */

let logs;
const realLog = console.log;
const captureLogs = (fn) => {
  logs = [];
  console.log = (line) => logs.push(String(line));
  return Promise.resolve().then(fn).finally(() => { console.log = realLog; });
};
const events = () => logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const hasEvent = (name, linkId) => events().some((e) => e.event === name && (!linkId || e.link_id === linkId));

/* ── decode a captured broadcast back to its fields ── */

function parseTx(b64tx) {
  const b = Buffer.from(b64tx, "base64");
  let o = 0;
  const readStr = () => { const len = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + len).toString("utf8"); o += len; return s; };
  const signer = readStr();
  o += 33;                                    // 0x00 key tag + 32-byte pubkey
  const nonce = Number(b.readBigUInt64LE(o)); o += 8;
  const receiver = readStr();
  o += 32;                                    // block hash
  const nActions = b.readUInt32LE(o); o += 4;
  const actionTag = b[o]; o += 1;
  const method = readStr();
  const argsLen = b.readUInt32LE(o); o += 4;
  const args = b.subarray(o, o + argsLen).toString("utf8"); o += argsLen;
  const gas = Number(b.readBigUInt64LE(o)); o += 8;
  /* deposit is a borsh u128: LOW limb then HIGH limb (L-02 — reading one
     limb would truncate anything >= 2^64; the keeper only ever attaches
     1 yocto, but the reader must be correct regardless) */
  const depositLo = b.readBigUInt64LE(o);
  const depositHi = b.readBigUInt64LE(o + 8);
  o += 16;
  const deposit = depositLo + (depositHi << 64n);
  return { signer, nonce, receiver, nActions, actionTag, method, args, gas, deposit };
}

const reset = (links, mode) => {
  state = links;
  broadcastMode = mode;
  broadcasts = [];
  keyQueries = [];
  nonceCounter = 41;
  scanFail = false;
  failRoot = false;
  failPrefixTree = [];
  failOnce = new Map();
  injections = new Map();
  onceFlags.throw = false;
  onceFlags.nonce = false;
  webhookPosts.length = 0;
  rpcUrlHits = [];
  deadUrls = new Set();
};

/* ══════════════════════════ tests ══════════════════════════ */

/* 1. encoder sanity: round-trip through the Worker's own decoder */
{
  const decoded = decodeLink(encodeLink(link("rt1", 1)));
  ok(decoded.status === "PAID" && decoded.link_id === "rt1" && decoded.paid_amount === "1000000"
    && decoded.creator === "alice.testnet" && decoded.claimed_at === null,
    "test encoder round-trips through decodeLink");
}

/* 2. discovery: only PAID links are claimed, with the exact claim tx */
{
  reset([link("open1", 0), link("paid1", 1), link("claimed1", 2)], "ok");
  const report = await captureLogs(() => sweep(ENV));

  ok(report.scanned === 3, "scanned every link in state");
  ok(JSON.stringify(report.paid) === '["paid1"]', "discovered exactly the PAID link");
  ok(JSON.stringify(report.claimed) === '[{"link_id":"paid1","hash":"Hash1"}]', "claim reported successful with tx hash");
  ok(report.failed.length === 0 && report.alreadyClaimed.length === 0, "no failures or already-claimed entries");
  ok(broadcasts.length === 1, "exactly one broadcast — OPEN and CLAIMED links are never attempted (no duplicate claims)");

  const tx = parseTx(broadcasts[0]);
  ok(tx.signer === ENV.KEEPER_ACCOUNT, "tx signed by the keeper account");
  ok(tx.receiver === ENV.CONTRACT_ID, "tx receiver is the contract");
  ok(tx.method === "claim" && tx.actionTag === 2, "single function-call action is claim");
  ok(tx.nActions === 1, "exactly one action in the transaction");
  ok(tx.deposit === 1n, "attaches exactly 1 yoctoNEAR");
  ok(tx.gas === 150_000_000_000_000, "attaches 150 Tgas");
  ok(tx.args === '{"link_id":"paid1"}', "args name the discovered link");
  ok(keyQueries.length === 1 && keyQueries[0].account_id === ENV.KEEPER_ACCOUNT
    && keyQueries[0].public_key === KEEPER_PUB.replace("ed25519:", ""),
    "nonce read for the keeper's key (prefix stripped, as the RPC wants)");

  ok(hasEvent("invoice_discovered", "paid1"), "log: invoice_discovered");
  ok(hasEvent("claim_submitted", "paid1"), "log: claim_submitted");
  ok(hasEvent("claim_successful", "paid1"), "log: claim_successful");
}

/* 3. no PAID links: quiet sweep, zero broadcasts */
{
  reset([link("open2", 0), link("claimed2", 2)], "ok");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.paid.length === 0 && report.claimed.length === 0, "nothing to do when no link is PAID");
  ok(broadcasts.length === 0, "no transaction built when nothing is PAID");
  ok(!hasEvent("invoice_discovered"), "no discovery logged when nothing is PAID");
}

/* 4. failed broadcast: reported, logged, and retried by the next sweep */
{
  reset([link("paid2", 1)], "generic-fail");
  const r1 = await captureLogs(() => sweep(ENV));
  ok(r1.failed.length === 1 && r1.claimed.length === 0, "failed claim lands in report.failed");
  ok(hasEvent("claim_failed", "paid2"), "log: claim_failed");
  ok(hasEvent("retry_scheduled", "paid2"), "log: retry_scheduled after a failure");
  ok(broadcasts.length === 1, "first attempt broadcast once");

  /* second sweep, link still PAID — it must try again */
  broadcastMode = "ok";
  const r2 = await captureLogs(() => sweep(ENV));
  ok(r2.claimed.length === 1 && broadcasts.length === 2, "next sweep retries and succeeds (failed txs are retried, not fatal)");
}

/* 5. released elsewhere between scan and broadcast: already-claimed, not failed */
{
  reset([link("paid3", 1)], "not-paid-fail");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.alreadyClaimed.length === 1 && report.failed.length === 0, "link is-not-paid revert classified as already claimed");
  ok(hasEvent("invoice_already_claimed", "paid3"), "log: invoice_already_claimed");
  ok(!hasEvent("claim_failed", "paid3"), "already-claimed is not reported as a failure");
}

/* 6. keeper outage: missing key never throws and never broadcasts */
{
  reset([link("paid4", 1)], "ok");
  const noKey = { ...ENV, KEEPER_KEY: undefined };
  const report = await captureLogs(() => sweep(noKey));
  ok(report.failed.length === 1 && /KEEPER_KEY/.test(report.failed[0].error), "missing key reported as a failure");
  ok(broadcasts.length === 0, "no transaction attempted without a key");
  ok(hasEvent("claim_failed") && hasEvent("retry_scheduled"), "logs carry claim_failed + retry_scheduled (it keeps trying each minute)");
}

/* 7. network outage mid-broadcast: sweep survives and schedules a retry */
{
  reset([link("paid5", 1)], "throw");
  let threw = false;
  const report = await captureLogs(() => sweep(ENV).catch(() => { threw = true; }));
  ok(!threw, "sweep does not throw on a network error");
  ok(report.failed.length === 1 && /network unreachable/.test(report.failed[0].error), "network error captured in report.failed");
  ok(hasEvent("claim_failed", "paid5") && hasEvent("retry_scheduled", "paid5"), "logs carry claim_failed + retry_scheduled");
}

/* 8. beyond the per-sweep cap: deferred links get a retry_scheduled log */
{
  const many = Array.from({ length: 12 }, (_, i) => link(`bulk${i}`, 1));
  reset(many, "ok");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.paid.length === 10, "one sweep caps claims at 10");
  ok(broadcasts.length === 10, "cap bounds the broadcasts too");
  ok(keyQueries.length === 1, "one access-key read serves all 10 claims (M-06 nonce cursor)");
  const deferred = events().filter((e) => e.event === "retry_scheduled" && /^bulk1[01]$/.test(e.link_id));
  ok(deferred.length === 2, "the 2 over-cap links are logged retry_scheduled for the next run");
}

/* 9. parseSecretKey still refuses a public key pasted as the secret */
{
  let threw = false;
  try { parseSecretKey({ KEEPER_KEY: KEEPER_PUB }); } catch { threw = true; }
  ok(threw, "parseSecretKey rejects a public key (paste-safety guard intact)");
}

/* ══════════════════════ M-01: structured logging & alerts ═══════════
   Every event is one JSON record; assertions parse the captured lines via
   events()/byEvent(). The mock above can fail the scan itself and receives
   ALERT_WEBHOOK_URL deliveries, so alert TRIGGERS and delivery are
   exercised end-to-end with no network. Sweep-level state (sweepFails,
   claimFails) lives in the module, so each test leaves it clean: a
   successful scan zeroes the outage streak, a successful claim clears the
   per-link one. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byEvent = (name) => events().filter((e) => e.event === name);

/* 10. GET /: health shape — fixed allowlist + build stamp */
{
  const res = await worker.fetch(new Request("https://keeper.test/"), ENV);
  const body = await res.json();
  const keys = Object.keys(body).sort();
  ok(res.status === 200 && JSON.stringify(keys) === JSON.stringify(["account", "build", "contract", "ok", "service"]),
    "GET / body is a fixed key allowlist (no run or user data)");
  ok(body.build === "20261110f", "GET / reports the build stamp (bump with BUILD)");
  ok(!JSON.stringify(body).includes("ed25519"), "health output carries no key material");
}

/* 11. /tick: one structured run — response and lines share a run_id */
{
  reset([link("tick1", 1)], "ok");
  const tickEnv = { ...ENV, TICK_SECRET: "test-tick-secret" };
  const res = await captureLogs(() => worker.fetch(
    new Request("https://keeper.test/tick", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tick-secret": "test-tick-secret" },
      body: "{}",
    }),
    tickEnv,
  ));
  const report = await res.json();
  ok(res.status === 200 && report.run_id && report.claimed.length === 1,
    "tick releases a PAID link and returns its report");
  const summary = byEvent("sweep_summary")[0];
  ok(summary && summary.run_id === report.run_id,
    "sweep_summary shares the response's run_id (one trace, one id)");
  ok(summary && summary.scanned === 1 && summary.claimed === 1 && summary.over_cap === 0
    && typeof summary.ms === "number",
    "sweep_summary carries the run's aggregate outcome and duration");
  ok(summary && summary.svc === "paylink-keeper" && summary.build === "20261110f"
    && summary.level === "info" && typeof summary.ts === "string",
    "line carries the ts/svc/build/level envelope");
  ok(!hasEvent("unsettled_paid"), "a fully settled run does not warn unsettled_paid");
}

/* 12. /tick against a dead RPC: 500 + structured failure lines */
{
  reset([link("tick2", 1)], "ok");
  scanFail = true;
  const tickEnv = { ...ENV, TICK_SECRET: "test-tick-secret" };
  const res = await captureLogs(() => worker.fetch(
    new Request("https://keeper.test/tick", { method: "POST", headers: { "x-tick-secret": "test-tick-secret" } }),
    tickEnv,
  ));
  ok(res.status === 500, "a dead RPC still answers tick with 500");
  ok(hasEvent("sweep_failed") && hasEvent("tick_failed"),
    "the failure is logged as sweep_failed + tick_failed");
  const tf = byEvent("tick_failed")[0];
  ok(tf && tf.level === "error" && typeof tf.run_id === "string",
    "tick_failed carries level=error and a run_id");
}

/* 13. scheduled: exactly one cron_heartbeat per run, success and failure */
{
  reset([link("cron1", 1)], "ok");
  let pending = [];
  const ctx = { waitUntil: (p) => { if (p) pending.push(p); } };
  await captureLogs(async () => {
    worker.scheduled({}, ENV, ctx);
    await Promise.all(pending);
  });
  let hb = byEvent("cron_heartbeat");
  ok(hb.length === 1 && hb[0].ok === true && typeof hb[0].ms === "number",
    "a healthy cron run logs exactly one cron_heartbeat (ok:true)");
  ok(hb[0].run_id && byEvent("sweep_summary")[0].run_id === hb[0].run_id,
    "heartbeat and sweep_summary share the run's run_id");
  ok(broadcasts.length === 1, "the scheduled sweep actually claimed the PAID link");

  reset([link("cron2", 1)], "ok");
  scanFail = true;
  pending = [];
  await captureLogs(async () => {
    worker.scheduled({}, ENV, ctx);
    await Promise.all(pending);
  });
  hb = byEvent("cron_heartbeat");
  ok(hb.length === 1 && hb[0].ok === false && hb[0].level === "error"
    && typeof hb[0].error === "string",
    "a failed run logs one cron_heartbeat ok:false (missed runs = its absence)");
}

/* 14. unsettled_paid: links still PAID after a run warn, with the count */
{
  reset([link("unset1", 1)], "generic-fail");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.failed.length === 1, "the claim failed as instructed");
  const u = byEvent("unsettled_paid");
  ok(u.length === 1 && u[0].level === "warn" && u[0].count === 1 && u[0].link_ids[0] === "unset1",
    "a link still PAID after the run warns unsettled_paid with count and id");
}

/* 15. repeated_claim_failure: alert on the THIRD consecutive failure only */
{
  const id = "m01strike";
  reset([link(id, 1)], "generic-fail");
  await captureLogs(() => sweep(ENV));
  ok(!hasEvent("repeated_claim_failure"), "first failed claim: no alert yet");
  reset([link(id, 1)], "generic-fail");
  await captureLogs(() => sweep(ENV));
  ok(!hasEvent("repeated_claim_failure"), "second failed claim: still under the threshold");

  reset([link(id, 1)], "generic-fail");
  await captureLogs(() => sweep({ ...ENV, ALERT_WEBHOOK_URL: "https://hooks.test/keeper" }));
  const r = byEvent("repeated_claim_failure");
  ok(r.length === 1 && r[0].level === "alert" && r[0].consecutive === 3 && r[0].link_id === id,
    "third consecutive failure fires repeated_claim_failure exactly once");
  await sleep(30);
  ok(webhookPosts.length === 1 && webhookPosts[0].event === "repeated_claim_failure"
    && webhookPosts[0].svc === "paylink-keeper" && webhookPosts[0].level === "alert",
    "the alert is POSTed to ALERT_WEBHOOK_URL as the full record");

  reset([link(id, 1)], "ok");
  await captureLogs(() => sweep(ENV));
  reset([link(id, 1)], "generic-fail");
  await captureLogs(() => sweep(ENV));
  ok(!hasEvent("repeated_claim_failure"),
    "after a success the streak restarts — one failure is never an alert");
}

/* 16. sweep_failed + sweep_outage: three consecutive dead scans alert once */
{
  reset([link("scan1", 1)], "ok");
  scanFail = true;

  const sfAll = []; // captureLogs resets `logs` per call — accumulate across runs
  let threw = false;
  await captureLogs(() => sweep(ENV).catch(() => { threw = true; }));
  ok(threw, "a dead scan still rejects the sweep (tick 500 / heartbeat ok:false)");
  sfAll.push(...byEvent("sweep_failed"));
  ok(sfAll.length === 1 && !hasEvent("sweep_outage"),
    "first failed scan: sweep_failed only");

  await captureLogs(() => sweep(ENV).catch(() => {}));
  sfAll.push(...byEvent("sweep_failed"));
  ok(sfAll.length === 2 && !hasEvent("sweep_outage"),
    "second failed scan: still under the threshold");

  await captureLogs(() => sweep(ENV).catch(() => {}));
  sfAll.push(...byEvent("sweep_failed"));
  const o = byEvent("sweep_outage");
  ok(o.length === 1 && o[0].level === "alert" && o[0].consecutive === 3,
    "third consecutive failed scan fires sweep_outage exactly once");

  ok(sfAll.length === 3 && sfAll.every((e) => e.level === "error"),
    "every failed scan logs sweep_failed at level=error");
  ok(sfAll.every((e) => e.error.includes("ed25519:[redacted]") && !e.error.includes("A".repeat(40))),
    "the scan error's key-shaped text is scrubbed out of the log");

  reset([link("scan1", 1)], "ok");
  await captureLogs(() => sweep(ENV));
  scanFail = true;
  await captureLogs(() => sweep(ENV).catch(() => {}));
  ok(!hasEvent("sweep_outage"),
    "after one healthy scan the streak restarts — no stale alert");
}

/* 17. scrub backstop at the logEvent level (direct probe) */
{
  const ed = "ed25519:" + "B".repeat(64);
  await captureLogs(() => logEvent("keeper_probe", { detail: `${ed} ${"x".repeat(400)}` }));
  const [p] = byEvent("keeper_probe");
  ok(p && p.detail.includes("ed25519:[redacted]") && !p.detail.includes("B".repeat(40)),
    "logEvent scrubs ed25519 key shapes");
  ok(p && p.detail.length <= 240, "strings capped at 240 chars — no payload can hide in a log line");
}

/* ════════════════════ M-06: paginated, fail-soft discovery ═══════════
   The walk only runs when the whole-state read fails (failRoot), so every
   test below exercises the fallback: root → 61 length buckets (4..64) →
   next-byte children. Pages are disjoint by construction; the mock can
   still inject an overlap, fail a region, burn one attempt or starve the
   budget, which is what the assertions drive. Sweep-level streaks
   (partialFails) are module state: each block that breaks coverage ends
   with a healthy sweep so the next block starts clean. */

/* 18. live production fixture: the key layout the root split mirrors */
{
  const kb = Uint8Array.from(atob(PROD_KEY), (c) => c.charCodeAt(0));
  ok(kb[0] === 0x6c && kb[1] === 8 && kb[2] === 0 && kb[3] === 0 && kb[4] === 0
    && new TextDecoder().decode(kb.subarray(5)) === "demo-004",
    "live testnet key = l || u32-LE(8) || \"demo-004\" (documented layout)");
  ok(kb[1] >= 4 && kb[1] <= 64, "the root split's 4..64 length buckets cover the live key");
  ok(keyFor("demo-004") === PROD_KEY, "the mock's key builder reproduces the live key byte-for-byte");
  const d = decodeLink(Uint8Array.from(Buffer.from(PROD_VAL, "base64")));
  ok(d.link_id === "demo-004" && d.creator === "paylink-payee.testnet"
    && d.token === "usdc.tidepool-sandbox.testnet" && d.amount === "25000000",
    "the live value borsh-decodes to its real fields");
  ok(d.status === "OPEN", "the live record is OPEN — scan it, never claim it");
}

/* 19. fallback walk discovers and claims, with the live record in-page */
{
  reset([link("aaaa", 1)], "ok");
  failRoot = true;
  injections.set(pfx(0x6c, 8), [{ key: PROD_KEY, value: PROD_VAL }]);
  const report = await captureLogs(() => sweep(ENV));
  ok(report.pages === 61 && report.failedPages === 0,
    "root refused → all 61 length buckets queried, none failed");
  ok(report.partial === false, "complete coverage is not reported partial");
  ok(report.scanned === 2, "both the state link and the live record decoded");
  ok(JSON.stringify(report.paid) === '["aaaa"]',
    "exactly the PAID link discovered; the live OPEN record is never a candidate");
  ok(broadcasts.length === 1 && report.claimed[0]?.link_id === "aaaa",
    "one claim, for the PAID link only");
}

/* 20. bucket boundaries: ids of length 4, 7, 64 and a CLAIMED neighbour */
{
  reset([link("aaaa", 1), link("bbbbbbb", 0), link("c".repeat(64), 1), link("done", 2)], "ok");
  failRoot = true;
  const report = await captureLogs(() => sweep(ENV));
  ok(report.scanned === 4 && report.partial === false, "every bucket read: 4 scanned, no gap");
  ok(report.paid.length === 2 && report.paid[0] === "aaaa" && report.paid[1] === "c".repeat(64),
    "PAID links found across buckets 4 and 64, OPEN/CLAIMED skipped");
  ok(broadcasts.length === 2, "exactly the two PAID links claimed");
}

/* 21. a transient page failure is retried by rpc — no partial, no loss */
{
  reset([link("r4aa", 1)], "ok");
  failRoot = true;
  failOnce.set(pfx(0x6c, 4), 1); // bucket 4 fails its first attempt, heals on retry
  const report = await captureLogs(() => sweep(ENV));
  ok(report.partial === false && report.failedPages === 0 && report.pages === 61,
    "one transient page error leaves no partial: the in-call retry covered it");
  ok(JSON.stringify(report.claimed) === '[{"link_id":"r4aa","hash":"Hash1"}]',
    "the link under the flaky page is still settled in the same run");
}

/* 22. a region that stays unreadable: fail-soft claims, scan_partial warn,
       scan_degraded alert on the 3rd consecutive, recovery re-covers all */
{
  /* ids chosen by bucket: reach6 = 6 chars (healthy bucket 6),
     stuck888 = 8 chars (bucket 8, the one that stays unreadable) */
  reset([link("reach6", 1), link("stuck888", 1)], "ok");
  failRoot = true;
  failPrefixTree = [[0x6c, 8]]; // bucket 8 AND every descendant never answers

  let r = await captureLogs(() => sweep(ENV));
  ok(r.partial === true && r.failedPages > 0, "unreadable region → report.partial with failed pages");
  ok(r.claimed.length === 1 && r.claimed[0].link_id === "reach6",
    "fail-soft: the readable bucket's PAID link is still settled");
  ok(!r.paid.includes("stuck888"), "the unreadable link is undiscovered this run (not invented)");
  ok(hasEvent("scan_partial") && !hasEvent("scan_degraded"),
    "first partial run warns scan_partial, does not alert");

  await captureLogs(() => sweep(ENV));
  ok(!hasEvent("scan_degraded"), "second partial run: still under the threshold");

  r = await captureLogs(() => sweep(ENV));
  const g = byEvent("scan_degraded");
  ok(g.length === 1 && g[0].level === "alert" && g[0].consecutive === 3,
    "third consecutive partial scan fires scan_degraded exactly once");
  ok(r.claimed.length === 1, "every partial run keeps settling what it can read");

  failRoot = false;
  failPrefixTree = [];
  r = await captureLogs(() => sweep(ENV));
  ok(r.partial === false, "one healthy scan clears the partial flag");
  ok(r.claimed.some((e) => e.link_id === "stuck888"),
    "the link missed by three partial runs is claimed by the next full scan — no lost settlement");

  failRoot = true;
  failPrefixTree = [[0x6c, 8]];
  await captureLogs(() => sweep(ENV));
  ok(!hasEvent("scan_degraded"), "after the healthy run the partial streak restarted — no stale alert");
  failRoot = false;
  failPrefixTree = [];
  await captureLogs(() => sweep(ENV)); // settle + reset partialFails for the blocks below
}

/* 23. duplicate processing: the same key arriving on two pages claims once */
{
  reset([link("aaaa", 1)], "ok");
  failRoot = true;
  injections.set(pfx(0x6c, 8), [{ key: keyFor("aaaa"), value: b64(encodeLink(link("aaaa", 1))) }]);
  const report = await captureLogs(() => sweep(ENV));
  ok(report.scanned === 1, "the record seen on two pages is counted once");
  ok(report.paid.length === 1 && report.paid[0] === "aaaa", "one PAID entry after dedup");
  ok(broadcasts.length === 1, "exactly one claim — overlap can never double-submit");
}

/* 24. query ceiling: unvisited prefixes are counted, never silently dropped */
{
  reset([link("aaaa", 1), link("z".repeat(64), 1)], "ok");
  failRoot = true;
  const report = await captureLogs(() => sweep({ ...ENV, KEEPER_MAX_PAGE_QUERIES: "2" }));
  ok(report.pages === 2, "the ceiling stops the walk after 2 queries");
  ok(report.partial === true && report.failedPages === 59,
    "the 59 unvisited buckets are reported as failed pages");
  ok(JSON.stringify(report.claimed) === '[{"link_id":"aaaa","hash":"Hash1"}]',
    "the visited bucket's link is still settled");
  ok(!report.paid.includes("z".repeat(64)),
    "the unvisited link is not claimed this run — discovery defers, never guesses");
  ok(hasEvent("scan_partial"), "partial coverage logged for the operator");
}

/* 25. scan budget exhausted before any page: same contract as a dead scan */
{
  reset([link("aaaa", 1)], "ok");
  failRoot = true;
  let threw = false;
  await captureLogs(() => sweep({ ...ENV, KEEPER_SCAN_BUDGET_MS: "0" }).catch(() => { threw = true; }));
  ok(threw, "zero budget → nothing readable → sweep rejects (tick 500 / heartbeat ok:false)");
  ok(hasEvent("sweep_failed"), "and logs sweep_failed, exactly like a dead scan");

  reset([link("heal", 1)], "ok");
  await captureLogs(() => sweep(ENV)); // healthy run: reset sweepFails for later blocks
}

/* 26. one access-key read per sweep; nonces walk sequentially from it */
{
  reset([link("n1", 1), link("n2", 1), link("n3", 1)], "ok");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.claimed.length === 3, "three links claimed");
  ok(keyQueries.length === 1, "ONE view_access_key read for three claims (was one per claim)");
  const nonces = broadcasts.map((b) => parseTx(b).nonce);
  ok(JSON.stringify(nonces) === JSON.stringify([42, 43, 44]),
    "nonces 42,43,44 derived from the single read (41 + one per executed tx)");
}

/* 27. unknown broadcast outcome mid-sweep: the cursor is re-read, not guessed */
{
  reset([link("t1", 1), link("t2", 1)], "throw-once");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.failed.length === 1 && report.claimed.length === 1,
    "first claim lost to the network, second still lands");
  ok(keyQueries.length === 2, "the access key is re-read after an unknown outcome");
  ok(parseTx(broadcasts[0]).nonce === 43,
    "the second claim was rebuilt on a fresh cursor (42 re-read → 43), not the stale 42");
}

/* 28. InvalidNonce rejection: the tx was not included, so re-read the chain */
{
  reset([link("i1", 1), link("i2", 1)], "invalid-nonce-once");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.failed.length === 1 && report.claimed.length === 1,
    "the rejected claim fails, the next one lands");
  ok(keyQueries.length === 2, "InvalidNonce nulls the cursor — the chain is re-read");
  ok(parseTx(broadcasts[1]).nonce === 43, "the recovery claim uses the fresh nonce");
  ok(hasEvent("claim_failed", "i1") && hasEvent("claim_successful", "i2"),
    "both outcomes logged");
}

/* ════════════════════ L-02: u128 decode + yoctoNEAR display ═══════════
   borsh u128 = 16 bytes little-endian, LOW limb first — confirmed against
   live view_state bytes (demo-004's amount sits at offset 37 as 25000000
   with a zeroed high limb) and it is the layout the relayer's ru128
   already reads. Pre-L-02 takeU128 returned only the low limb, so any
   value >= 2^64 decoded as its low 64 bits. Field offsets, the claim path
   and settlement are untouched: only the decoded value and its display
   are corrected. */

/* 29. both limbs decode: zero, small, the 2^64 boundary, u128::MAX */
{
  const U128_MAX = (1n << 128n) - 1n;
  const cases = [
    ["zero", 0n, "0"],
    ["one", 1n, "1"],
    ["the live amount (high limb zero)", 25000000n, "25000000"],
    ["2^64-1 (top of the low limb)", (1n << 64n) - 1n, "18446744073709551615"],
    ["2^64 (first value needing the high limb)", 1n << 64n, "18446744073709551616"],
    ["2^64+7 (pre-L-02 showed just 7)", (1n << 64n) + 7n, "18446744073709551623"],
    ["10^30", 10n ** 30n, "1000000000000000000000000000000"],
    ["u128::MAX", U128_MAX, "340282366920938463463374607431768211455"],
  ];
  for (const [label, amount, want] of cases) {
    const d = decodeLink(encodeLink(link("amt1", 0, { amount })));
    ok(d.amount === want, `amount ${label} decodes exactly: ${want}`);
  }
  const paid = decodeLink(encodeLink(link("amt2", 1, { amount: 1n, paid_amount: U128_MAX })));
  ok(paid.paid_amount === "340282366920938463463374607431768211455",
    "the optional paid_amount path reads both limbs too");
  ok(paid.amount === "1" && paid.status === "PAID" && paid.paid_by === "bob.testnet",
    "field alignment after a full-width u128 is intact (status/paid_by land right)");
}

/* 30. wire format: low limb first, high limb second — the exact RPC bytes */
{
  const raw = encodeLink(link("amt3", 0, { amount: (1n << 64n) + 7n }));
  const off = 4 + te.encode("amt3").length + 4 + te.encode("alice.testnet").length;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.length);
  ok(dv.getBigUint64(off, true) === 7n, "bytes 0..8 of the u128 are the LOW limb (7)");
  ok(dv.getBigUint64(off + 8, true) === 1n, "bytes 8..16 are the HIGH limb (1) — order is lo-then-hi");
  const live = Uint8Array.from(Buffer.from(PROD_VAL, "base64"));
  const ldv = new DataView(live.buffer, live.byteOffset, live.length);
  const loff = 4 + "demo-004".length + 4 + "paylink-payee.testnet".length;
  ok(ldv.getBigUint64(loff, true) === 25000000n, "live view_state record: low limb = 25000000");
  ok(ldv.getBigUint64(loff + 8, true) === 0n, "live view_state record: high limb = 0 (RPC serves lo-then-hi)");
}

/* 31. settlement preserved with a > 2^64 amount: discovered, claimed once, 1 yocto */
{
  reset([link("bigamt", 1, { amount: (1n << 64n) + 7n })], "ok");
  const report = await captureLogs(() => sweep(ENV));
  ok(report.scanned === 1 && JSON.stringify(report.claimed) === '[{"link_id":"bigamt","hash":"Hash1"}]',
    "a PAID link with a >2^64 amount is discovered and claimed exactly once");
  ok(parseTx(broadcasts[0]).deposit === 1n, "settlement unchanged: the claim still attaches exactly 1 yoctoNEAR");
}

/* 32. formatYoctoNEAR: zero, one yocto, one NEAR, >64-bit, u128::MAX, junk */
{
  const U128_MAX = (1n << 128n) - 1n;
  ok(formatYoctoNEAR(0n) === "0", "0 yocto -> \"0\"");
  ok(formatYoctoNEAR(1n) === "0.000000000000000000000001", "one yoctoNEAR -> all 24 decimal places");
  ok(formatYoctoNEAR(10n ** 24n) === "1", "exactly one NEAR");
  ok(formatYoctoNEAR(10n ** 24n + 1n) === "1.000000000000000000000001", "one NEAR + one yocto");
  ok(formatYoctoNEAR(15n * 10n ** 23n) === "1.5", "1.5 NEAR — trailing zeros trimmed");
  ok(formatYoctoNEAR(10n ** 30n) === "1000000", "10^30 yocto = 1 000 000 NEAR");
  ok(formatYoctoNEAR(1n << 64n) === "0.000018446744073709551616", "2^64 yocto formats exactly (past 2^53)");
  ok(formatYoctoNEAR((1n << 64n) + 7n) === "0.000018446744073709551623", "2^64+7 yocto — no Number rounding");
  ok(formatYoctoNEAR("1000000000000000000000000") === "1", "canonical RPC decimal-string input");
  ok(formatYoctoNEAR(U128_MAX) === "340282366920938.463463374607431768211455",
    "u128::MAX yocto -> the full-supply NEAR figure, exact");
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(throws(() => formatYoctoNEAR("abc")) && throws(() => formatYoctoNEAR("-1")) && throws(() => formatYoctoNEAR("007")),
    "malformed strings are rejected, never guessed");
  ok(throws(() => formatYoctoNEAR(1.5)) && throws(() => formatYoctoNEAR(100)) && throws(() => formatYoctoNEAR(null)),
    "Numbers are rejected outright — no silent precision loss");
  ok(throws(() => formatYoctoNEAR(U128_MAX + 1n)) && throws(() => formatYoctoNEAR(-1n)),
    "values outside 0..u128::MAX are rejected");
}

/* 33. malformed RPC values: truncated or garbage records are skipped, never claimed */
{
  const full = encodeLink(link("cut1", 1, { amount: (1n << 64n) + 7n }));
  const cutAt = 4 + te.encode("cut1").length + 4 + te.encode("alice.testnet").length + 10; // inside the amount
  ok(cutAt < full.length, "fixture truncates inside the u128 amount");
  let threw = false;
  try { decodeLink(full.subarray(0, cutAt)); } catch { threw = true; }
  ok(threw, "a record cut inside the u128 throws instead of decoding garbage");

  reset([link("good1", 1)], "ok");
  injections.set(pfx(0x6c), [{ key: keyFor("bad1"), value: btoa("AQID") }]); // 3 raw bytes on the same page
  const report = await captureLogs(() => sweep(ENV));
  ok(report.scanned === 1 && JSON.stringify(report.claimed) === '[{"link_id":"good1","hash":"Hash1"}]',
    "the malformed record is skipped; the good PAID link still settles");
  ok(report.failed.length === 0, "a bad value never fails the sweep");
}

/* 34. L-03 status labels: stored byte 3 is CANCELLED, never EXPIRED */
{
  const d3 = decodeLink(encodeLink(link("cxl1", 3)));
  ok(d3.status === "CANCELLED", "stored byte 3 decodes as CANCELLED (not EXPIRED)");
  ok(d3.paid_by === null && d3.paid_amount === null && d3.paid_at === null && d3.claimed_at === null,
    "a cancelled record carries no payment fields");
  ok(decodeLink(encodeLink(link("exp1", 4))).status === "EXPIRED",
    "byte 4 keeps the Expired label for enum fidelity (the contract never stores it)");
  ok(decodeLink(encodeLink(link("unk1", 7))).status === "UNKNOWN_7",
    "a byte outside the enum still surfaces as UNKNOWN_n");

  reset([link("open3", 0), link("paid3", 1), link("cxl3", 3)], "ok");
  const report = await captureLogs(() => sweep(ENV));
  ok(JSON.stringify(report.paid) === '["paid3"]',
    "a CANCELLED link is scanned but never a claim candidate");
  ok(broadcasts.length === 1, "cancelled links are never broadcast to");
  ok(report.scanned === 3, "the cancelled record still decodes cleanly during the scan");
}

/* 35. L-05: /tick auth fails closed — no TICK_SECRET, no sweep */
{
  reset([link("auth1", 1)], "ok"); // a PAID link is waiting: a sweep would claim it

  // Wrong secret: refused before the sweep is ever entered.
  let res = await worker.fetch(
    new Request("https://keeper.test/tick", {
      method: "POST",
      headers: { "x-tick-secret": "not-the-secret" },
    }),
    { ...ENV, TICK_SECRET: "test-tick-secret" },
  );
  ok(res.status === 403, "a wrong x-tick-secret is refused with 403");
  ok(broadcasts.length === 0, "the refused tick never swept — zero broadcasts");

  // Right secret configured, header absent: same refusal.
  res = await worker.fetch(
    new Request("https://keeper.test/tick", { method: "POST" }),
    { ...ENV, TICK_SECRET: "test-tick-secret" },
  );
  ok(res.status === 403, "a missing x-tick-secret header is refused with 403");

  // No secret configured at all: the route is disabled, not wide open.
  res = await worker.fetch(
    new Request("https://keeper.test/tick", { method: "POST" }),
    ENV,
  );
  ok(res.status === 403 && broadcasts.length === 0,
    "with TICK_SECRET unset the route answers 403 and never sweeps");

  const body = await res.json();
  ok(body.error === "forbidden", "the 403 body is generic — no detail leaks");
}

/* 36. L-05 hardening: constant-time TICK_SECRET comparison (Web Crypto) */
{
  const SECRET = "test-tick-secret";
  const post = (headers, env) => worker.fetch(
    new Request("https://keeper.test/tick", { method: "POST", headers }),
    env,
  );
  const full = { ...ENV, TICK_SECRET: SECRET };

  // Accepted: the correct secret still runs a sweep end to end.
  reset([link("ct1", 1)], "ok");
  let res = await post({ "x-tick-secret": SECRET }, full);
  ok(res.status === 200 && (await res.json()).claimed.length === 1,
    "correct secret accepted — endpoint behaviour unchanged");

  // Every rejection shape, through the endpoint — same 403 boundary as before.
  reset([link("ct2", 1)], "ok"); // a PAID link waits; no refusal may sweep it
  res = await post({ "x-tick-secret": "not-the-secret" }, full);
  ok(res.status === 403, "incorrect secret rejected");
  res = await post({ "x-tick-secret": "" }, full);
  ok(res.status === 403, "empty supplied secret rejected");
  res = await post({ "x-tick-secret": SECRET }, ENV); // env carries no TICK_SECRET
  ok(res.status === 403, "missing configured secret rejected");
  res = await post({ "x-tick-secret": SECRET + "-extra" }, full);
  ok(res.status === 403, "different-length (longer) secret rejected");
  res = await post({ "x-tick-secret": SECRET.slice(0, 5) }, full);
  ok(res.status === 403, "different-length (shorter) secret rejected");
  res = await post({ "x-tick-secret": "TEST-tick-SECRET" }, full); // same length, 10 chars differ
  ok(res.status === 403, "multiple mismatched characters rejected");
  ok(broadcasts.length === 0, "no refused attempt ever reached the sweep");

  // Fail closed when Web Crypto is unavailable — no plain-string fallback.
  ok((await secretMatches(SECRET, SECRET, null)) === false,
    "without crypto.subtle the helper fails closed instead of comparing plainly");
  ok((await secretMatches(SECRET, SECRET, {})) === false,
    "an object without digest() also fails closed");
}

/* 37. L-08 P1: reads fail over across RPC endpoints; broadcasts never do */
{
  const FB = "https://rpc-fallback.test";

  // Primary dead outright: reads fail over to RPC_URLS and keep working —
  // the nonce read completing through the fallback is the proof. The
  // broadcast, pinned to the primary, then fails: no failover, no retry.
  reset([link("fb1", 1)], "ok");
  deadUrls = new Set([ENV.RPC_URL]);
  const fbEnv = { ...ENV, RPC_URLS: FB };
  let report = await captureLogs(() => sweep(fbEnv));
  const q = rpcUrlHits.filter((h) => h.method === "query");
  ok(q.length >= 2 && q[0].url === ENV.RPC_URL && q[1].url === FB,
    "reads try the primary first, then fail over to RPC_URLS");
  ok(keyQueries.length === 1,
    "the nonce read completed through the fallback (reads work after failover)");
  const bc = rpcUrlHits.filter((h) => h.method === "broadcast_tx_commit");
  ok(bc.length === 1 && bc[0].url === ENV.RPC_URL,
    "the broadcast was attempted exactly once, on the primary — no failover, no retry");
  ok(report.claimed.length === 0 && report.failed.length === 1,
    "the dead primary's broadcast fails the claim rather than switching endpoints");
  ok(!rpcUrlHits.some((h) => h.url === FB && h.method === "broadcast_tx_commit"),
    "the fallback never received a broadcast");

  // Even with a HEALTHY fallback configured, a failing broadcast does not
  // move: attempted once on the primary, and that is the whole rule.
  reset([link("fb2", 1)], "throw"); // every broadcast attempt throws
  rpcUrlHits = [];
  report = await captureLogs(() => sweep({ ...ENV, RPC_URLS: FB }));
  const bc2 = rpcUrlHits.filter((h) => h.method === "broadcast_tx_commit");
  ok(bc2.length === 1 && bc2[0].url === ENV.RPC_URL,
    "with a healthy fallback, the broadcast still goes only to the primary, once");
  ok(report.failed.length === 1, "and the claim is reported failed");

  // Legacy parity: no RPC_URLS → a query still retries the SAME endpoint
  // (the pre-failover "views retry once on a dropped connection").
  reset([link("fb3", 1)], "ok");
  deadUrls = new Set([ENV.RPC_URL]);
  rpcUrlHits = [];
  await captureLogs(() => sweep(ENV).catch(() => null));
  const q2 = rpcUrlHits.filter((h) => h.method === "query");
  ok(q2.length >= 2 && q2[0].url === ENV.RPC_URL && q2[1].url === ENV.RPC_URL,
    "without RPC_URLS a query still retries the same endpoint (behaviour preserved)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
