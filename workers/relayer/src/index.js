/* Paylink relayer — a Cloudflare Worker that submits meta-transactions (NEP-366)
 * so creating a payment link never costs the payee a drop of NEAR.
 *
 *   POST /submit  { "signedDelegateAction": "<base64>" }
 *        -> validate the SignedDelegateAction (borsh), then wrap it in a
 *           transaction signed by the relayer account and broadcast it.
 *   GET  /        -> liveness + counters.
 *
 * The payee signs the DelegateAction off-chain (a signature costs nothing).
 * This Worker pays the gas AND the 0.01 NEAR storage stake: on chain the inner
 * actions execute with `predecessor_account_id` = the payee, while the outer
 * transaction's signer (this account) funds everything. Measured on testnet:
 * the payee's balance does not move by one yocto; see workers/relayer/NOTES.md.
 *
 * Validation happens BEFORE any relayer funds are spent, because a delegate
 * that fails on chain still burns this account's gas:
 *   - the outer transaction's receiver must be the delegate's sender (rule 3
 *     of NEP-366's validation list, else the chain rejects with
 *     DelegateActionSenderDoesNotMatchTxReceiver),
 *   - receiver_id must be our contract, the single inner action must be
 *     `create_link` with 0.01-0.02 NEAR attached (MIN_STAKE..MAX_DEPOSIT)
 *     and sane arguments (the same rules the contract enforces, mirrored so
 *     bad input never reaches it),
 *   - the signature must verify under the sender's public key using NEP-461's
 *     preimage (sha256 of the NEP-366 discriminant ++ the delegate bytes) —
 *     proven against two fixtures the chain accepted, see test/parse.test.mjs,
 *   - the sender must exist and own the public key that signed, the delegate's
 *     nonce must beat that key's nonce, and max_block_height must still be
 *     ahead of the chain — each of these failing on chain costs us gas.
 * Abuse control, stated at its real strength: a per-IP sliding window
 * (RATE_LIMIT per RATE_WINDOW_MS) and a balance floor — below
 * BALANCE_FLOOR_NEAR the Worker refuses rather than spend its last NEAR.
 * Both guards are best-effort, not a hard bound: the per-IP count lives in
 * one isolate's memory, so a second instance allows the full RATE_LIMIT and
 * any restart clears the count, and ALLOWED_ORIGIN only constrains browsers —
 * a script ignores it entirely. The balance floor is therefore the real
 * limit on worst-case drain: an attacker with many free testnet accounts
 * could spend the relayer down to BALANCE_FLOOR_NEAR — several hundred
 * relayed links from a 10 NEAR balance — before it refuses anything. Testnet
 * NEAR only, so nothing of value is at stake; this is a demo guard, not a
 * security guarantee.
 *
 * Secrets:  wrangler secret put RELAYER_KEY     (ed25519, matches RELAYER_ACCOUNT)
 *           wrangler secret put TICK_SECRET     (unused; kept for symmetry)
 * Vars:     RPC_URL, CONTRACT_ID, TOKEN_ID, RELAYER_ACCOUNT, ALLOWED_ORIGIN
 *
 * No Node APIs and no dependencies: one file, deployable straight from the
 * Cloudflare dashboard — same shape as workers/keeper/src/index.js, which is
 * where the signing helpers come from.
 */

const RPC_TIMEOUT_MS = 12_000;
/* broadcast_tx_commit blocks until execution, like the keeper. */
const BROADCAST_TIMEOUT_MS = 30_000;
/* The transaction struct carries no gas field: prepaid gas is derived from
   the actions (nearcore Action::prepaid_gas), and for a Delegate it follows
   the inner actions — so the only gas this Worker sets is a sanity range on
   the inner create_link call it is willing to fund. */
const GAS_INNER_MIN = 10_000_000_000_000n; // 10 Tgas — below this the contract cannot run
const GAS_INNER_MAX = 100_000_000_000_000n; // 100 Tgas cap — nobody needs more for create_link
const MIN_STAKE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR, CREATE_STORAGE_STAKE
/* H-01: bound the deposit this Worker will fund, not just its floor. The
   contract accepts >= 0.01 NEAR with no ceiling, and create_link's excess
   deposit lands in the contract with no refund path — so above-minimum value
   in a delegated create can only ever lose THIS account money. Inspection:
   every legitimate sender attaches exactly MIN_STAKE (frontend CREATE_STAKE,
   both chain-accepted fixtures, every CLI proof run), and worst-case link
   storage plus first-time payee registration costs ~0.008 NEAR, already
   covered by the minimum. 0.02 NEAR = twice the current stake: a 100% margin
   that still tolerates a contract-side stake increase before this constant is
   re-synced, while capping one request at 0.02 NEAR instead of the balance
   floor. Sits below the rate limit and the 1 NEAR floor — it does not
   replace either. */
