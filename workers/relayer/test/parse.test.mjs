/* Relayer parser/signing tests — run with: node workers/relayer/test/parse.test.mjs
 *
 * The two fixtures are REAL SignedDelegateActions that the chain accepted:
 *   FIX_CLI  — near-cli-rs construct-meta-transaction, created link spikea01
 *   FIX_MET  — Meteor Wallet signDelegateActions,        created link spikea02
 * If parse + signature verification both hold on fixtures from two different
 * signers, the preimage this Worker checks is the one the chain checks.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import worker, { parseSignedDelegate, signDelegateTx, submit, logEvent } from "../src/index.js";

const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const FIX_CLI =
  "FQAAAHBheWxpbmstcGF5ZWUudGVzdG5ldBIAAABwYXlsaW5rLXYyLnRlc3RuZXQBAAAAAgsAAABjcmVhdGVfbGlua44AAAB7ImxpbmtfaWQiOiJzcGlrZWEwMSIsImFtb3VudCI6IjEwMDAwMDAiLCJ0b2tlbiI6InVzZGMudGlkZXBvb2wtc2FuZGJveC50ZXN0bmV0IiwiZGVzY3JpcHRpb24iOiJzcGlrZSBBIHJlbGF5ZXIgc3Rha2UgdGVzdCIsImV4cGlyZXNfYXQiOm51bGx9ACA9iHktAAAAAECyusngGR4CAAAAAAAAIDmhMO/6AABYFH4QAAAAAABIJWAU487c3QnTFgQAHS3vXI4ZAdbVFWfmzN/H3x+xKwA/bGGNPGz7qMqbo9D2GTf/a/nyZ6ENePM+ZDpneoO8almukf2fNTdQl61/QJHcDcaWHgFiseZFQSgzpxVwgIMF";
const FIX_MET =
  "FQAAAHBheWxpbmstcGF5ZWUudGVzdG5ldBIAAABwYXlsaW5rLXYyLnRlc3RuZXQBAAAAAgsAAABjcmVhdGVfbGlua4sAAAB7ImxpbmtfaWQiOiJzcGlrZWEwMiIsImFtb3VudCI6IjEwMDAwMDAiLCJ0b2tlbiI6InVzZGMudGlkZXBvb2wtc2FuZGJveC50ZXN0bmV0IiwiZGVzY3JpcHRpb24iOiJzcGlrZSBCIG1ldGVvciBkZWxlZ2F0ZSIsImV4cGlyZXNfYXQiOm51bGx9ACA9iHktAAAAAECyusngGR4CAAAAAAAAITmhMO/6AABgFX4QAAAAAABIJWAU487c3QnTFgQAHS3vXI4ZAdbVFWfmzN/H3x+xKwCPWUo0Go+teySFKmFaF2VdPRbFxsxwfu9eFJMPqq8l9r1+72Jb8JRK6reu/G7+tdP2w5VGLWouQVQdwq0UqQwF";

const env = {
  CONTRACT_ID: "paylink-v2.testnet",
  TOKEN_ID: "usdc.tidepool-sandbox.testnet",
};
const PAYEE_PUBKEY = "5rdQjR4c8YNBzgyEmeb4UnNsseqvfUg5SCAsswqrTu6S";

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("FAIL  " + name); }
};
const throwsWith = (fn, name, needle) => {
  try {
    fn();
    fail++; console.log("FAIL  " + name + " (did not throw)");
  } catch (e) {
    if (needle && !String(e.message).includes(needle)) {
      fail++; console.log(`FAIL  ${name} (message was: ${e.message})`);
    } else { pass++; console.log("  ok  " + name); }
  }
};

/* ── parse: both real fixtures ── */

for (const [label, fix, linkId, desc] of [
  ["cli", FIX_CLI, "spikea01", "spike A relayer stake test"],
  ["meteor", FIX_MET, "spikea02", "spike B meteor delegate"],
]) {
  const raw = b64decode(fix);
  const p = parseSignedDelegate(raw, env);
  ok(p.sender_id === "paylink-payee.testnet", `${label}: sender is the payee`);
  ok(p.receiver_id === "paylink-v2.testnet", `${label}: receiver is the contract`);
  ok(p.method === "create_link", `${label}: method is create_link`);
  ok(p.args.link_id === linkId, `${label}: link_id is ${linkId}`);
  ok(p.args.amount === "1000000", `${label}: amount 1000000`);
  ok(p.args.token === env.TOKEN_ID, `${label}: token is the allowlisted one`);
  ok(p.args.description === desc, `${label}: description round-trips`);
  ok(p.deposit === 10_000_000_000_000_000_000_000n, `${label}: deposit is 0.01 NEAR`);
  ok(p.gas === 50_000_000_000_000n, `${label}: inner gas 50 Tgas`);
  ok(p.nonce > 0n, `${label}: nonce positive`);
  ok(p.max_block_height > 276_000_000n, `${label}: max_block_height plausible`);
  ok(p.signature.length === 64, `${label}: signature is 64 bytes`);
  ok(p.raw === raw, `${label}: raw bytes preserved for embedding`);

  /* pubkey must be the payee's on-chain key (checked earlier via
     view_access_key: ed25519:5rdQjR4c8YNBzgyEmeb4UnNsseqvfUg5SCAsswqrTu6S) */
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58encode = (bytes) => {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let s = "";
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
    return s || "1";
  };
  ok(b58encode(p.publicKey) === PAYEE_PUBKEY, `${label}: public key is the payee's`);
}

