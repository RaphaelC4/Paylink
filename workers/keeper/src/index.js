/* Paylink claim keeper — a Cloudflare Worker that releases PAID links.
 *
 * The contract's `claim` is callable by anyone: the caller is never a payment
 * destination, and the payout always goes to the link's creator. So release
 * needs no signature from the payee or the payer — only gas. This Worker
 * provides that gas.
 *
 *   scheduled (every minute)  -> sweep(): scan contract state, claim every
 *                               link sitting in PAID, log what happened.
 *   POST /tick (x-tick-secret)-> the same sweep on demand, for demos/tests.
 *   GET /                     -> liveness + build stamp.
 *
 * Observability (M-01): every event is one structured JSON line
 * ({ts, svc, build, level, event, ...}) greppable in Workers → Logs or
 * `wrangler tail` — per-run sweep_summary and cron_heartbeat, per-claim
 * outcome events, unsettled_paid (warn), repeated_claim_failure and
 * sweep_outage (alert), sweep_failed / tick_failed (error). Every line of
 * one run shares a run_id (also returned by /tick), so a "did the 14:03 run
 * settle it?" question maps onto exactly one set of lines. Never logged:
 * key material (the logger scrubs ed25519/API-key/bearer shapes as a
 * backstop); everything else logged — link ids, tx hashes, account ids —
 * is public on chain. Missed cron runs are detected by the ABSENCE of a
 * cron_heartbeat line. Alert delivery optional: set ALERT_WEBHOOK_URL and
 * level=alert events are POSTed there (best-effort, never fatal). Event
 * catalog, thresholds and required config: workers/OPERATIONS.md.
 *
 * Discovery needs no registry: `view_state` with prefix "l" lists every
 * link the contract stores (LookupMap key = b"l" + borsh(link_id), value =
 * the borsh Link struct). One RPC call serves it while state fits in one
 * response. Status lives in the value, so every link must be read to find
 * the PAID ones — but the read never has to ARRIVE as one response: if the
 * whole-prefix read fails (timeout, oversized response), scanLinks falls
 * back to disjoint sub-prefixes (M-06), keeps whatever it could read,
 * claims those links anyway (fail-soft) and starts over from scratch next
 * minute — discovery is stateless, so a partial or crashed run loses
 * nothing.
 *
 * Secrets:  wrangler secret put KEEPER_KEY      (ed25519, matches KEEPER_ACCOUNT)
 *           wrangler secret put TICK_SECRET     (for POST /tick)
 *           wrangler secret put ALERT_WEBHOOK_URL (optional — where level=alert events go)
 * Vars:     RPC_URL, CONTRACT_ID, KEEPER_ACCOUNT, ALLOWED_ORIGIN
 *
 * No Node APIs and no dependencies: Workers get atob/btoa and Uint8Array,
 * not Buffer, and signing uses the runtime's own WebCrypto Ed25519 — so the
 * whole Worker is one file, deployable straight from the Cloudflare dashboard.
 */

const RPC_TIMEOUT_MS = 12_000;
/* broadcast_tx_commit blocks until the transaction has executed, not just
   accepted — it needs a longer budget than a view call. */
const BROADCAST_TIMEOUT_MS = 30_000;
const GAS_CLAIM = 150_000_000_000_000; // 150 Tgas — claim queues 2 transfers + a callback
const ONE_YOCTO = 1n; // claim requires exactly 1 yoctoNEAR
const MAX_CLAIMS_PER_SWEEP = 10; // bound one sweep's runtime and spend

/* M-06 scan bounds. Discovery must read every link (status is in the
   VALUE, not the key), but it never has to arrive as ONE response: when
   the single prefix="l" read fails after its retry, scanLinks falls back
   to querying disjoint sub-prefixes until coverage is complete. Both
   guards below bound that fallback — whichever trips first marks the
   untouched prefixes unvisited, and the run continues fail-soft with what
   it already read. Nothing is checkpointed: discovery is stateless, so
   the next minute's sweep starts over from scratch and re-covers any
   skipped region (that is what keeps a failed run from losing a PAID
   link). Tunable per environment for tests. */