const MAX_DEPOSIT = 20_000_000_000_000_000_000_000n; // 0.02 NEAR, 2 x MIN_STAKE
const MAX_ARGS_BYTES = 1024; // create_link args are ~200 bytes; 1024 leaves room to grow
const LINK_ID_MIN = 4, LINK_ID_MAX = 64; // bytes, mirror lib.rs
const DESC_MAX = 280; // bytes, mirror lib.rs (Rust String::len is bytes)
/* Refuse to relay when the relayer's own balance drops below this: better to
   answer 503 than to burn the last NEAR on a link nobody can fund twice. */
const BALANCE_FLOOR_YOCTO = 1_000_000_000_000_000_000_000n; // 1 NEAR
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 10 submissions per IP per hour
/* A payee's expiry must be comfortably in the future: the contract compares
   against its own clock, so a stale delegate would fail on chain (gas burned). */
const EXPIRY_MARGIN_MS = 30_000;

/* ────────────────────────────────────────────────────────────── rpc ── */

async function rpcOnce(env, method, params, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
      signal: ctl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
    if (j.result && typeof j.result.error === "string") {
      throw new Error(`rpc ${method}: ${j.result.error.slice(0, 200)}`);
    }
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/* Views retry once on a dropped connection; a broadcast never does (same
   reasoning as the keeper: if the response is lost the tx may have landed). */
async function rpc(env, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  try {
    return await rpcOnce(env, method, params, timeoutMs);
  } catch (err) {
    if (method === "query") return await rpcOnce(env, method, params, timeoutMs);
    throw err;
  }
}

/* ───────────────────────────────────────────── base58 / base64 ── */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") out.unshift(0);
    else break;
  }
  return Uint8Array.from(out);
}

const b58encode = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s || "1";
};

const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const text = new TextEncoder();
const utf8 = new TextDecoder();
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const u128 = (n) => {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, BigInt(n) & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, BigInt(n) >> 64n, true);
  return b;
};
const str = (s) => {
  const t = text.encode(s);
  return [...u32(t.length), ...t];
};
const concat = (...parts) => {
  const arr = [];
  for (const p of parts) arr.push(...p);
  return Uint8Array.from(arr);
};

/* ──────────────────────────────────────── SignedDelegateAction parse ── */

/**
 * Borsh-read a SignedDelegateAction exactly as NEP-366 defines it and check
 * it is a single `create_link` call this relayer is willing to fund.
 * Returns the pieces the rest of the Worker needs, or throws with a message
 * fit for a 400 response. The raw bytes are returned too: the outer
 * transaction embeds them verbatim, so this Worker never re-encodes what the
 * payee signed.
 *
 * Layout (near-primitives):
 *   DelegateAction { sender_id: String, receiver_id: String,
 *                    actions: Vec<Action>, nonce: u64,
 *                    max_block_height: u64, public_key: PublicKey }
 *   SignedDelegateAction { delegate_action, signature: PublicKey-style
 *                          (0x00 || 64 bytes) }
 *   Action::FunctionCall = tag 2 { method_name, args: Vec<u8>, gas, deposit }
 */