/* ── validation: rejections happen here, not on chain at our expense ── */

const rawCli = b64decode(FIX_CLI);
throwsWith(() => parseSignedDelegate(rawCli, { ...env, CONTRACT_ID: "other.testnet" }),
  "wrong receiver rejected", "receiver must be");
throwsWith(() => parseSignedDelegate(rawCli, { ...env, TOKEN_ID: "usdt.tidepool-sandbox.testnet" }),
  "wrong token rejected", "token must be");
throwsWith(() => parseSignedDelegate(rawCli.subarray(0, rawCli.length - 10), env),
  "truncated delegate rejected", "truncated");
throwsWith(() => parseSignedDelegate(concat(rawCli, Uint8Array.of(0)), env),
  "trailing bytes rejected", "trailing bytes");
/* method tamper: flip the last byte of "create_link" in place (same length,
   so every later offset still parses — only the method check can catch it) */
{
  const tampered = Uint8Array.from(rawCli);
  const needle = [0x63, 0x72, 0x65, 0x61, 0x74, 0x65, 0x5f, 0x6c, 0x69, 0x6e, 0x6b]; // create_link
  let at = -1;
  outer: for (let i = 0; i <= tampered.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (tampered[i + j] !== needle[j]) continue outer;
    at = i; break;
  }
  ok(at >= 0, "fixture contains the method bytes");
  tampered[at + needle.length - 1] = 0x4b; // create_linK
  throwsWith(() => parseSignedDelegate(tampered, env), "wrong method rejected", "create_link");
}

function concat(...parts) {
  const arr = [];
  for (const p of parts) arr.push(...p);
  return Uint8Array.from(arr);
}

/* ── signature: NEP-461 preimage verifies both signers? ──
   nearcore SignedDelegateAction::verify() signs
     sha256( borsh(u32 discriminant) ++ borsh(DelegateAction) )
   where discriminant = 2^30 + 366 (on-chain NEP range + NEP-366) — see
   core/primitives/src/signable_message.rs and get_nep461_hash(). The chain
   accepted both fixtures, so if this preimage verifies both, it is the
   chain's preimage — which is what lets the Worker reject forged input
   before spending relayer gas. Skipped if the runtime has no Ed25519. */

const subtle = globalThis.crypto?.subtle;
if (!subtle) {
  console.log("SKIP  Ed25519 verification (no WebCrypto in this runtime)");
} else {
  const NEP461_DISCRIMINANT = (1 << 30) + 366; // 1073742190, u32 LE by borsh
  const disc = new Uint8Array(4);
  new DataView(disc.buffer).setUint32(0, NEP461_DISCRIMINANT, true);

  for (const [label, fix] of [["cli", FIX_CLI], ["meteor", FIX_MET]]) {
    const raw = b64decode(fix);
    const delegateAction = raw.subarray(0, raw.length - 65); // strip 0x00||64-byte signature
    const signature = raw.subarray(raw.length - 64);
    const pubkeyRaw = parseSignedDelegate(raw, env).publicKey;

    const preimage = new Uint8Array(4 + delegateAction.length);
    preimage.set(disc, 0);
    preimage.set(delegateAction, 4);
    const digest = new Uint8Array(await subtle.digest("SHA-256", preimage));
    const key = await subtle.importKey("raw", pubkeyRaw,
      { name: "Ed25519" }, false, ["verify"]);
    const good = await subtle.verify({ name: "Ed25519" }, key, signature, digest);
    ok(good, `${label}: NEP-461 preimage verifies (chain preimage confirmed)`);
  }
}

/* ── outer transaction: embed the delegate verbatim, receiver = sender ── */

{
  /* Signing key generated fresh on every run — the outer-signature test needs
     *a* consistent seed||pub pair, never a real account's key. No secret key
     *is stored in this file (the one that was got rotated out on sight). */
  const kp = generateKeyPairSync("ed25519");
  const pkcs8 = kp.privateKey.export({ type: "pkcs8", format: "der" });
  const spki = kp.publicKey.export({ type: "spki", format: "der" });
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(pkcs8.length - 32), 0); // seed
  secret.set(spki.subarray(spki.length - 32), 32);  // matching public half
  ok(secret.length === 64, "generated signing secret is 64 bytes");

  const raw = b64decode(FIX_MET);
  const txB64 = await signDelegateTx({
    secret,
    account: "paylink-relay.testnet",
    senderId: "paylink-payee.testnet",
    delegateRaw: raw,
    nonce: 7n,
    blockHash: "75xVe8oDH4VV9uKpcGsx7xTQFWtNsbngukNMC8qsqKTw",
  });
  const tx = b64decode(txB64);

  let o = 0;
  const ru32 = () => { const v = new DataView(tx.buffer, tx.byteOffset + o, 4).getUint32(0, true); o += 4; return v; };
  const rstr = () => { const n = ru32(); const s = new TextDecoder().decode(tx.subarray(o, o + n)); o += n; return s; };

  ok(rstr() === "paylink-relay.testnet", "outer signer is the relayer");
  ok(tx[o] === 0, "public key tag is ED25519"); o += 33;
  const nonce = new DataView(tx.buffer, tx.byteOffset + o, 8).getBigUint64(0, true); o += 8;
  ok(nonce === 7n, "outer nonce round-trips");
  ok(rstr() === "paylink-payee.testnet", "outer receiver is the delegate's sender (NEP-366 rule 3)");
  o += 32; // block hash
  ok(ru32() === 1, "one action");
  ok(tx[o] === 8, "action tag is Delegate"); o += 1;
  ok(tx.subarray(o, o + raw.length).every((b, i) => b === raw[i]), "delegate bytes embedded verbatim");
  o += raw.length;
  ok(tx[o] === 0 && tx.length - o === 65, "outer signature tag + 64 bytes tail");
}