const MAX_PAGE_QUERIES = 512; // fallback query ceiling per sweep
const SCAN_BUDGET_MS = 45_000; // leave the rest of the 60 s cron window for claims
const LINK_PREFIX = 0x6c; // b"l" — the contract's links LookupMap namespace
/* Mirror of the contract's create_link link_id bounds: keys are
   l || borsh(String) = l || u32-LE length || bytes, so a failed root read
   splits into these 61 length buckets. Verified against live testnet
   state: key bAgAAABkZW1vLTAwNA== = "l" || u32(8) || "demo-004". */
const LINK_ID_MIN_BYTES = 4;
const LINK_ID_MAX_BYTES = 64;
/* Deeper splits enumerate the next byte (0..255): every key under prefix p
   starts with p || c for exactly one byte c, so children are disjoint and
   their union is complete — coverage can only be lost, never doubled. */
const MAX_PREFIX_BYTES = 72; // 1 + 4 length + 64 id + slack; beyond, a failed page stays lost (recorded, alerted)
const SCAN_PARTIAL_ALERT = 3; // M-01 pattern: alert on the 3rd consecutive partial scan

/* M-01 alert thresholds (see workers/OPERATIONS.md): three failed claims in
   a row for one link, or three consecutive sweeps unable to scan at all,
   mean the trouble is systemic — one bad transaction never trips either. */
const CLAIM_STRIKE_ALERT = 3;
const SWEEP_OUTAGE_ALERT = 3;
const SVC = "paylink-keeper";
const BUILD = "20261110e";

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
    /* this RPC embeds query failures in result.error instead of top-level error */
    if (j.result && typeof j.result.error === "string") {
      throw new Error(`rpc ${method}: ${j.result.error.slice(0, 200)}`);
    }
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/* Views are retried once on a dropped connection. A broadcast never is: if
   the response is lost the transaction may still have landed, and the next
   sweep settles it either way (already CLAIMED = skipped; still PAID =
   re-claimed). */
async function rpc(env, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  try {
    return await rpcOnce(env, method, params, timeoutMs);
  } catch (err) {
    if (method === "query") return await rpcOnce(env, method, params, timeoutMs);
    throw err;
  }
}

/* ────────────────────────────────────────── base58 / base64 / borsh ── */

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

/* ───────────────────────────────────────────── contract state decode ── */

/**
 * Borsh-decode one `Link` as stored by the contract.
 * Field order mirrors lib.rs: link_id, creator, amount, token, description,
 * created_at, expires_at, status, paid_by, paid_amount, paid_at, claimed_at.
 * `Expired` is derived on read and never stored, so status is 0..2 in practice.
 */
export function decodeLink(v) {
  let o = 0;
  /* L-02: bounds-check every field first — a truncated or malformed
     record must throw deterministically (decodeEntries skips it) instead
     of decoding misaligned bytes as if they were a link. */
  const need = (n) => {
    if (o + n > v.length) throw new Error("truncated link record");
  };
  const takeStr = () => {
    need(4);
    const n = new DataView(v.buffer, v.byteOffset + o, 4).getUint32(0, true);
    o += 4;
    need(n);
    const s = utf8.decode(v.subarray(o, o + n));
    o += n;
    return s;
  };
  const takeU64 = () => {
    need(8);
    const x = new DataView(v.buffer, v.byteOffset + o, 8).getBigUint64(0, true);
    o += 8;
    return x;
  };
  const takeU128 = () => {
    /* L-02: borsh u128 = 16 bytes little-endian — LOW limb first (bytes
       0..8), HIGH limb second (bytes 8..16). Confirmed on live view_state
       bytes: the demo-004 amount sits at offset 37 as 25000000 with a
       zeroed high limb; same layout the relayer's ru128 reads. Reading
       only the low limb silently truncated anything >= 2^64 to its low
       64 bits. Both limbs, BigInt end to end — no Number, no precision
       loss. */
    need(16);
    const dv = new DataView(v.buffer, v.byteOffset + o, 16);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    o += 16;
    return lo + (hi << 64n);
  };
  const takeOpt = (fn) => {
    need(1);
    return v[o++] === 1 ? fn() : null;
  };

  const link_id = takeStr();
  const creator = takeStr();
  const amount = takeU128();
  const token = takeStr();
  const description = takeStr();
  const created_at = takeU64();
  const expires_at = takeOpt(takeU64);
  const statusByte = v[o++];
  /* L-03: the contract's Status enum is OPEN(0), PAID(1), CLAIMED(2),
     CANCELLED(3), EXPIRED(4). Byte 3 IS stored (cancel_link writes it);
     Expired is derived on read and never stored, so byte 4 can only come
     from a hand-made fixture — kept for layout fidelity, not for lookups. */
  const status = ["OPEN", "PAID", "CLAIMED", "CANCELLED", "EXPIRED"][statusByte] ?? `UNKNOWN_${statusByte}`;
  const paid_by = takeOpt(takeStr);
  const paid_amount = takeOpt(takeU128);
  const paid_at = takeOpt(takeU64);
  const claimed_at = takeOpt(takeU64);

  return {
    link_id,
    creator,
    amount: amount.toString(),
    token,
    description,
    created_at: created_at.toString(),
    expires_at: expires_at ? expires_at.toString() : null,
    status,
    paid_by,
    paid_amount: paid_amount ? paid_amount.toString() : null,
    paid_at: paid_at ? paid_at.toString() : null,
    claimed_at: claimed_at ? claimed_at.toString() : null,
  };
}