export function parseSignedDelegate(raw, env) {
  let o = 0;
  const fail = (m) => { throw new Error(m); };
  const need = (n) => { if (o + n > raw.length) fail("truncated delegate action"); };
  const u8 = () => { need(1); return raw[o++]; };
  const ru32 = () => { need(4); const v = new DataView(raw.buffer, raw.byteOffset + o, 4).getUint32(0, true); o += 4; return v; };
  const ru64 = () => { need(8); const v = new DataView(raw.buffer, raw.byteOffset + o, 8).getBigUint64(0, true); o += 8; return v; };
  const ru128 = () => {
    need(16);
    const dv = new DataView(raw.buffer, raw.byteOffset + o, 16);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    o += 16;
    return lo + (hi << 64n);
  };
  const rstr = () => {
    const n = ru32();
    need(n);
    const s = utf8.decode(raw.subarray(o, o + n));
    o += n;
    return s;
  };
  const rbytes = (n) => { need(n); const b = raw.subarray(o, o + n); o += n; return b; };

  const sender_id = rstr();
  const receiver_id = rstr();

  const nActions = ru32();
  if (nActions !== 1) fail(`expected exactly one inner action, got ${nActions}`);
  const tag = u8();
  if (tag !== 2) fail(`only a FunctionCall inner action is relayable, got action tag ${tag}`);
  const method = rstr();
  if (method !== "create_link") fail(`this relayer only submits create_link, got "${method}"`);
  const argsLen = ru32();
  if (argsLen > MAX_ARGS_BYTES) fail(`create_link args too large (${argsLen} bytes)`);
  const argsBytes = rbytes(argsLen);
  const gas = ru64();
  const deposit = ru128();

  const nonce = ru64();
  const max_block_height = ru64();
  const pkTag = u8();
  if (pkTag !== 0) fail(`unsupported public key type ${pkTag}`);
  const publicKey = rbytes(32);
  const sigTag = u8();
  if (sigTag !== 0) fail(`unsupported signature type ${sigTag}`);
  const signature = rbytes(64);
  if (o !== raw.length) fail(`trailing bytes after SignedDelegateAction (${raw.length - o})`);

  /* Mirror the contract's own create_link checks so a doomed delegate is
     rejected here instead of on chain at this relayer's expense. */
  if (receiver_id !== env.CONTRACT_ID) fail(`receiver must be ${env.CONTRACT_ID}, got ${receiver_id}`);
  if (deposit < MIN_STAKE) fail(`create_link needs at least 0.01 NEAR attached, got ${deposit} yocto`);
  if (deposit > MAX_DEPOSIT) fail(`create_link deposit ${deposit} yocto exceeds the 0.02 NEAR maximum this relayer will fund`);
  if (gas < GAS_INNER_MIN || gas > GAS_INNER_MAX) fail(`inner gas ${gas} outside ${GAS_INNER_MIN}..${GAS_INNER_MAX}`);

  let args;
  try {
    args = JSON.parse(utf8.decode(argsBytes));
  } catch {
    fail("create_link args are not valid JSON");
  }
  const linkId = args.link_id;
  if (typeof linkId !== "string") fail("link_id must be a string");
  const linkBytes = text.encode(linkId).length;
  if (linkBytes < LINK_ID_MIN || linkBytes > LINK_ID_MAX) fail(`link_id must be ${LINK_ID_MIN}-${LINK_ID_MAX} bytes`);
  if (args.amount === undefined || args.amount === null) fail("amount is required");
  let amount;
  try {
    amount = BigInt(args.amount);
  } catch {
    fail("amount must be an integer");
  }
  if (amount <= 0n) fail("amount must be greater than zero");
  if (args.token !== env.TOKEN_ID) fail(`token must be ${env.TOKEN_ID}`);
  if (typeof args.description !== "string" || !args.description.trim()) fail("description must be 1-280 characters");
  if (text.encode(args.description).length > DESC_MAX) fail("description must be 1-280 characters");
  if (args.expires_at !== null && args.expires_at !== undefined) {
    const exp = Number(args.expires_at);
    if (!Number.isFinite(exp) || exp <= Date.now() + EXPIRY_MARGIN_MS) {
      fail("expires_at must be in the future");
    }
  }

  return {
    sender_id,
    receiver_id,
    method,
    args,
    gas,
    deposit,
    nonce,
    max_block_height,
    publicKey, // 32 raw bytes
    signature, // 64 raw bytes
    raw,
  };
}

/* ──────────────────────────────────────────────── signature verify ── */

/**
 * Verify the payee's signature over the delegate — NEP-461's preimage:
 *   sha256( borsh(u32 discriminant) ++ borsh(DelegateAction) )
 * where discriminant = 2^30 + 366 (on-chain NEP range + NEP-366's number),
 * per nearcore's SignedDelegateAction::verify / get_nep461_hash. Proven
 * against two fixtures the chain accepted (near-cli-rs and Meteor Wallet) —
 * see test/parse.test.mjs. Returns false rather than throwing so callers
 * can turn it into a clean 400.
 */