/* ── H-01: deposit ceiling — MIN_STAKE <= deposit <= MAX_DEPOSIT ──
 *
 * The contract accepts >= 0.01 NEAR with no ceiling, so an unbounded deposit
 * in a delegated create is money this relayer funds with no way back (excess
 * lands in the contract, which has no withdrawal). These tests pin both ends
 * of the window, the Borsh u128 handling, and — via submit() with fetch
 * stubbed — that an over-cap delegate dies before any network call. */

const MIN_D = 10_000_000_000_000_000_000_000n;  // 0.01 NEAR, mirrors MIN_STAKE
const MAX_D = 20_000_000_000_000_000_000_000n;  // 0.02 NEAR, mirrors MAX_DEPOSIT

/* Walk the Borsh layout to the deposit field — sender u32+bytes, receiver
   u32+bytes, u32 action count, u8 tag, method u32+bytes, u32 args len +
   args, u64 gas, then the u128 deposit. */
function depositOffset(raw) {
  let o = 0;
  const u32 = () => { const v = new DataView(raw.buffer, raw.byteOffset + o, 4).getUint32(0, true); o += 4; return v; };
  const skip = (n) => { o += n; };
  skip(u32()); // sender_id
  skip(u32()); // receiver_id
  skip(4);     // actions vector length
  skip(1);     // FunctionCall tag
  skip(u32()); // method_name
  skip(u32()); // args
  skip(8);     // gas
  return o;    // deposit: 16-byte LE u128
}

/* Rewrite the deposit in place, preserving every other byte of the delegate. */
function withDeposit(raw, value) {
  const out = Uint8Array.from(raw);
  const at = depositOffset(out);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(at, value & 0xFFFF_FFFF_FFFF_FFFFn, true);
  dv.setBigUint64(at + 8, value >> 64n, true);
  return out;
}

/* Accept-or-report: a parse that should succeed must not abort the run. */
function parses(raw, name) {
  try {
    const p = parseSignedDelegate(raw, env);
    pass++; console.log("  ok  " + name);
    return p;
  } catch (e) {
    fail++; console.log(`FAIL  ${name} (threw: ${e.message})`);
    return null;
  }
}

/* walker sanity: lands on the fixture's known 0.01 NEAR deposit */
{
  const at = depositOffset(rawCli);
  const dv = new DataView(rawCli.buffer, rawCli.byteOffset + at, 16);
  const seen = dv.getBigUint64(0, true) + (dv.getBigUint64(8, true) << 64n);
  ok(seen === MIN_D, "borsh walker lands on the fixture's 0.01 NEAR deposit");
}

/* 1. below MIN_STAKE — rejected */
throwsWith(() => parseSignedDelegate(withDeposit(rawCli, MIN_D - 1n), env),
  "deposit below MIN_STAKE rejected", "at least 0.01 NEAR");

/* 2. exactly MIN_STAKE — accepted (what every real sender attaches) */
{
  const p = parses(withDeposit(rawCli, MIN_D), "deposit == MIN_STAKE accepted");
  ok(p !== null && p.deposit === MIN_D, "parsed deposit is exactly MIN_STAKE");
}

/* 3. exactly MAX_DEPOSIT — accepted (the ceiling is inclusive) */
{
  const p = parses(withDeposit(rawCli, MAX_D), "deposit == MAX_DEPOSIT accepted");
  ok(p !== null && p.deposit === MAX_D, "parsed deposit is exactly MAX_DEPOSIT");
}

/* 4. above MAX_DEPOSIT — rejected */
throwsWith(() => parseSignedDelegate(withDeposit(rawCli, MAX_D + 1n), env),
  "deposit above MAX_DEPOSIT rejected", "exceeds the 0.02 NEAR maximum");

/* 5. malformed Borsh deposit (truncated inside the u128) — rejected */
throwsWith(() => parseSignedDelegate(rawCli.subarray(0, depositOffset(rawCli) + 8), env),
  "malformed (half-written) deposit rejected", "truncated");

/* 6. missing deposit (delegate ends where the u128 should start) — rejected */
throwsWith(() => parseSignedDelegate(rawCli.subarray(0, depositOffset(rawCli)), env),
  "missing deposit rejected", "truncated");

/* 7. u128::MAX — rejected with the exact value, no precision loss, no crash */
throwsWith(() => parseSignedDelegate(withDeposit(rawCli, 2n ** 128n - 1n), env),
  "u128::MAX deposit rejected", "340282366920938463463374607431768211455");
/* one yocto over the minimum — inside the window, and the exact value must
   survive the parse (a float path would flatten 10^22+1 to 10^22) */
{
  const p = parses(withDeposit(rawCli, MIN_D + 1n), "deposit == MIN_STAKE + 1 yocto accepted");
  ok(p !== null && p.deposit === MIN_D + 1n, "1-yocto precision survives the parse");
}