/* ────────────────────────────────── display: yoctoNEAR → NEAR (L-02) ── */

const YOCTO_PER_NEAR = 10n ** 24n; // 1 NEAR = 10^24 yocto
const U128_MAX = (1n << 128n) - 1n;

/**
 * Format a yoctoNEAR amount as a NEAR string, exactly (L-02).
 *
 * All arithmetic is BigInt: one NEAR is 10^24 yocto, far past Number's
 * 2^53 safe-integer range, so any Number path would silently round.
 * Canonical decimal strings are accepted (that is how the RPC serves
 * balances); plain numbers are rejected outright rather than converted,
 * so a caller can never introduce precision loss by passing one.
 *
 * The fractional part is padded to 24 places then trimmed:
 *   0 yocto        -> "0"
 *   1 yocto        -> "0.000000000000000000000001"
 *   10^24          -> "1"
 *   u128::MAX      -> "340282366920938.463463374607431768211455"
 * Anything outside 0..u128::MAX or malformed throws: a display helper
 * must never render a wrong number quietly.
 */
export function formatYoctoNEAR(value) {
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) n = BigInt(value);
  else throw new Error("formatYoctoNEAR: expected a bigint or a canonical decimal string (never a Number)");
  if (n < 0n || n > U128_MAX) throw new Error("formatYoctoNEAR: value outside 0..u128::MAX");
  const whole = n / YOCTO_PER_NEAR;
  const frac = n % YOCTO_PER_NEAR;
  if (frac === 0n) return String(whole);
  return `${whole}.${frac.toString().padStart(24, "0").replace(/0+$/, "")}`;
}

/* Entries as the node returns them; tolerates the documented dialects
   ({values:[{key,value}]} from nearcore/FastNEAR, or a keys/values zip). */
const entriesOf = (res) =>
  Array.isArray(res.values)
    ? res.values
    : (Array.isArray(res.keys) ? res.keys.map((key, i) => ({ key, value: res.values[i] })) : []);

const decodeEntries = (entries) => {
  const links = [];
  for (const e of entries) {
    try {
      links.push(decodeLink(b64decode(e.value)));
    } catch {
      /* an undecodable record is skipped, never fatal to the sweep */
    }
  }
  return links;
};

const b64fromBytes = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const viewState = (env, prefixBytes) => rpc(env, "query", {
  request_type: "view_state",
  finality: "final",
  account_id: env.CONTRACT_ID,
  prefix_base64: b64fromBytes(prefixBytes),
});

/* Children of a failed prefix: the root splits into the 61 link_id length
   buckets the contract can produce (layout above); any deeper prefix
   splits generically over the next byte. Both keep the walk disjoint. */
