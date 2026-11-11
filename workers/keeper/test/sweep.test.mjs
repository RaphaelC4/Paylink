/* Keeper sweep tests — run with: node workers/keeper/test/sweep.test.mjs
 *
 * The sweep runs against a mocked RPC: contract state, access-key reads and
 * broadcasts are all served in-process, so these tests exercise discovery,
 * the exact claim transaction, retry/already-claimed/outage handling and the
 * structured log events without touching the network or a real key. The
 * signing key is generated fresh on every run — no secret lives in this file.
 */

import { generateKeyPairSync } from "node:crypto";
import { sweep, decodeLink, parseSecretKey, pickBatch, ScanError } from "../src/index.js";

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
    l.status, // 0 OPEN, 1 PAID, 2 CLAIMED
    ...opt(l.paid_by == null ? null : strB(l.paid_by)),
    ...opt(l.paid_amount == null ? null : u128b(l.paid_amount)),
    ...opt(l.paid_at == null ? null : u64b(l.paid_at)),
    ...opt(l.claimed_at == null ? null : u64b(l.claimed_at)),
  ]);
}
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

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
let broadcastMode;  // "ok" | "generic-fail" | "not-paid-fail" | "throw"
let broadcasts;     // captured signed transactions
let keyQueries;     // captured view_access_key params
let nonceCounter = 41;
let viewStateMode;  // "ok" | "too-large" | "rpc-down" | "bad-shape" | "junk-record"
let liveOverride;   // link_id -> status string get_link reports (default: same as state)
let liveMode;       // "ok" | "down"
let viewCalls;      // captured get_link link ids

const link = (id, status, extra = {}) => ({
  link_id: id,
  creator: "alice.testnet",
  amount: 1_000_000,
  token: "usdc.tidepool-sandbox.testnet",
  description: "test",
  created_at: 1_794_000_000_000,
  expires_at: null,
  status, // 0 OPEN, 1 PAID, 2 CLAIMED
  paid_by: status >= 1 ? "bob.testnet" : null,
  paid_amount: status >= 1 ? 1_000_000 : null,
  paid_at: status >= 1 ? 1_794_000_100_000 : null,
  claimed_at: status === 2 ? 1_794_000_200_000 : null,
  ...extra,
});

globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const json = (obj) => ({ json: async () => obj });

  if (body.method === "query" && body.params.request_type === "call_function") {
    if (liveMode === "down") throw new Error("view down");
    const id = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()).link_id;
    viewCalls.push(id);
    const l = state.find((x) => x.link_id === id);
    const st = liveOverride[id] ?? (l ? ["OPEN", "PAID", "CLAIMED"][l.status] : null);
    const val = st ? { link_id: id, status: st } : null;
    return json({ result: { result: [...Buffer.from(JSON.stringify(val))], block_hash: BLOCK_HASH } });
  }
  if (body.method === "query" && body.params.request_type === "view_state") {
    if (viewStateMode === "too-large") return json({ error: { message: "State of contract paylink-v2.testnet is too large to be viewed" } });
    if (viewStateMode === "rpc-down") throw new Error("socket hang up");
    if (viewStateMode === "bad-shape") return json({ result: { block_hash: BLOCK_HASH } });
    if (viewStateMode === "junk-record") {
      return json({ result: { values: [{ key: btoa("lbad"), value: b64([9, 9]) },
        ...state.map((l) => ({ key: btoa("l" + l.link_id), value: b64(encodeLink(l)) }))], block_hash: BLOCK_HASH } });
    }
    return json({
      result: {
        values: state.map((l) => ({ key: btoa("l" + l.link_id), value: b64(encodeLink(l)) })),
        block_hash: BLOCK_HASH,
      },
    });
  }
  if (body.method === "query" && body.params.request_type === "view_access_key") {
    keyQueries.push(body.params);
    return json({ result: { nonce: nonceCounter++, block_hash: BLOCK_HASH } });
  }
  if (body.method === "broadcast_tx_commit") {
    if (broadcastMode === "throw") throw new Error("network unreachable");
    broadcasts.push(body.params[0]);
    if (broadcastMode === "ok") {
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
  const deposit = b.readBigUInt64LE(o); o += 16;
  return { signer, nonce, receiver, nActions, actionTag, method, args, gas, deposit };
}

const reset = (links, mode) => {
  state = links;
  broadcastMode = mode;
  broadcasts = [];
  keyQueries = [];
  nonceCounter = 41;
  viewStateMode = "ok";
  liveOverride = {};
  liveMode = "ok";
  viewCalls = [];
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
  const report = await captureLogs(() => sweep(ENV, { now: 0 }));
  ok(report.paid.length === 10, "one sweep caps claims at 10");
  ok(broadcasts.length === 10, "cap bounds the broadcasts too");
  const deferred = events().filter((e) => e.event === "retry_scheduled" && /^bulk[89]$/.test(e.link_id));
  ok(deferred.length === 2, "the 2 over-cap links are logged retry_scheduled for the next run");
}

/* 8b. rotation: over the cap, the window advances so no link is starved */
{
  const many = Array.from({ length: 25 }, (_, i) => link(`rot${String(i).padStart(2, "0")}`, 1));
  const seen = new Set();
  for (let minute = 0; minute < 3; minute++) {
    const { batch, deferred } = pickBatch(many, minute * 60_000);
    ok(batch.length === 10 && batch.length + deferred.length === 25, `minute ${minute}: batch of 10, rest deferred`);
    batch.forEach((l) => seen.add(l.link_id));
  }
  ok(seen.size === 25, "every link is reached within ceil(25/10)=3 minutes (no starvation)");
  ok(pickBatch(many.slice(0, 10), 5).batch.length === 10 && pickBatch(many.slice(0, 10), 5).deferred.length === 0,
    "exactly at the cap: everything in one batch, nothing deferred");
  ok(pickBatch([], 0).batch.length === 0, "empty input: empty batch");
  reset(many, "ok");
  const r0 = await captureLogs(() => sweep(ENV, { now: 0 }));
  const r1 = await captureLogs(() => sweep(ENV, { now: 60_000 }));
  ok(r0.paid[0] === "rot00" && r1.paid[0] === "rot10", "sweep honours the rotating window");
}

/* 8c. duplicate guard: live status checked before every broadcast */
{
  reset([link("dupA", 1), link("dupB", 1)], "ok");
  liveOverride = { dupA: "CLAIMED" }; // claimed elsewhere / in flight since the final-state scan
  const r = await captureLogs(() => sweep(ENV));
  ok(broadcasts.length === 1 && JSON.parse(parseTx(broadcasts[0]).args).link_id === "dupB", "link already CLAIMED live is not re-broadcast");
  ok(r.skipped.length === 1 && r.skipped[0].link_id === "dupA" && hasEvent("claim_skipped", "dupA"), "skip reported and logged");
  ok(viewCalls.length === 2, "one get_link view per candidate");

  reset([link("dupC", 1)], "ok");
  liveMode = "down"; // the view itself fails: fail open, settlement must not wait on it
  const r2 = await captureLogs(() => sweep(ENV));
  ok(r2.claimed.length === 1 && broadcasts.length === 1, "live-status outage fails open: claim still goes out");

  reset([link("dupD", 1)], "ok");
  liveOverride = { dupD: "PAID" };
  await captureLogs(() => sweep(ENV));
  ok(broadcasts.length === 1, "live PAID proceeds with exactly one claim");
}

/* 8d. scan failures: classified, logged, never read as "nothing PAID" */
{
  for (const [mode, reason] of [["too-large", "account_state_too_large"], ["rpc-down", "rpc_failed"], ["bad-shape", "bad_response"]]) {
    reset([link("pX", 1)], "ok");
    viewStateMode = mode;
    let err = null;
    await captureLogs(() => sweep(ENV).catch((e) => { err = e; }));
    ok(err instanceof ScanError && err.reason === reason, `scan ${mode} -> ScanError(${reason})`);
    ok(events().some((e) => e.event === "scan_failed" && e.reason === reason) && hasEvent("retry_scheduled"), `scan ${mode} logs scan_failed + retry_scheduled`);
    ok(broadcasts.length === 0, `scan ${mode}: nothing broadcast on a failed scan`);
  }
  /* recovery: the next run, scan healthy again, settles the link */
  viewStateMode = "ok";
  const r = await captureLogs(() => sweep(ENV));
  ok(r.claimed.length === 1, "next run after a failed scan settles the stranded link");
}

/* 8e. undecodable record: counted and shouted about, PAID links still settle */
{
  reset([link("goodP", 1)], "ok");
  viewStateMode = "junk-record";
  const r = await captureLogs(() => sweep(ENV));
  ok(r.undecodable === 1 && hasEvent("scan_degraded"), "undecodable record reported (scan_degraded), not silently dropped");
  ok(r.claimed.length === 1, "readable PAID link is still settled");
}

/* 8f. idempotent retry: claim reverted to PAID by on_claimed is picked up again */
{
  reset([link("flap", 1)], "generic-fail");
  await captureLogs(() => sweep(ENV));
  broadcastMode = "ok";
  const r = await captureLogs(() => sweep(ENV));
  ok(broadcasts.length === 2 && r.claimed.length === 1, "failed claim retried next run, exactly one successful claim");
}

/* 9. parseSecretKey still refuses a public key pasted as the secret */
{
  let threw = false;
  try { parseSecretKey({ KEEPER_KEY: KEEPER_PUB }); } catch { threw = true; }
  ok(threw, "parseSecretKey rejects a public key (paste-safety guard intact)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