/* 8. a normal valid Paylink create_link delegate — still accepted */
{
  const p = parses(Uint8Array.from(rawCli), "normal valid create_link delegate accepted");
  ok(p !== null && p.method === "create_link" && p.deposit === MIN_D,
    "normal delegate keeps method and 0.01 NEAR deposit");
}

/* ── consistency guard: contract stake vs relayer window ──
   MIN_STAKE must equal the contract's CREATE_STORAGE_STAKE (the chain
   rejects below it) and MAX_DEPOSIT must keep a margin above it (once the
   contract's stake passes the ceiling, every delegated create dies at this
   relayer). Checked against the Rust source at test time — no RPC, no shared
   constant, so no runtime coupling; the behavioral tests above already pin
   src's MIN_STAKE/MAX_DEPOSIT to these literals, closing the loop. */
{
  let src = null;
  try {
    src = readFileSync(new URL("../../../contracts/paylink-contract/src/lib.rs", import.meta.url), "utf8");
  } catch (e) {
    ok(false, `contract source readable for the stake guard (${String(e.message || e)})`);
  }
  const m = src === null ? null
    : src.match(/CREATE_STORAGE_STAKE[^=]*=\s*NearToken::from_millinear\((\d+)\)/);
  if (src !== null) ok(m !== null, "CREATE_STORAGE_STAKE found in the contract source");
  if (m) {
    const stake = BigInt(m[1]) * 1_000_000_000_000_000_000_000n; // millinear -> yocto
    ok(stake === MIN_D, `relayer MIN_STAKE mirrors the contract stake (${m[1]} millinear NEAR)`);
    ok(MAX_D >= 2n * stake, "MAX_DEPOSIT keeps at least a 2x margin over the contract stake");
  }
}

/* ── proof: rejection happens BEFORE any broadcast ──
   submit() order is rate limit -> base64 -> parseSignedDelegate -> signature
   -> RPC -> broadcast. With fetch stubbed, an over-cap delegate must fail at
   the parse step with zero network calls; a control run proves the stub is
   live by reaching the RPC with a valid delegate. */
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("network disabled in test"); };
  try {
    let over = null;
    try {
      await submit(env, { signedDelegateAction: b64encode(withDeposit(rawCli, MAX_D + 1n)) }, "203.0.113.7");
    } catch (e) { over = e; }
    ok(over !== null && over.status === 400, "submit answers 400 for an over-cap deposit");
    ok(over !== null && String(over.message).includes("exceeds the 0.02 NEAR maximum"),
      "submit fails at the deposit ceiling, not elsewhere");
    ok(calls === 0, "zero fetch calls — nothing was contacted or broadcast");

    /* control: same stub, valid delegate — the network IS reached */
    calls = 0;
    let ctl = null;
    try {
      await submit(env, { signedDelegateAction: b64encode(Uint8Array.from(rawCli)) }, "203.0.113.8");
    } catch (e) { ctl = e; }
    ok(calls >= 1, "control: a valid delegate reaches the RPC (stub is live)");
    ok(ctl !== null && ctl.status !== 400, "control fails later than the parse step");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ── build stamp: GET / must say which code is deployed ──
   The Worker is deployed by dashboard paste, so this field is the only way
   to answer "which build is live?" remotely. Keep the literal in sync with
   BUILD in src/index.js — a bump that forgets the test fails here. */
{
  const res = await worker.fetch(new Request("https://relayer.test/"), env);
  const body = await res.json();
  ok(res.status === 200 && body.ok === true, "GET / still answers ok");
  ok(body.build === "20261110c", "GET / reports the build stamp (bump with BUILD)");
}

/* ═════════════════════════════ M-07: composite rate limiting ═══════
   Layer 1 = local 10/hour sliding window (always on). Layer 2 = the
   RATE_LIMITER binding — a durable 10/60s burst cap counted across
   isolates — when provisioned. Identity = cf-connecting-ip (edge-set);
   X-Forwarded-For deliberately ignored; missing/blank collapses into the
   shared "unknown" bucket. Binding denial -> Retry-After 60 (its period);
   local denial -> seconds until the hour window expires. */

const capture = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, err: e };
  }
};

const postSubmit = (body, env2, headers = {}) =>
  worker.fetch(
    new Request("https://relayer.test/submit", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env2,
  );

/* ── below / at / over the local limit, via submit() and via the handler ── */
{
  const ip = "203.0.113.60";
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const r = await capture(() => submit(env, {}, ip));
    statuses.push(r.ok ? 200 : r.err.status);
  }
  ok(statuses.slice(0, 10).every((s) => s === 400),
    "below the limit: the first 10 pass the limiter (then fail at body validation)");
  ok(statuses[10] === 429, "the 11th request from one IP -> 429");

  const r11 = await capture(() => submit(env, {}, ip));
  ok(r11.err && r11.err.status === 429, "429 repeats while the window holds");
  ok(r11.err && typeof r11.err.retryAfter === "number" && r11.err.retryAfter > 0 && r11.err.retryAfter <= 3600,
    "429 carries a bounded Retry-After (seconds until window expiry)");
  ok(r11.err && String(r11.err.message).includes("try again later"),
    "429 message is generic — no internals");

  const res = await postSubmit({}, env, { "cf-connecting-ip": ip });
  ok(res.status === 429, "handler surfaces the 429");
  const ra = Number(res.headers.get("retry-after"));
  ok(Number.isFinite(ra) && ra > 0 && ra <= 3600, "429 response carries Retry-After in seconds");
  const b429 = await res.json();
  ok(typeof b429.error === "string" && !b429.error.includes(ip), "429 body is a safe generic message");

  /* window expiry — advance the clock instead of waiting an hour */
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60 * 60 * 1000 + 5_000;
    const after = await capture(() => submit(env, {}, ip));
    ok(after.ok === false && after.err.status === 400,
      "expired window: the same IP is allowed again after an hour (fails only at body validation)");
  } finally {
    Date.now = realNow;
  }
}