const splitRoot = () => {
  const out = [];
  for (let n = LINK_ID_MIN_BYTES; n <= LINK_ID_MAX_BYTES; n++) out.push([LINK_PREFIX, n]);
  return out;
};
const splitByte = (prefix) => {
  const out = [];
  for (let b = 0; b <= 0xff; b++) out.push([...prefix, b]);
  return out;
};
const intEnv = (v, dflt, min, max) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

/**
 * Every link in contract state, as `{links, blockHash, pages, partial,
 * failedPages}` (M-06).
 *
 * Fast path: one `view_state` with prefix "l" — exactly the pre-M-06
 * behavior, and still the only path taken while state fits in one
 * response. Fallback: when that read fails after its retry (timeout or a
 * response the node won't serve), the same coverage is fetched as
 * disjoint sub-prefix pages — root → length buckets → next-byte children
 * — each page retried by `rpc`, failures recorded, siblings still
 * fetched. Pages already read are kept (fail-soft): `partial:true` with
 * `failedPages` says the run saw less than all state, and the next sweep
 * starts over from scratch to re-cover it. Throws only when NOTHING was
 * readable — the pre-M-06 "scan failed" contract, so sweep_failed /
 * sweep_outage semantics are unchanged. No continuation tokens: neither
 * rpc.testnet.near.org nor test.rpc.fastnear.com serves view_state
 * pagination, so the partitioning is done client-side from returned keys.
 */
export async function scanLinks(env) {
  const maxQueries = intEnv(env.KEEPER_MAX_PAGE_QUERIES, MAX_PAGE_QUERIES, 1, 100_000);
  const budgetMs = intEnv(env.KEEPER_SCAN_BUDGET_MS, SCAN_BUDGET_MS, 0, 600_000);
  const t0 = Date.now();

  /* fast path — whole state in one response */
  let rootError;
  try {
    const res = await viewState(env, [LINK_PREFIX]);
    return {
      links: decodeEntries(entriesOf(res)),
      blockHash: res.block_hash,
      pages: 1,
      partial: false,
      failedPages: 0,
    };
  } catch (err) {
    rootError = err;
  }

  /* fallback — disjoint sub-prefix walk (root already burned 2 attempts;
     the queue starts at its children, never refetches what failed) */
  const queue = splitRoot();
  const seen = new Set();
  const entries = [];
  let pages = 0;
  let failed = 0;
  let blockHash = null;
  let lastErr = rootError;
  while (queue.length) {
    /* either guard exhausted: stop issuing queries, count the rest as
       unvisited, keep every page already read */
    if (pages + failed >= maxQueries || Date.now() - t0 >= budgetMs) {
      failed += queue.length;
      break;
    }
    const prefix = queue.shift();
    let res;
    try {
      res = await viewState(env, prefix);
    } catch (err) {
      lastErr = err;
      failed++;
      if (prefix.length === 1) queue.push(...splitRoot());
      else if (prefix.length < MAX_PREFIX_BYTES) queue.push(...splitByte(prefix));
      continue; // deeper than the ceiling: this page stays lost (partial)
    }
    pages++;
    if (blockHash === null) blockHash = res.block_hash;
    for (const e of entriesOf(res)) {
      if (e.key !== undefined) {
        if (seen.has(e.key)) continue; // pages are disjoint; belt-and-braces
        seen.add(e.key);
      }
      entries.push(e);
    }
  }
  if (pages === 0) throw lastErr ?? rootError;
  return { links: decodeEntries(entries), blockHash, pages, partial: failed > 0, failedPages: failed };
}

/* ──────────────────────────────────────────────────── tx signing ── */

export function parseSecretKey(env) {
  /* Tolerant on purpose: humans paste this from a JSON keychain file, so the
     value may arrive quoted or as the whole line. Pick the first ed25519:...
     substring that decodes to the 64 bytes of a secret key — a JSON blob holds
     the public key (32 bytes) before the private key, so length is the test,
     not position. */
  const raw = String(env.KEEPER_KEY || "");
  const candidates = raw.match(/ed25519:([1-9A-HJ-NP-Za-km-z]+)/g) || [];
  for (const c of candidates) {
    const bytes = b58decode(c.slice("ed25519:".length));
    if (bytes.length === 64) return bytes; // 32-byte seed || 32-byte public key
    /* anything else (a public key, a truncated paste) is not this secret */
  }
  if (!candidates.length) throw new Error("KEEPER_KEY must contain an ed25519:... secret key");
  throw new Error(`KEEPER_KEY has no ed25519 key that decodes to 64 bytes (saw ${candidates.map((c) => { try { return b58decode(c.slice(8)).length; } catch { return "unparseable"; } }).join(", ")}) — paste private_key, not public_key`);
}