export async function verifyDelegate(parsed) {
  if (!globalThis.crypto?.subtle) return true; // no Ed25519 in runtime: chain still verifies
  const disc = new Uint8Array(4);
  new DataView(disc.buffer).setUint32(0, (1 << 30) + 366, true);
  const delegateAction = parsed.raw.subarray(0, parsed.raw.length - 65);
  const signature = parsed.raw.subarray(parsed.raw.length - 64);
  const preimage = concat(disc, delegateAction);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage));
    const key = await crypto.subtle.importKey("raw", parsed.publicKey,
      { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, digest);
  } catch {
    return false;
  }
}

/* ──────────────────────────────────────────────── tx signing ── */

export function parseSecretKey(env) {
  /* Tolerant, like the keeper's: humans paste a JSON keychain file, so take
     the first ed25519:... substring that decodes to 64 bytes. */
  const raw = String(env.RELAYER_KEY || "");
  const candidates = raw.match(/ed25519:([1-9A-HJ-NP-Za-km-z]+)/g) || [];
  for (const c of candidates) {
    const bytes = b58decode(c.slice("ed25519:".length));
    if (bytes.length === 64) return bytes; // 32-byte seed || 32-byte public key
  }
  if (!candidates.length) throw new Error("RELAYER_KEY must contain an ed25519:... secret key");
  throw new Error("RELAYER_KEY has no ed25519 key that decodes to 64 bytes");
}

/* RFC 8410 PKCS#8 header for an Ed25519 private key (see keeper). */
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

async function signEd25519(message, secret) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    concat(PKCS8_ED25519, secret.subarray(0, 32)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
}

/**
 * Build and sign the relayer's transaction. The single action is
 * Action::Delegate (tag 8) whose payload is the SignedDelegateAction bytes
 * verbatim; per NEP-366 the outer receiver_id must equal the delegate's
 * sender_id — the receipt is routed to the payee's account first, then on to
 * the contract with predecessor preserved.
 */
export async function signDelegateTx({ secret, account, senderId, delegateRaw, nonce, blockHash }) {
  const publicKey = secret.subarray(32);
  const action = concat([8], delegateRaw); // Action::Delegate(SignedDelegateAction)
  const tx = concat(
    str(account),
    [0, ...publicKey],
    u64(nonce),
    str(senderId), // receiver = delegate.sender_id, NOT the contract
    b58decode(blockHash),
    u32(1),
    action,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  const sig = await signEd25519(digest, secret);
  return b64encode(concat(tx, [0, ...sig])); // Signature::ED25519
}

async function accessKey(env, account, publicKeyB58) {
  /* this RPC wants the key WITHOUT the "ed25519:" prefix */
  const res = await rpc(env, "query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: account,
    public_key: publicKeyB58.replace(/^ed25519:/, ""),
  });
  return { nonce: res.nonce, blockHash: res.block_hash };
}

async function broadcast(env, txB64) {
  const res = await rpc(env, "broadcast_tx_commit", [txB64], BROADCAST_TIMEOUT_MS);
  const ok =
    res &&
    (typeof res.status === "string"
      ? res.status === "SuccessValue"
      : res.status && !res.status.Failure);
  return { ok, hash: res?.transaction?.hash ?? null, status: res?.status ?? null };
}

/* NEAR reports a reverted transaction as
   { ActionError: { index, kind: { FunctionCallError: { ExecutionError } } } } —
   same extraction the frontend and keeper use, so a rejection reads as the
   contract's own message rather than "transaction failed". */
function failureReason(f) {
  if (typeof f === "string") return f;
  const kind = f?.ActionError?.kind || f?.ReceiptFailure?.ActionError?.kind;
  const fc = kind?.FunctionCallError;
  const reason = fc?.ExecutionError || fc?.MethodResolveError;
  if (reason) return String(reason).replace(/^Smart contract panicked:\s*/, "");
  try { return JSON.stringify(f); } catch { return "transaction failed"; }
}

/* ───────────────────────────────────────────────── rate limit ── */

/* Sliding window kept per isolate (Maps die with it). Two isolates each allow
   the full RATE_LIMIT — acceptable: the balance floor is the hard stop. */
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  let list = hits.get(ip) || [];
  list = list.filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear(); // bound memory; a flood restarts the window
  return false;
}

/* ─────────────────────────────────────────────────── submit ── */