/* ── missing / invalid client identifiers ── */
{
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await postSubmit({}, env, {}); // no cf-connecting-ip at all
    statuses.push(res.status);
  }
  ok(statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429,
    "missing client id: one shared unknown bucket, 11th -> 429");

  const blank = await postSubmit({}, env, { "cf-connecting-ip": "   " });
  ok(blank.status === 429, "blank client id shares that bucket (no fresh bucket per request)");
}

/* ── spoofing: rotating alternate identity headers cannot mint buckets ── */
{
  const ip = "203.0.113.77";
  const xffs = ["1.1.1.1", "2.2.2.2", "9.9.9.9"];
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await postSubmit({}, env, {
      "cf-connecting-ip": ip,
      "x-forwarded-for": xffs[i % 3],
      "x-real-ip": `10.0.0.${i}`,
    });
    statuses.push(res.status);
  }
  ok(statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429,
    "rotating X-Forwarded-For/X-Real-IP cannot mint fresh buckets — one edge IP, one bucket");
}

/* ── binding layer: refusal, health, keying ── */
{
  const denyEnv = { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  let r = await capture(() => submit(denyEnv, {}, "203.0.113.61"));
  ok(r.err && r.err.status === 429 && r.err.retryAfter === 60,
    "binding refusal -> 429 with the binding's period as Retry-After");

  const keys = [];
  const goodEnv = {
    ...env,
    RATE_LIMITER: {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    },
  };
  r = await capture(() => submit(goodEnv, {}, "203.0.113.62"));
  ok(r.err && r.err.status === 400, "healthy binding never blocks a normal request");
  ok(keys[0] === "203.0.113.62", "binding is keyed by the same client IP");

  /* The refusal must also reach the WIRE with its header — err.retryAfter ->
     Retry-After is a handler-level seam submit() alone cannot prove. */
  const wire = await postSubmit(
    {},
    { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } },
    { "cf-connecting-ip": "203.0.113.68" },
  );
  ok(wire.status === 429, "handler: a binding refusal surfaces as HTTP 429");
  ok(wire.headers.get("retry-after") === "60",
    "handler: the binding 429 carries Retry-After: 60 (its period)");
}

/* ── across separate instances: the durable layer holds where memory cannot
      (each dynamic import is a fresh module = a simulated second isolate) ── */
{
  let n = 0;
  const sharedKeys = [];
  const shared = {
    limit: async ({ key }) => {
      n++;
      sharedKeys.push(key);
      return { success: n <= 10, limit: 10, remaining: Math.max(0, 10 - n) };
    },
  };
  const isoA = await import(new URL("../src/index.js?iso=a", import.meta.url).href);
  const isoB = await import(new URL("../src/index.js?iso=b", import.meta.url).href);
  const isoC = await import(new URL("../src/index.js?iso=c", import.meta.url).href);
  const ipX = "203.0.113.90";
  const xEnv = { ...env, RATE_LIMITER: shared };

  const aStatuses = [];
  for (let i = 0; i < 10; i++) {
    const r = await capture(() => isoA.submit(xEnv, {}, ipX));
    aStatuses.push(r.ok ? 200 : r.err.status);
  }
  ok(aStatuses.every((s) => s === 400), "instance A: its 10 requests pass both layers");
  ok(sharedKeys.length === 10 && sharedKeys.every((k) => k === ipX),
    "the shared binding counted every one, keyed by the IP");

  const rB = await capture(() => isoB.submit(xEnv, {}, ipX));
  ok(rB.err && rB.err.status === 429,
    "instance B (fresh memory, same binding) is refused — durable across instances");

  const rC = await capture(() => isoC.submit({ ...env }, {}, ipX));
  ok(rC.err && rC.err.status === 400,
    "control: without the binding a fresh instance starts a new local window (the gap layer 2 closes)");
}

/* ── binding backend failure: local layer still caps, loudly ── */
{
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => {
    const line = args.join(" ");
    /* Capture only the Worker's rate-limiter log lines for assertion; let
       everything else (ok/FAIL lines) print normally. */
    if (line.includes("rate limiter")) logged.push(line);
    else realLog(...args);
  };
  try {
    const brokenEnv = {
      ...env,
      RATE_LIMITER: {
        limit: async () => {
          throw new Error("backend down");
        },
      },
    };
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const r = await capture(() => submit(brokenEnv, {}, "203.0.113.63"));
      statuses.push(r.ok ? 200 : r.err.status);
    }
    ok(statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429,
      "binding backend down: the local window still caps at 10 — never unlimited");
    ok(logged.some((l) => l.includes("rate limiter unavailable")),
      "the binding failure is logged, not silent");

    const weirdEnv = { ...env, RATE_LIMITER: { limit: async () => ({ note: "no success field" }) } };
    const r = await capture(() => submit(weirdEnv, {}, "203.0.113.64"));
    ok(r.err && r.err.status === 400,
      "unexpected binding shape degrades to the local layer (no blanket 429)");
    ok(logged.some((l) => l.includes("unexpected limit() result")),
      "the odd shape is logged too");
  } finally {
    console.log = realLog;
  }
}