/* RFC 8410 PKCS#8 header for an Ed25519 private key; the 32-byte seed follows.
   WebCrypto in both workerd and Node refuses raw private-key import, so pkcs8
   is the portable format — and the signatures come out bit-identical to the
   reference implementation (checked against tweetnacl on a fixed vector). */
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
 * Build and sign a FunctionCall transaction. Borsh layout matches
 * nearcore's Transaction struct: signer, public key (0x00 = ED25519),
 * nonce, receiver, block hash, then actions.
 */
export async function signTx({ secret, account, receiver, method, args, gas, deposit, nonce, blockHash }) {
  const publicKey = secret.subarray(32);
  const argsBytes = text.encode(args);
  const action = concat(
    [2], // Action::FunctionCall (nearcore action/mod.rs: CreateAccount=0, DeployContract=1, FunctionCall=2, ...)
    str(method),
    u32(argsBytes.length),
    argsBytes,
    u64(gas),
    u128(deposit),
  );
  const tx = concat(
    str(account),
    [0, ...publicKey],
    u64(nonce),
    str(receiver),
    b58decode(blockHash),
    u32(1), // one action
    action,
  );
  /* nearcore verifies the signature over sha256(borsh(tx)): SignedTransaction
     stores the digest, ValidatedTransaction checks signature.verify(hash). */
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

/* ─────────────────────────────────────────────────────────── sweep ── */

/* ─────────────────────────────── structured logging + alerts (M-01) ── */

/* One event = one JSON line, envelope first: ts, svc, build, level
   (info | warn | error | alert), event, then the detail. Catalog:
   per-run      sweep_summary, cron_heartbeat, unsettled_paid (warn),
                sweep_failed (error), sweep_outage (alert), tick_failed,
   per-claim    invoice_discovered, claim_submitted, claim_successful,
                claim_failed, invoice_already_claimed, retry_scheduled,
                repeated_claim_failure (alert).
   Only level=alert is webhook-eligible, so warnings never spam a channel. */

const newRunId = () => {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/* Belt-and-braces redaction applied to EVERY string that reaches a log line
   or an alert webhook: ed25519 key material, Google API keys, bearer tokens,
   and a 240-char cap so an error blob can never carry a whole secret or blow
   the log budget. Call-site discipline still applies — nothing here logs a
   request body or the key — this is the backstop. */
function scrub(v) {
  if (typeof v !== "string") return v;
  return v
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{32,}/g, "ed25519:[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{16,}/g, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .slice(0, 240);
}
const scrubDeep = (o) => {
  if (typeof o === "string") return scrub(o);
  if (Array.isArray(o)) return o.map(scrubDeep);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, val] of Object.entries(o)) out[k] = scrubDeep(val);
    return out;
  }
  return o;
};

/* Optional alert delivery: POST level=alert events to ALERT_WEBHOOK_URL.
   Off unless the secret is set; short timeout; failures swallowed (a dead
   webhook must never break a sweep); the URL itself is never logged — it
   may embed the destination's token. */
