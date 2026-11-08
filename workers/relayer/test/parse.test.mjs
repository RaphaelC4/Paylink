/* Relayer parser/signing tests — run with: node workers/relayer/test/parse.test.mjs
 *
 * The two fixtures are REAL SignedDelegateActions that the chain accepted:
 *   FIX_CLI  — near-cli-rs construct-meta-transaction, created link spikea01
 *   FIX_MET  — Meteor Wallet signDelegateActions,        created link spikea02
 * If parse + signature verification both hold on fixtures from two different
 * signers, the preimage this Worker checks is the one the chain checks.
 */

import { parseSignedDelegate, signDelegateTx } from "../src/index.js";

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
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58decode = (s) => {
    let n = 0n;
    for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad b58"); n = n * 58n + BigInt(i); }
    const out = [];
    while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const c of s) { if (c === "1") out.unshift(0); else break; }
    return Uint8Array.from(out);
  };

  const secret = b58decode("2dA4rSFnCrJBGAX1PPZiKSqC6vHCv4PS6GG1kvcNQetYcSxG2mxsWRAqdkx7tJpXtrSRuaiiLcZds1wX6YBxwpXJ");
  ok(secret.length === 64, "relayer secret key decodes to 64 bytes");

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