/* ── invalid/oversized requests are cheap and clearly rejected ── */
{
  let res = await postSubmit({ signedDelegateAction: "A".repeat(70_000) }, env,
    { "cf-connecting-ip": "203.0.113.65" });
  ok(res.status === 413, "70 KB body -> 413 before any parsing");

  res = await worker.fetch(
    new Request("https://relayer.test/submit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "99999999",
        "cf-connecting-ip": "203.0.113.65",
      },
      body: "{}",
    }),
    env,
  );
  ok(res.status === 413, "declared Content-Length over the cap -> 413 before the body is read");

  res = await postSubmit("this is not json", env, { "cf-connecting-ip": "203.0.113.66" });
  const b = await res.json();
  ok(res.status === 400 && b.error === "invalid JSON body",
    "malformed JSON still 400 with the original message");
}

/* ── legitimate payment creation under the composite limiter ── */
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("network disabled in test");
  };
  try {
    const goodEnv = { ...env, RATE_LIMITER: { limit: async () => ({ success: true }) } };
    let r = null;
    try {
      await submit(goodEnv, { signedDelegateAction: FIX_CLI }, "203.0.113.67");
    } catch (e) {
      r = e;
    }
    ok(calls >= 1, "legitimate payment creation passes both limiter layers and reaches the RPC");
    ok(r === null || r.status !== 429, "and is never the request that gets rate-limited");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ── Map overflow: fewest-hit eviction, never a wholesale clear() ──
   Runs LAST — it permanently fills this module's Map past the 10k bound.
   The single prune pass (throttled to once a minute) finds every key still
   live in-window and must evict only the 1-hit flood keys: the heavy
   10-hit client stays capped. The old hits.clear() rearm'd its full quota,
   which is the defect this replaced — clear-all fails the last assertion. */
{
  const heavy = "198.51.100.200";
  const setup = [];
  for (let i = 0; i < 10; i++) {
    const r = await capture(() => submit(env, {}, heavy));
    setup.push(r.ok ? 200 : r.err.status);
  }
  ok(setup.every((s) => s === 400), "overflow setup: the heavy client spends its full 10/hour");

  const flood = [];
  for (let i = 0; i < 10_010; i++) {
    const r = await capture(() => submit(env, {}, `flood-${i}`));
    flood.push(r.ok ? 200 : r.err.status);
  }
  ok(flood.every((s) => s === 400),
    "10_010 fresh keys push the Map past 10k and fire the throttled prune");

  const after = await capture(() => submit(env, {}, heavy));
  ok(after.err && after.err.status === 429,
    "after the prune the heavy client is still capped — eviction, not clear-all");
}

/* ═══════════════════════════ M-01: structured logging & alerts ═══════
   Every operational line the Worker emits is one JSON record
   {ts, svc, build, level, event, ...} — assertions parse captured console
   output rather than scraping text. Nothing here touches the network:
   globalThis.fetch is stubbed per scenario, the "chain" is an in-process
   mock, and the only "webhook" is a local stub. Runs after the overflow
   block: that block's prune already fired, so the once-a-minute throttle
   guarantees no prune can evict keys mid-test here. */

const withLogs = async (fn) => {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.log = realLog;
  }
};
const evs = (lines) =>
  lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/* ── GET /: health shape — fixed key allowlist, counters only ── */
{
  const res = await worker.fetch(
    new Request("https://relayer.test/"),
    { ...env, RELAYER_ACCOUNT: "paylink-relayer.testnet" },
  );
  const body = await res.json();
  const keys = Object.keys(body).sort();
  ok(JSON.stringify(keys) === JSON.stringify(["account", "build", "contract", "ok", "service", "stats"]),
    "GET / body is a fixed key allowlist (no per-request or user data)");
  const skeys = Object.keys(body.stats || {}).sort();
  ok(JSON.stringify(skeys) === JSON.stringify(["errors", "ok", "rate_limited", "rejected", "started", "submit"]),
    "stats expose only aggregate per-isolate counters");
  ok(typeof body.stats.submit === "number" && body.stats.submit >= 1,
    "the counters actually counted this suite's traffic");
  ok(!("rid" in body) && !("ip" in body) && !JSON.stringify(body).includes("ed25519"),
    "health output carries no correlation ids, IPs or key material");
}

/* ── rejection paths: reason codes + correlation id echo ── */
{
  const a = await withLogs(() =>
    postSubmit({}, env, { "cf-connecting-ip": "198.51.100.201" }));
  ok(a.value.status === 400, "handler maps a missing delegate to 400");
  const [ev] = evs(a.lines).filter((e) => e.event === "submit_rejected");
  ok(ev && ev.reason === "bad_request" && ev.status === 400,
    "missing delegate logs submit_rejected with reason bad_request");
  const rid = a.value.headers.get("x-request-id");
  ok(typeof rid === "string" && rid.length === 8, "response carries an 8-char X-Request-Id");
  ok(ev && ev.rid === rid, "the log line's rid matches the echoed header");
  ok(ev && ev.svc === "paylink-relayer" && ev.build === "20261110c" && ev.level === "info",
    "every line carries the svc/build/level envelope");

  const b = await withLogs(() =>
    postSubmit({ signedDelegateAction: "!!not-base64!!" }, env, { "cf-connecting-ip": "198.51.100.202" }));
  ok(b.value.status === 400, "invalid base64 -> 400");
  ok(evs(b.lines).some((e) => e.event === "submit_rejected" && e.reason === "bad_base64"),
    "invalid base64 logs reason bad_base64");

  const c = await withLogs(() =>
    postSubmit({ signedDelegateAction: b64encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])) }, env,
      { "cf-connecting-ip": "198.51.100.203" }));
  ok(c.value.status === 400, "undecodable delegate -> 400");
  ok(evs(c.lines).some((e) => e.event === "submit_rejected" && e.reason === "invalid_delegate"),
    "garbage delegate logs reason invalid_delegate");
}