async function notifyAlert(env, payload) {
  const url = env && env.ALERT_WEBHOOK_URL;
  if (!url || typeof url !== "string") return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function logEvent(event, detail = {}, env) {
  const level = detail.level || "info";
  const record = scrubDeep({ ts: new Date().toISOString(), svc: SVC, build: BUILD, level, event, ...detail });
  console.log(JSON.stringify(record));
  if (level === "alert") return notifyAlert(env, record);
  return null;
}

/* Failure memory for the alert conditions (module = per isolate; a restart
   clears it, so streaks are per-isolate — documented in OPERATIONS.md):
   claimFails counts consecutive failed claims per link, sweepFails counts
   consecutive sweeps that could not even scan, partialFails counts
   consecutive sweeps that read only PART of state (M-06 fallback). */
const claimFails = new Map();
let sweepFails = 0;
let partialFails = 0;

/**
 * Claim every link sitting in PAID. Idempotent by construction: `claim`
 * panics unless the link is PAID, so a link released elsewhere between the
 * scan and the broadcast simply fails its own transaction and is reported.
 *
 * M-01: one run_id correlates every line it emits; each exit path reports
 * unsettled_paid (warn) then sweep_summary; a scan that cannot run logs
 * sweep_failed (+ sweep_outage alert on the third consecutive run) and
 * rethrows so /tick still 500s and the cron's heartbeat reads ok:false.
 * M-06: a scan that read only PART of state claims what it found, logs
 * scan_partial (warn) and re-covers the gap next minute; a third
 * consecutive partial run fires scan_degraded (alert).
 */
export async function sweep(env, run_id = newRunId()) {
  const t0 = Date.now();
  const report = { run_id, scanned: 0, paid: [], claimed: [], failed: [], alreadyClaimed: [] };
  /* Alert deliveries started during this run — awaited before it returns,
     so ctx.waitUntil (cron) or the /tick response can never cut them off. */
  const alerts = [];

  let links;
  let pages = 1;
  let partial = false;
  let failedPages = 0;
  try {
    ({ links, pages, partial, failedPages } = await scanLinks(env));
  } catch (err) {
    const msg = scrub(String(err.message || err).slice(0, 200));
    logEvent("sweep_failed", { level: "error", run_id, error: msg }, env);
    const consecutive = ++sweepFails;
    /* exactly at the threshold: the streak alerts once, not every minute */
    if (consecutive === SWEEP_OUTAGE_ALERT) {
      await logEvent("sweep_outage", { level: "alert", run_id, consecutive, error: msg }, env);
    }
    throw err;
  }
  sweepFails = 0; // this run scanned fine — the outage streak is over
  report.pages = pages;
  report.partial = partial;
  report.failedPages = failedPages;
  report.scanned = links.length;

  /* A partial scan (some pages unreadable, M-06) still settles everything
     it could see — the next sweep re-covers the rest from scratch. It
     warns every run and alerts only at the third in a row: one bad minute
     is normal, a persistent hole in discovery is not. */
  if (partial) {
    const consecutive = ++partialFails;
    logEvent("scan_partial", {
      level: "warn", run_id, pages, failed_pages: failedPages, scanned: report.scanned,
    }, env);
    if (consecutive === SCAN_PARTIAL_ALERT) {
      alerts.push(logEvent("scan_degraded", {
        level: "alert", run_id, consecutive, pages, failed_pages: failedPages,
      }, env));
    }
  } else {
    partialFails = 0; // full coverage — the partial streak is over
  }

  const paidAll = links.filter((l) => l.status === "PAID");
  const paid = paidAll.slice(0, MAX_CLAIMS_PER_SWEEP);
  report.paid = paid.map((l) => l.link_id);
  for (const l of paid) logEvent("invoice_discovered", { link_id: l.link_id, run_id }, env);
  /* Over the per-sweep cap: not forgotten — the next run picks it up. */
  for (const l of paidAll.slice(MAX_CLAIMS_PER_SWEEP)) {
    logEvent("retry_scheduled", { link_id: l.link_id, reason: "sweep cap — next run", run_id }, env);
  }

  /* Every healthy exit reports the same way: warn about links still sitting
     in PAID (failed claims, missing key, over-cap deferrals — one link
     settling next minute is normal, so warn, never alert; the COUNT is what
     a dashboard should graph), then the run's summary as the final line. */
  const done = () => {
    const released = new Set([
      ...report.claimed.map((e) => e.link_id),
      ...report.alreadyClaimed.map((e) => e.link_id),
    ]);
    const remaining = paidAll.filter((l) => !released.has(l.link_id));
    if (remaining.length) {
      logEvent("unsettled_paid", {
        level: "warn", run_id, count: remaining.length,
        link_ids: remaining.slice(0, 10).map((l) => l.link_id),
      }, env);
    }
    logEvent("sweep_summary", {
      run_id, scanned: report.scanned, paid: paidAll.length,
      claimed: report.claimed.length, failed: report.failed.length,
      already_claimed: report.alreadyClaimed.length,
      over_cap: Math.max(0, paidAll.length - paid.length),
      pages: report.pages, partial: report.partial,
      ms: Date.now() - t0,
    }, env);
    return Promise.all(alerts).then(() => report);
  };
  if (!paid.length) return done();
  if (!env.KEEPER_KEY || !env.KEEPER_ACCOUNT) {
    report.failed.push({ error: "KEEPER_KEY/KEEPER_ACCOUNT not set — nothing released" });
    logEvent("claim_failed", { run_id, error: "KEEPER_KEY/KEEPER_ACCOUNT not set — nothing released" }, env);
    logEvent("retry_scheduled", { run_id, reason: "missing key — every minute until set" }, env);
    return done();
  }

  const secret = parseSecretKey(env);
  const publicKeyB58 = `ed25519:${b58encode(secret.subarray(32))}`;

  /* Consecutive-failure streak per link: a success or already-claimed
     outcome clears it; the third failure in a row alerts once (reason
     attached so the channel says what to look at). */
  const settled = (link_id) => claimFails.delete(link_id);
  const strike = (link, detail) => {
    const n = (claimFails.get(link.link_id) || 0) + 1;
    claimFails.set(link.link_id, n);
    if (n === CLAIM_STRIKE_ALERT) {
      alerts.push(logEvent("repeated_claim_failure", {
        level: "alert", run_id, link_id: link.link_id, consecutive: n, ...detail,
      }, env));
    }
  };

  /* One access-key read per sweep, not per claim (M-06): broadcasts run
     sequentially and every executed transaction advances the nonce by
     exactly one, so the cursor walks on without re-reading. Any outcome
     that leaves the nonce UNKNOWN — a dropped connection, an InvalidNonce
     rejection — nulls the cursor so the next claim re-reads the chain
     instead of building on a guess. */
  let nonceCursor = null;
  let blockHash = null;

  for (const link of paid) {
    try {
      if (nonceCursor === null) {
        const ak = await accessKey(env, env.KEEPER_ACCOUNT, publicKeyB58);
        nonceCursor = ak.nonce;
        blockHash = ak.blockHash;
      }
      nonceCursor += 1;
      const tx = await signTx({
        secret,
        account: env.KEEPER_ACCOUNT,
        receiver: env.CONTRACT_ID,
        method: "claim",
        args: JSON.stringify({ link_id: link.link_id }),
        gas: GAS_CLAIM,
        deposit: ONE_YOCTO,
        nonce: nonceCursor,
        blockHash,
      });
      logEvent("claim_submitted", { link_id: link.link_id, run_id }, env);
      const res = await broadcast(env, tx);
      const entry = { link_id: link.link_id, hash: res.hash };
      if (res.ok) {
        logEvent("claim_successful", { ...entry, run_id }, env);
        report.claimed.push(entry);
        settled(link.link_id);
      } else if (JSON.stringify(res.status ?? "").includes("link is not paid")) {
        /* Released elsewhere between scan and broadcast — success by other
           hands, not a failure. The next sweep simply won't see it as PAID. */
        logEvent("invoice_already_claimed", { ...entry, run_id }, env);
        report.alreadyClaimed.push(entry);
        settled(link.link_id);
      } else {
        /* An InvalidNonce rejection means the transaction was NOT included
           — the cursor it was built on is off (an earlier broadcast's
           outcome was guessed wrong); re-read the chain before the next
           claim instead of failing every remaining claim in a row. */
        if (JSON.stringify(res.status ?? "").includes("InvalidNonce")) nonceCursor = null;
        logEvent("claim_failed", { ...entry, status: res.status, run_id }, env);
        report.failed.push({ ...entry, status: res.status });
        logEvent("retry_scheduled", { link_id: link.link_id, reason: "claim failed — next sweep", run_id }, env);
        strike(link, { reason: "claim reverted" });
      }
    } catch (err) {
      /* The transaction's fate is unknown (signing failed before send, or
         the connection dropped mid-broadcast): null the cursor so the
         next claim re-reads nonce + block hash from the chain. */
      nonceCursor = null;
      const msg = String(err.message || err).slice(0, 200);
      logEvent("claim_failed", { link_id: link.link_id, error: msg, run_id }, env);
      report.failed.push({ link_id: link.link_id, error: msg });
      logEvent("retry_scheduled", { link_id: link.link_id, reason: "broadcast error — next sweep", run_id }, env);
      strike(link, { reason: "broadcast error", error: msg });
    }
  }
  return done();
}

/* ────────────────────────────────────────────────────────── http ── */

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/* ── manual-trigger auth: constant-time secret comparison (L-05 hardening) ──
 *
 * `given !== env.TICK_SECRET` short-circuits at the first differing byte,
 * which is the textbook timing side-channel. This replaces it without
 * changing the policy: same header, same endpoint, same 403 boundary.
 *
 * Both sides are SHA-256'd to fixed 32-byte digests, then ALL digest bytes
 * are folded into one XOR accumulator — the loop always runs 32 iterations,
 * never exits early, and equal-length digests mean the configured secret's
 * length never branches the comparison. Hashing also means a longer or
 * shorter supplied value cannot be probed byte-by-byte.
 *
 * Fail closed everywhere: missing/empty supplied or configured secret
 * returns false before any hashing; no Web Crypto (or a digest that
 * throws) returns false — there is deliberately NO fallback to plain
 * string equality. Neither value nor any digest is ever logged. */
export async function secretMatches(given, expected, webcrypto = globalThis.crypto) {
  if (!expected || !given) return false;
  const subtle = webcrypto && webcrypto.subtle;
  if (!subtle || typeof subtle.digest !== "function") return false;
  try {
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      subtle.digest("SHA-256", enc.encode(String(given))),
      subtle.digest("SHA-256", enc.encode(String(expected))),
    ]);
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i]; // no early exit
    return diff === 0;
  } catch {
    return false; // fail closed, never fall back to !==
  }
}

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-tick-secret",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      /* Health signal for uptime checks: identity, build, per-isolate
         counters — aggregate numbers only, no run or user detail. */
      return json(
        { ok: true, service: "paylink-keeper", contract: env.CONTRACT_ID, account: env.KEEPER_ACCOUNT, build: BUILD },
        200,
        cors,
      );
    }

    if (request.method === "POST" && url.pathname === "/tick") {
      const given = request.headers.get("x-tick-secret") || "";
      if (!(await secretMatches(given, env.TICK_SECRET))) {
        return json({ error: "forbidden" }, 403, cors);
      }
      /* The tick's run_id is passed into the sweep, so the HTTP response and
         every log line it produced share one correlation id. Sweep already
         logs sweep_summary on success and sweep_failed on a scan failure —
         tick_failed covers the throws in between (e.g. a bad KEEPER_KEY). */
      const run_id = newRunId();
      try {
        const report = await sweep(env, run_id);
        return json(report, 200, cors);
      } catch (err) {
        logEvent("tick_failed", { level: "error", run_id, error: scrub(String(err.message || err).slice(0, 200)) }, env);
        return json({ error: String(err.message || err).slice(0, 300) }, 500, cors);
      }
    }

    return json({ error: "not found" }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    /* One cron_heartbeat per scheduled run, success or failure: missed runs
       are detected by its ABSENCE, failed ones by ok:false. waitUntil keeps
       the run (and its alert deliveries) alive past the response. */
    const run_id = newRunId();
    const t0 = Date.now();
    ctx.waitUntil(
      sweep(env, run_id)
        .then((r) => {
          logEvent("cron_heartbeat", { run_id, ok: true, claimed: r.claimed.length, failed: r.failed.length, ms: Date.now() - t0 }, env);
        })
        .catch((e) => {
          logEvent("cron_heartbeat", { level: "error", run_id, ok: false, ms: Date.now() - t0, error: scrub(String(e.message || e).slice(0, 200)) }, env);
        }),
    );
  },
};