export async function submit(env, body, ip) {
  if (rateLimited(ip)) {
    const err = new Error("rate limit: try again later");
    err.status = 429;
    throw err;
  }

  const b64 = body && typeof body.signedDelegateAction === "string" ? body.signedDelegateAction : "";
  if (!b64) {
    const err = new Error('body must be { "signedDelegateAction": "<base64>" }');
    err.status = 400;
    throw err;
  }

  let raw;
  try {
    raw = b64decode(b64);
  } catch {
    const err = new Error("signedDelegateAction is not valid base64");
    err.status = 400;
    throw err;
  }

  let parsed;
  try {
    parsed = parseSignedDelegate(raw, env);
  } catch (e) {
    const err = new Error(String(e.message || e));
    err.status = 400;
    throw err;
  }

  /* The signature must actually verify under the sender's public key — a
     forged delegate would fail on chain at this relayer's gas expense. */
  if (!(await verifyDelegate(parsed))) {
    const err = new Error("signature does not verify under the sender's public key");
    err.status = 400;
    throw err;
  }

  const senderKeyB58 = `ed25519:${b58encode(parsed.publicKey)}`;

  /* 1. The payee's key must exist on the payee's account with a nonce the
        delegate beats — otherwise the chain rejects and we pay for it.
        Only a genuine "key does not exist" is a 400 (bad input); a dropped
        or rate-limited RPC is a 503 so the client retries instead of
        blaming the signature. */
  let senderKey;
  try {
    senderKey = await accessKey(env, parsed.sender_id, senderKeyB58);
  } catch (e) {
    const known = String(e.message || e).includes("does not exist while viewing");
    const err = known
      ? new Error(`${parsed.sender_id} does not own ${senderKeyB58}`)
      : new Error("could not verify the sender's access key — try again");
    err.status = known ? 400 : 503;
    throw err;
  }
  if (parsed.nonce <= BigInt(senderKey.nonce)) {
    const err = new Error(`delegate nonce ${parsed.nonce} must exceed key nonce ${senderKey.nonce}`);
    err.status = 400;
    throw err;
  }

  /* 2. The delegate must not already be expired against the current height. */
  const status = await rpc(env, "status", []);
  const height = status.latest_block_height ?? status.sync_info?.latest_block_height ?? 0;
  if (BigInt(height) >= parsed.max_block_height) {
    const err = new Error("delegate action has expired (max_block_height behind chain)");
    err.status = 400;
    throw err;
  }

  /* 3. Never spend the relayer's last NEAR. */
  const acct = await rpc(env, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: env.RELAYER_ACCOUNT,
  });
  if (BigInt(acct.amount) < BALANCE_FLOOR_YOCTO) {
    const err = new Error("relayer balance too low — fund the relayer account");
    err.status = 503;
    throw err;
  }

  /* 4. Wrap, sign as the relayer, broadcast. */
  if (!env.RELAYER_KEY) {
    const err = new Error("RELAYER_KEY is not set");
    err.status = 500;
    throw err;
  }
  const secret = parseSecretKey(env);
  const relayerKeyB58 = `ed25519:${b58encode(secret.subarray(32))}`;
  let relayerKey;
  try {
    relayerKey = await accessKey(env, env.RELAYER_ACCOUNT, relayerKeyB58);
  } catch {
    const err = new Error("could not reach the relayer's access key — try again");
    err.status = 503;
    throw err;
  }
  const txB64 = await signDelegateTx({
    secret,
    account: env.RELAYER_ACCOUNT,
    senderId: parsed.sender_id,
    delegateRaw: parsed.raw,
    nonce: relayerKey.nonce + 1,
    blockHash: relayerKey.blockHash,
  });

  const res = await broadcast(env, txB64);
  if (!res.ok) {
    const err = new Error(failureReason(res.status) || "broadcast failed");
    err.status = 502;
    throw err;
  }
  return { ok: true, hash: res.hash };
}

/* ────────────────────────────────────────────────── http ── */

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

/* Build stamp returned by GET / — bump this string on every dashboard paste
   so the deployed code can be identified remotely (the Worker exposes no
   other version signal). Same convention as the frontend's ?v= param. */
const BUILD = "20261110a";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json(
        { ok: true, service: "paylink-relayer", contract: env.CONTRACT_ID, account: env.RELAYER_ACCOUNT, build: BUILD },
        200,
        cors,
      );
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400, cors);
      }
      try {
        const out = await submit(env, body, ip);
        return json(out, 200, cors);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.log("submit error", String(err.message || err));
        return json({ error: String(err.message || err).slice(0, 300) }, status, cors);
      }
    }

    return json({ error: "not found" }, 404, cors);
  },
};