/* ── submit_ok: the full happy path logs safe identifiers only ──
   An in-process RPC mock (status, view_access_key x2, view_account,
   broadcast_tx_commit) lets a real fixture reach the broadcast, so the
   success record is what production would emit. Signing key generated
   fresh on this run — no secret lives in this file. */
{
  const kp = generateKeyPairSync("ed25519");
  const pkcs8 = kp.privateKey.export({ type: "pkcs8", format: "der" });
  const spki = kp.publicKey.export({ type: "spki", format: "der" });
  const secret = new Uint8Array(64);
  secret.set(pkcs8.subarray(pkcs8.length - 32), 0);
  secret.set(spki.subarray(spki.length - 32), 32);
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58e = (bytes) => {
    let n = 0n;
    for (const x of bytes) n = (n << 8n) | BigInt(x);
    let s = "";
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const x of bytes) { if (x === 0) s = "1" + s; else break; }
    return s || "1";
  };
  const secretB58 = b58e(secret);
  const BLOCK_HASH = "75xVe8oDH4VV9uKpcGsx7xTQFWtNsbngukNMC8qsqKTw";
  const TX_HASH = "5KvQmWnJ4dP8sR2tY6vB9xZ1cF7hL3aE5uG8iM4oN6q";

  const okEnv = {
    ...env,
    RELAYER_KEY: `ed25519:${secretB58}`,
    RELAYER_ACCOUNT: "paylink-relayer.testnet",
    RPC_URL: "https://rpc.mock.testnet",
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    let result = null;
    if (req.method === "status") {
      result = { latest_block_height: 200_000_000 };
    } else if (req.method === "broadcast_tx_commit") {
      result = { status: "SuccessValue", transaction: { hash: TX_HASH } };
    } else if (req.method === "query" && req.params.request_type === "view_access_key") {
      /* nonces are plain numbers, exactly as parsed JSON-RPC delivers them */
      result = req.params.account_id === "paylink-payee.testnet"
        ? { nonce: 0, block_hash: BLOCK_HASH }
        : { nonce: 50, block_hash: BLOCK_HASH };
    } else if (req.method === "query" && req.params.request_type === "view_account") {
      result = { amount: "10000000000000000000000000" }; // 10 NEAR > 1 NEAR floor
    }
    return { json: async () => ({ jsonrpc: "2.0", id: "1", result }) };
  };
  let res, lines;
  try {
    ({ value: res, lines } = await withLogs(() =>
      postSubmit({ signedDelegateAction: FIX_CLI }, okEnv, { "cf-connecting-ip": "198.51.100.204" })));
  } finally {
    globalThis.fetch = realFetch;
  }
  const out = await res.json();
  ok(res.status === 200 && out.ok === true && out.hash === TX_HASH,
    "happy path: a real fixture submits through the mocked chain");
  const [ev] = evs(lines).filter((e) => e.event === "submit_ok");
  ok(ev && ev.hash === TX_HASH && ev.link_id === "spikea01" && ev.sender_id === "paylink-payee.testnet",
    "submit_ok carries link id, sender and tx hash");
  ok(ev && ev.rid === res.headers.get("x-request-id") && typeof ev.ms === "number",
    "submit_ok is correlated (rid echo) and timed (ms)");
  ok(!lines.some((l) => l.includes(FIX_CLI)) && !lines.some((l) => l.includes("signedDelegateAction")),
    "no delegate bytes or body content in any line");
  ok(!lines.some((l) => l.includes(secretB58)), "no relayer key material in any line");
}

/* ── rate_limited: the limiter's 429 lands as a structured warn ── */
{
  const ip = "203.0.113.121";
  const seen = [];
  for (let i = 0; i < 11; i++) {
    const r = await capture(() => submit(env, {}, ip));
    seen.push(r.ok ? 200 : r.err.status);
  }
  ok(seen[10] === 429, "fresh IP capped at the 11th local-window request");
  const { lines, value: res } = await withLogs(() =>
    postSubmit({}, env, { "cf-connecting-ip": ip }));
  ok(res.status === 429, "handler repeats the 429");
  const [ev] = evs(lines).filter((e) => e.event === "rate_limited");
  ok(ev && ev.level === "warn" && ev.layer === "local" && ev.status === 429,
    "429 logs rate_limited/warn naming the layer that fired");
  ok(ev && ev.rid === res.headers.get("x-request-id") && ev.retry_after > 0,
    "rate_limited is correlated and carries retry_after");
}

/* ── volume_anomaly: alert once per 60 s window, at the threshold ── */
{
  let hits = [];
  let i = 0;
  for (; i < 150 && hits.length === 0; i++) {
    const { lines } = await withLogs(() =>
      postSubmit({}, env, { "cf-connecting-ip": `198.51.100.${(205 + i) % 255}` }));
    hits = evs(lines).filter((e) => e.event === "volume_anomaly");
  }
  ok(hits.length === 1, `unusual request volume fires volume_anomaly (after ${i} requests this window)`);
  ok(hits[0] && hits[0].level === "alert" && hits[0].window_s === 60 && hits[0].count >= 120,
    "volume_anomaly is an alert carrying the window and the count");
  const extra = await withLogs(() => Promise.all(
    Array.from({ length: 10 }, (_, k) =>
      postSubmit({}, env, { "cf-connecting-ip": `198.51.100.${100 + k}` }))));
  ok(evs(extra.lines).filter((e) => e.event === "volume_anomaly").length === 0,
    "the anomaly alerts once per window, not once per request");
}

/* ── error_burst: five 5xx in five minutes = one alert, delivered ──
   The RPC is stubbed dead (network disabled), so every request fails with
   503/rpc_access_key; ALERT_WEBHOOK_URL points at a local stub so the
   delivery path itself is under test. A fake ctx collects waitUntil
   promises exactly as the runtime would. */
{
  const burstEnv = { ...env, ALERT_WEBHOOK_URL: "https://hooks.test/paylink" };
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://hooks.test/")) {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    throw new Error("network disabled in test");
  };
  const pending = [];
  const ctx = { waitUntil: (p) => { if (p) pending.push(p); } };
  let lines = [];
  try {
    for (let i = 0; i < 5; i++) {
      const r = await withLogs(() =>
        worker.fetch(
          new Request("https://relayer.test/submit", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "cf-connecting-ip": `198.51.100.${220 + i}`,
            },
            body: JSON.stringify({ signedDelegateAction: FIX_CLI }),
          }),
          burstEnv,
          ctx,
        ));
      lines = lines.concat(r.lines);
    }
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  const es = evs(lines);
  ok(es.filter((e) => e.event === "service_error").length === 5,
    "each 5xx logs a service_error line");
  ok(es.some((e) => e.event === "service_error" && e.level === "error"
    && e.status === 503 && e.reason === "rpc_access_key"),
    "service_error carries level/status/reason");
  const bursts = es.filter((e) => e.event === "error_burst");
  ok(bursts.length === 1 && bursts[0].level === "alert" && bursts[0].count === 5,
    "the fifth 5xx in five minutes fires exactly one error_burst alert");
  ok(posts.length === 1 && posts[0].event === "error_burst" && posts[0].svc === "paylink-relayer",
    "the alert was POSTed to the configured webhook as the full record");
  ok(!posts.some((p) => JSON.stringify(p).includes("hooks.test")),
    "the webhook payload never echoes its own destination URL");
}

/* ── alert delivery plumbing: on / off / failure, URL never logged ── */
{
  const realFetch = globalThis.fetch;
  const posts = [];
  try {
    globalThis.fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    let d = null;
    let delivered = null;
    const { lines } = await withLogs(async () => {
      d = logEvent("plumb_test", { level: "alert", note: "hello" },
        { ALERT_WEBHOOK_URL: "https://hooks.test/secret-token" });
      delivered = await d;
    });
    ok(typeof (d && d.then) === "function", "logEvent(level=alert) returns the delivery promise");
    ok(delivered === true, "delivery resolves true when the webhook answers");
    ok(posts.length === 1 && posts[0].body.event === "plumb_test" && posts[0].body.level === "alert",
      "webhook receives the complete structured record");
    ok(!lines.some((l) => l.includes("secret-token")),
      "the webhook URL (and its embedded token) never reaches the log");

    posts.length = 0;
    const off = await withLogs(() => logEvent("plumb_off", { level: "alert" }, {}));
    ok(evs(off.lines).some((e) => e.event === "plumb_off" && e.level === "alert"),
      "without ALERT_WEBHOOK_URL the alert is still logged (log-only mode)");
    ok(off.value === false, "but no delivery is attempted (resolves false)");
    ok(posts.length === 0, "and no webhook POST happened");

    globalThis.fetch = async () => { throw new Error("webhook down"); };
    let threw = false;
    let dead = null;
    try {
      dead = await logEvent("plumb_dead", { level: "alert" }, { ALERT_WEBHOOK_URL: "https://hooks.test/down" });
    } catch {
      threw = true;
    }
    ok(!threw && dead === false, "a dead webhook resolves false instead of throwing");
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ── scrub backstop: key-shaped and oversized strings never survive ── */
{
  const ed = "ed25519:" + "A".repeat(64);
  const google = "AIza" + "Sy".repeat(20);
  const bearer = "Bearer abcdefghijklmnop";
  const { lines } = await withLogs(() =>
    logEvent("scrub_probe", { detail: `${ed} ${google} ${bearer} ${"x".repeat(400)}` }));
  const [rec] = evs(lines).filter((e) => e.event === "scrub_probe");
  ok(rec !== undefined, "probe line emitted");
  ok(rec && rec.detail.includes("ed25519:[redacted]") && !rec.detail.includes("A".repeat(40)),
    "ed25519 key material redacted");
  ok(rec && rec.detail.includes("[redacted-key]") && !rec.detail.includes(google),
    "Google API key redacted");
  ok(rec && rec.detail.includes("Bearer [redacted]") && !rec.detail.includes("abcdefghijklmnop"),
    "bearer token redacted");
  ok(rec && rec.detail.length <= 240,
    "strings capped at 240 chars — a full signed delegate cannot fit");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
