/* Paylink × Tidepool Worker — dynamic discovery (GET /networks) and
 * server-side quote creation with payment-intent records (POST /quote).
 *
 * ── GET /networks ──
 * Answers one question for the pay page: which networks and tokens can a
 * payer use through Tidepool right now? Everything is read live from
 * Tidepool's public testnet API — no token list, network count or
 * network/token combination is hardcoded in this repository.
 *
 *   GET /networks
 *   -> { "networks": [ { "blockchain": "base", "name": "Base Sepolia",
 *        "availability": "bridge-ok",
 *        "tokens": [ { "assetId": "nep141:base-0x38d8…", "symbol": "USDC",
 *          "decimals": 6, "contractAddress": "0x38d8…" } ] } ],
 *        "count": { "networks": 11, "tokens": 29 },
 *        "fetchedAt": "2026-11-11T…Z", "cached": false, "cacheSeconds": 60 }
 *
 * Discovery only — this response can never authorize a payment. It carries
 * no deposit address, no quote and no signature; POST /quote re-validates
 * any selected asset against a FRESH /v0/tokens fetch before it creates a
 * quote, so a stale entry in the cache below can never produce invalid
 * deposit instructions.
 *
 * Sources: GET /v0/tokens (essential — failure, timeout or a malformed
 * body answers 502/504, never an empty list, so an outage is never
 * mistaken for "no tokens supported") and GET /v0/health (optional — chain
 * availability; when it fails every chain reports "unverified" rather than
 * guessing). availability values: "native" (NEAR, health's rpc+verifier
 * checks both ok), "bridge-ok" / "bridge-down" (health.bridges.chains
 * entry with ok true/false), "unsupported" (health enumerates its bridges
 * and this chain is not among them), "unverified" (health unavailable or
 * unreadable — fail closed). Availability is a property of the chain, so
 * it is returned once per network; tokens inherit it by grouping. Per-token
 * liquidity is not claimed here — a quote in Phase 3 is the authority.
 *
 * ── POST /quote ── (Phase 3)
 *
 *   POST /quote
 *   body: { "linkId": "lnk-…",          // 4-64 chars, the contract's bounds
 *           "blockchain": "near",       // network the payer picked
 *           "assetId": "nep141:wnear…", // source token, validated FRESH
 *           "refundTo": "payer.testnet",// refund address on the source chain
 *           "idempotencyKey": "…" }     // optional, 1-128 chars
 *   -> 201 { intentId, linkId, reused:false, status:"AWAITING_DEPOSIT",
 *            onChainStatus:"OPEN", depositAddress, depositMemo,
 *            source:{assetId,blockchain,symbol,decimals},
 *            destination:{assetId,blockchain,symbol,decimals},
 *            merchant, invoiceAmount, expectedInputAmount,
 *            minInputAmount, expectedOutputAmount, quoteDeadline,
 *            correlationId, tidepoolStatus, createdAt, updatedAt }
 *   -> 200 same shape with reused:true — the original intent's instructions.
 *
 * Authority rules this endpoint is built around (Phase 3 spec):
 *   - The CONTRACT is the only source of merchant, amount, token and
 *     status. Nothing the frontend sends is believed about the invoice;
 *     the payload from get_link is re-validated on the worker AND inside
 *     the Durable Object.
 *   - Eligibility = effective status OPEN (get_link derives EXPIRED on
 *     read), not expiring within 60 s, and the invoice token being the
 *     destination USDC itself — identity of the token is what proves the
 *     decimals of the invoice amount (never assumed, never taken from the
 *     source token, which can be any chain's asset).
 *   - A FRESH GET /v0/tokens answers whether the selected assetId and its
 *     network exist. The cached /networks discovery is never consulted
 *     for authorization.
 *   - The quote is EXACT_OUTPUT with amount = the invoice amount in base
 *     units, recipient = link.creator, destinationAsset = the approved
 *     USDC. The response must come back with amountOut === invoiceAmount
 *     (hard BigInt string check), a live deadline and deposit
 *     instructions, and a signature that verifies under Tidepool's maker
 *     key (Ed25519 over json-stable-stringify + SHA-256 + Base58 — the
 *     1Click scheme, proven against real Tidepool signatures). The echoed
 *     quoteRequest must equal what we sent (replay guard). All amount
 *     math is BigInt/integer-string only.
 *   - One active payment intent per invoice is enforced by the
 *     INTENT_DO Durable Object (class PaymentIntent), one instance per
 *     invoice id: the intent is persisted as CREATING BEFORE the upstream
 *     call, so an ambiguous outcome (timeout, transport failure, 5xx,
 *     unreadable 200) transitions to RECONCILE + a cooldown and can never
 *     silently produce a second deposit address. Only EXPIRED/REFUNDED/
 *     FAILED intents permit a new one; VERIFIED and SETTLED never do.
 *   - Internal status (QUOTE_ISSUED, AWAITING_DEPOSIT, DEPOSIT_SEEN,
 *     SETTLING, RECONCILE, VERIFIED, REFUNDED, FAILED, EXPIRED, UNKNOWN
 *     + CREATING/SETTLED) is stored separately from onChainStatus and
 *     from tidepoolStatus. Tidepool SUCCESS is SETTLED, never VERIFIED.
 *     Full transition table: TRANSITIONS below; VERIFIED has no exits.
 *
 * ── GET /status ── (Phase 4: deposit tracking + reconciliation)
 *
 *   GET /status?id=<intentId>&linkId=<linkId>
 *   -> 200 { ok:true, intent:{intentId, linkId, status, tidepoolStatus,
 *            quoteDeadline, lastReason, createdAt, updatedAt},
 *            onChainStatus, onChainStatusCheckedAt, conflict, changed }
 *   -> 503 { error, code: reconcile_cooldown | status_unknown |
 *            record_invalid, retryAfterSec }   while backing off /
 *           status unrecognised / the persisted record is unreadable
 *           (record_invalid: Phase 6, needs operator reconciliation —
 *           it never self-heals into a state change)
 *   -> 404 { code: intent_not_found } / 400 invalid_intent_id |
 *           invalid_link_id
 *
 * Authority: the browser never supplies a deposit address or any
 * upstream fact — the stored record's own deposit address is the only
 * address ever queried. The capability to read a payment is possession
 * of the intentId (pi_ + 64 random bits, returned only to whoever
 * requested the quote); linkId merely routes to the right Durable Object
 * and must match the record that owns that intent, so an id from another
 * invoice is a 404. Any extra query parameter (e.g. depositAddress=…)
 * is ignored, never believed.
 *
 * Response minimisation: no deposit address, no depositMemo, no
 * signature, no correlation id, no swapDetails / tx hashes, no history,
 * no raw upstream body. tidepoolStatus is returned only when it is one
 * of the seven documented Tidepool values. conflict is null or
 * "invoice_paid" (see below).
 *
 * Polling (Tidepool documents no webhooks): one GET performs at most ONE
 * contract read + ONE /v0/status read, serialized per invoice by the DO
 * input gates, and only when (a) the intent is not terminal (docs: stop
 * on SUCCESS / REFUNDED / FAILED; EXPIRED and VERIFIED are ours), (b) no
 * reconcile cooldown is active (failures back off via the persisted
 * reconcileUntil; a 429 also honours the upstream Retry-After), (c)
 * TIDEPOOL_STATUS_MIN_INTERVAL_MS has elapsed since the last cycle
 * (docs: poll every 2–5 s after a deposit; default 2000 ms), and (d) we
 * are inside 24 h past the quote deadline (docs: Tidepool stops watching
 * an address 24 h after the deadline — we stop asking at the same
 * point). There is no background loop anywhere: the client drives, this
 * Worker bounds. Terminal, cooling-down, throttled and halted requests
 * are answered from the record with zero upstream calls, and duplicate /
 * concurrent requests can never double-read or double-transition (DO
 * queue + the from===to refusal in the transition table).
 *
 * Cross-provider race (Phase 4 §5): every non-terminal cycle re-reads
 * the authoritative contract. OPEN -> PAID/CLAIMED while an intent is in
 * flight is recorded as record.conflict {kind:"invoice_paid", …}, logged
 * once as invoice_conflict (level error), and returned as conflict on
 * every subsequent response — while polling CONTINUES, because only
 * observing the Tidepool leg tells us whether the merchant was actually
 * paid twice. Nothing in this Worker can stop that leg (quote-based
 * swaps have no cancel API — probed live; only the deadline refund
 * exists), so the policy is detect + surface + keep observing, and
 * SETTLED still means "awaiting Phase 5 verification", conflict or not.
 *
 * ── Phase 6: payment records and reconciliation hardening ──
 *
 * The persisted record is validated BEFORE it is served or acted on
 * (recordLevelProblem / intentRecordProblem — type/shape-level checks
 * that accept every record Phases 2–5 can produce, refuse anything
 * unreadable, and never rewrite a fact):
 *   - a persisted status outside the state machine is force-quarantined
 *     to RECONCILE (history + intent_transition reason record_malformed,
 *     cooldown persisted) and answered 503 record_invalid. The transition
 *     table is bypassed ONLY here — it has no edge FROM an unreadable
 *     state, and inventing one would be a silent repair. From RECONCILE
 *     the normal reconcile path resolves against upstream truth.
 *   - a recognized state with a corrupt field (deposit address/memo,
 *     deadline, amounts, source/destination, merchant, correlation id,
 *     lastReason) HOLDS in place: 503 record_invalid plus a persisted
 *     record.invalid stamp, logged once per distinct reason — never
 *     served, never acted on, never silently repaired.
 *   - record-level corruption (history, conflict) stamps + logs without
 *     changing state. A malformed conflict still BLOCKS verification —
 *     verifyPayout holds on ANY truthy conflict — so an unreadable
 *     conflict is never read as "no conflict", and no missing conflict
 *     record is ever proof that none occurred.
 *   - on POST /quote an active-intent pointer that cannot be resolved
 *     never reads as "no active intent" (503 record_invalid instead of
 *     a second deposit address over an uncertain payment).
 * A detected invoice_paid conflict is PERSISTED immediately, before the
 * status cycle continues (persist-before-complete); a held candidate-less
 * SETTLED keeps watching the invoice through a bounded contract-only
 * refresh (at most once per HOLD_CONTRACT_REFRESH_MS, never a Tidepool
 * re-read — docs: stop on SUCCESS); reconcile() honours an upstream
 * Retry-After on top of its own cooldown, as the status path already
 * did; audit history is capped at MAX_HISTORY (256) so a full invoice
 * lifecycle keeps its oldest entries. record_invalid answers are NOT
 * self-healing: they mark records for operator inspection (OPERATIONS.md
 * — "record integrity").
 *
 * Admission control: OPTIONS -> 204; a path other than /networks, /quote
 * or /status -> 404; /networks or /status with a non-GET method -> 405
 * + Allow: GET; /quote with a non-POST method -> 405 + Allow: POST; a
 * present Origin must match ALLOWED_ORIGIN (403; "*" disables the gate
 * for local testing; no Origin passes so curl/README examples keep
 * working). Responses carry Cache-Control: no-store so freshness is
 * governed only by the server-side cache below and by each request's
 * own validation.
 *
 * Cache (per isolate, in memory): a successful non-empty discovery is
 * served for TIDEPOOL_CACHE_MS (default 60 s, hard cap 10 min, 0
 * disables). Empty results and upstream errors are never cached, so
 * recovery is immediate. The cache both bounds upstream load — which is
 * why this Worker needs no rate limiter — and holds only the curated
 * fields above, never a raw upstream body. POST /quote never reads it.
 *
 * Observability (M-01): one structured JSON line per event ({ts, svc,
 * build, level, event, ...}) — networks_ok, networks_rejected (reason
 * codes), quote_ok, quote_rejected (machine reason codes),
 * quote_deposit_mode_retry, quote_upstream_error (bounded, scrubbed
 * upstream detail), intent_transition (state machine audit),
 * status_ok (only when a poll actually changed something — routine
 * polls are silent so a 2 s poll can never burn the log budget),
 * status_rejected (400/404; cooldown 503s are silent because the
 * originating failure is already logged), status_upstream_error
 * (contract / status read failures), invoice_conflict (contract
 * PAID/CLAIMED while a Tidepool intent is in flight), record_invalid
 * (Phase 6: a malformed persisted record — logged ONCE per distinct
 * reason, reason codes only), upstream_error, service_error. GET
 * /networks, POST /quote and GET /status responses
 * carry X-Request-Id; the OPTIONS/405/404 responses stay untouched, so
 * the 405 + Allow: GET line remains the deploy signal. Never logged or
 * returned: a raw upstream body, token prices, stack traces, quote
 * signatures, deposit addresses.
 *
 * Secrets:  none — the Tidepool API is keyless. TIDEPOOL_X_API_KEY is a
 *           non-secret fee-tier selector (any value is accepted; it only
 *           picks the keyed tier), deliberately NOT a wrangler secret.
 *           TIDEPOOL_MAKER_KEY is a public verification key.
 * Vars:     ALLOWED_ORIGIN (default *), TIDEPOOL_ORIGIN (default
 *           https://www.usetidepool.tech), TIDEPOOL_TIMEOUT_MS (default
 *           5000 — one budget per upstream leg: discovery, tokens, quote,
 *           status, NEAR RPC), TIDEPOOL_CACHE_MS (default 60000),
 *           CONTRACT_ID (default paylink-v2.testnet), RPC_URL /
 *           RPC_URLS (NEAR read endpoints, keeper-style failover),
 *           TIDEPOOL_X_API_KEY (default paylink-testnet), TIDEPOOL_MAKER_KEY
 *           (default Tidepool's published maker public key),
 *           TIDEPOOL_QUOTE_WINDOW_MS (quote deadline window, default
 *           3600000, bounds 60000..86400000), TIDEPOOL_AMBIGUOUS_COOLDOWN_MS
 *           (reconcile cooldown after ambiguous creation, default 60000,
 *           bounds 0..3600000), TIDEPOOL_STATUS_MIN_INTERVAL_MS
 *           (GET /status poll floor, default 2000 — Tidepool documents
 *           2–5 s after a deposit; bounds 1000..60000).
 * Binding:  INTENT_DO — Durable Object (class PaymentIntent): the
 *           payment-intent record, one instance per invoice id. The
 *           Phase 6 KV assessment: payment records need per-invoice
 *           serialization and transactional reads-writes — that IS the
 *           Durable Object; a second store (TIDEPOOL_KV) would only
 *           duplicate state without improving recovery. TIDEPOOL_KV
 *           therefore stays declared but UNUSED (the placeholder id
 *           still blocks any deploy until an approved phase needs it).
 */

const SVC = "paylink-tidepool";
const BUILD = "20261111a";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MS = 60_000;
/* The cache stays "short, controlled": anything above 10 minutes falls
   back to the 60-second default rather than being honoured. */
const MAX_CACHE_MS = 600_000;

/* Sanity bounds on upstream strings — guards against an absurd payload,
   not claims about Tidepool's schema. */
const MAX_ASSET_ID = 200;
const MAX_SYMBOL = 32;
const MAX_CHAIN = 32;
const MAX_NAME = 64;
const MAX_CONTRACT = 128;
const MAX_DECIMALS = 77;

const DEFAULT_TIDEPOOL_ORIGIN = "https://www.usetidepool.tech";

/* ─────────────────────────── structured logging (M-01) ── */

/* Correlation id for one request: 8 hex chars, no user data in it. */
const newRid = () => {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/* Redaction backstop on every string that reaches a log line: key-shaped
   tokens are masked and every string is capped at 240 characters, so an
   upstream error body can never be echoed whole. This Worker holds no
   secret of its own, so there is no by-value redaction. */
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

/* One event = one JSON line. Exported for test/networks.test.mjs. */
export function logEvent(event, detail = {}) {
  const level = detail.level || "info";
  console.log(JSON.stringify(scrubDeep({ ts: new Date().toISOString(), svc: SVC, build: BUILD, level, event, ...detail })));
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      /* Unexpected exception: one structured line + a generic 500. Any
         stack stays in Workers Logs; the client never sees it. */
      try {
        logEvent("service_error", {
          level: "error",
          method: request && request.method,
          error: scrub(String((err && err.message) || err)),
        });
      } catch { /* logging must never mask the original failure */ }
      return json({ error: "internal error" }, 500, corsHeaders(env));
    }
  },
};

async function handle(request, env) {
  const cors = corsHeaders(env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  /* Route first, then method: an unknown path is 404 whatever the verb,
     a known path with the wrong verb is 405 + Allow naming the ONE verb
     that path accepts. The OPTIONS/404/405 answers stay byte-stable
     (they are the deploy signal and the Phase 2 contract) and carry no
     correlation id. */
  const path = new URL(request.url).pathname;
  if (path !== "/networks" && path !== "/quote" && path !== "/status") {
    return json({ error: "not found" }, 404, cors);
  }
  const want = path === "/quote" ? "POST" : "GET";
  if (request.method !== want) {
    return json({ error: `${want} only` }, 405, { ...cors, Allow: want });
  }

  /* Correlation id: born after the OPTIONS/404/405 checks so those three
     responses stay byte-identical to the deploy-signal contract; every
     other response in this request carries it, and every log line it
     produces is stamped with it. */
  const rid = newRid();
  const rh = { ...cors, "X-Request-Id": rid };
  const t0 = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  /* Origin — browsers always attach Origin to this cross-origin request,
     so the hosted frontend is gated; curl and the README examples send
     none and pass. A "*" configuration disables the gate on purpose. */
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin");
  if (allowedOrigin !== "*" && origin && origin !== allowedOrigin) {
    logEvent(path === "/networks" ? "networks_rejected" : path === "/status" ? "status_rejected" : "quote_rejected", {
      rid, ip, status: 403, reason: "origin_not_allowed",
      ...(path !== "/networks" ? { code: "origin_not_allowed" } : {}),
    });
    return json({ error: "Origin not allowed" }, 403, rh);
  }

  if (path === "/quote") return quote(request, env, { rid, rh, ip, t0 });
  if (path === "/status") return statusRequest(request, env, { rid, rh, ip, t0 });
  return discovery(env, { rid, rh, ip, t0 });
}

/* ── GET /networks ─────────────────────────────────────────────────────
   Discovery: one budget for the WHOLE upstream exchange (tokens + health),
   one cache, one curation step. Extracted verbatim from the Phase 2
   handler; its behaviour (including every log line and header) is
   unchanged. */
async function discovery(env, ctx) {
  const { rid, rh, ip, t0 } = ctx;

  /* Cache hit — curated payload only, served with the current TTL so a
     config change is visible immediately. ttl === 0 disables the cache
     outright, even if an entry from an earlier configuration lingers. */
  const ttl = discoveryTtlMs(env);
  if (ttl > 0 && cache && Date.now() < cache.expiresAt) {
    logEvent("networks_ok", {
      rid, ip,
      chains: cache.body.count.networks,
      tokens: cache.body.count.tokens,
      dropped: 0,
      cached: true,
      ms: Date.now() - t0,
    });
    return json({ ...cache.body, cached: true, cacheSeconds: Math.round(ttl / 1000) }, 200, rh);
  }

  /* ── upstream: one budget for the WHOLE exchange (tokens + health),
        one AbortController, one clearTimeout in the finally below — a
        crawling Tidepool cannot pin the request open. ─────────────────── */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tidepoolTimeoutMs(env));
  try {
    const base = String(env.TIDEPOOL_ORIGIN || DEFAULT_TIDEPOOL_ORIGIN).replace(/\/+$/, "");

    /* 1. /v0/tokens — essential. Every failure is fatal and mapped to a
          generic JSON { error }; the upstream body never leaves this
          process (it is only logged, bounded and scrubbed). */
    const tokens = await getJson(`${base}/v0/tokens`, controller.signal);
    if (tokens.kind !== "ok") {
      logEvent("upstream_error", { level: "error", rid, target: "tokens", ...tokensFailure(tokens) });
      return json(tokensErrorMessage(tokens), tokens.kind === "timeout" ? 504 : 502, rh);
    }
    const raw = tokens.data;
    if (!Array.isArray(raw)) {
      logEvent("upstream_error", { level: "error", rid, target: "tokens", kind: "bad_shape" });
      return json({ error: "Tidepool response was malformed" }, 502, rh);
    }

    /* Validate every item; drop the ones that do not survive. An empty
       upstream array is a valid (if unusual) answer and returns 200 with
       an empty network list — but an array where NOTHING validates means
       the schema drifted, which is an error, not "no tokens". */
    const valid = [];
    let dropped = 0;
    for (const item of raw) {
      const t = normalizeToken(item);
      if (t) valid.push(t);
      else dropped++;
    }
    if (raw.length > 0 && valid.length === 0) {
      logEvent("upstream_error", { level: "error", rid, target: "tokens", kind: "bad_shape", dropped: raw.length });
      return json({ error: "Tidepool response was malformed" }, 502, rh);
    }

    /* Empty result: answer honestly, skip the health call, and do NOT
       cache — the next request re-checks, so a transient empty answer
       recovers immediately. */
    if (valid.length === 0) {
      logEvent("networks_ok", { level: "warn", rid, ip, chains: 0, tokens: 0, dropped, cached: false, ms: Date.now() - t0 });
      return json(
        { networks: [], count: { networks: 0, tokens: 0 }, fetchedAt: new Date().toISOString(), cached: false, cacheSeconds: Math.round(ttl / 1000) },
        200, rh,
      );
    }

    /* 2. /v0/health — optional. Any failure degrades availability to
          "unverified" for every chain instead of failing the response:
          the token list itself is still authoritative and fresh. */
    let health = null;
    const hl = await getJson(`${base}/v0/health`, controller.signal);
    if (hl.kind === "ok" && hl.data && typeof hl.data === "object" && !Array.isArray(hl.data)) {
      health = hl.data;
    } else {
      logEvent("upstream_error", {
        level: "error", rid, target: "health",
        ...(hl.kind === "ok" ? { kind: "bad_shape" } : tokensFailure(hl)),
      });
    }

    const byChain = new Map();
    for (const t of valid) {
      let group = byChain.get(t.blockchain);
      if (!group) {
        group = {
          blockchain: t.blockchain,
          name: chainName(health, t.blockchain),
          availability: availabilityFor(health, t.blockchain),
          tokens: [],
        };
        byChain.set(t.blockchain, group);
      }
      group.tokens.push({
        assetId: t.assetId,
        symbol: t.symbol,
        decimals: t.decimals,
        contractAddress: t.contractAddress,
      });
    }

    const body = {
      networks: [...byChain.values()],
      count: { networks: byChain.size, tokens: valid.length },
      fetchedAt: new Date().toISOString(),
    };
    /* Cache only a successful, non-empty discovery (see header). */
    if (ttl > 0) cache = { expiresAt: Date.now() + ttl, body };

    logEvent("networks_ok", {
      level: dropped > 0 ? "warn" : "info",
      rid, ip,
      chains: body.count.networks,
      tokens: body.count.tokens,
      dropped,
      cached: false,
      ms: Date.now() - t0,
    });
    return json({ ...body, cached: false, cacheSeconds: Math.round(ttl / 1000) }, 200, rh);
  } finally {
    /* Exactly one clearTimeout, reached by every path — success, empty,
       timeout, unreachable, bad status, unreadable body, bad shape — so
       the abort timer never leaks past this request. */
    clearTimeout(timer);
  }
}

/* ── upstream fetch ─────────────────────────────────────────────────────
   One bounded GET returning parsed JSON or a failure kind. The caller
   decides whether a failure is fatal (tokens) or degrades the response
   (health). An abort during ANY leg — connect, error-body read,
   success-body read — classifies as "timeout", never as a generic
   failure. */
async function getJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreachable" };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      if (signal.aborted) return { kind: "timeout" };
      detail = "";
    }
    return { kind: "http_status", status: res.status, detail: detail.slice(0, 400) };
  }
  try {
    return { kind: "ok", data: await res.json() };
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreadable" };
  }
}

/* Log-side detail for a failure: status and a bounded, scrubbed upstream
   excerpt stay server-side; the client only ever gets tokensErrorMessage. */
const tokensFailure = (f) => {
  const out = { kind: f.kind };
  if (f.status !== undefined) out.status = f.status;
  if (f.detail) out.detail = f.detail;
  return out;
};

/* Client-facing messages: generic, no upstream body, no internals. */
function tokensErrorMessage(f) {
  if (f.kind === "timeout") return { error: "Tidepool timed out" };
  if (f.kind === "unreachable") return { error: "Could not reach Tidepool" };
  if (f.kind === "http_status") return { error: `Tidepool returned ${f.status}` };
  if (f.kind === "unreadable") return { error: "Tidepool response was unreadable" };
  return { error: "Tidepool response was malformed" };
}

/* ── validation + curation ─────────────────────────────────────────────
   One item in, either a clean tuple or null (drop it). Only these five
   fields ever leave this Worker — price, priceUpdatedAt, coingeckoId and
   every other upstream key are discarded here. */
function normalizeToken(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const assetId = typeof item.assetId === "string" ? item.assetId.trim() : "";
  const blockchain = typeof item.blockchain === "string" ? item.blockchain.trim() : "";
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  if (!assetId || assetId.length > MAX_ASSET_ID) return null;
  if (!blockchain || blockchain.length > MAX_CHAIN) return null;
  if (!symbol || symbol.length > MAX_SYMBOL) return null;
  const decimals = item.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;
  let contractAddress = null;
  if (item.contractAddress !== undefined && item.contractAddress !== null) {
    if (typeof item.contractAddress !== "string") return null;
    const c = item.contractAddress.trim();
    if (c.length > MAX_CONTRACT) return null;
    contractAddress = c || null; // "" -> null; xrp/btc/hypercore simply omit it
  }
  return { assetId, blockchain, symbol, decimals, contractAddress };
}

/* Chain display name from health, when health has one. NEAR is not a
   bridge chain, so it reports null and the frontend shows the code. */
function chainName(health, blockchain) {
  if (!health) return null;
  const entry = health.bridges && health.bridges.chains && health.bridges.chains[blockchain];
  const name = entry && typeof entry === "object" && typeof entry.name === "string" ? entry.name.trim() : "";
  return name ? name.slice(0, MAX_NAME) : null;
}

/* Fail-closed availability — every path answers with one of:
     native       NEAR, and health's rpc + verifier checks both say ok
     bridge-ok    health lists this chain's bridge and ok === true
     bridge-down  health lists this chain's bridge and ok === false
     unsupported  health enumerates its bridges and this chain is absent
     unverified   health missing/unreadable, or the entry is nonsense
   Never "ok" on a guess. */
function availabilityFor(health, blockchain) {
  if (!health) return "unverified";
  if (blockchain === "near") {
    const checks = health.checks;
    const rpcOk = checks && checks.rpc && checks.rpc.ok === true;
    const verifierOk = checks && checks.verifier && checks.verifier.ok === true;
    return rpcOk && verifierOk ? "native" : "unverified";
  }
  const chains = health.bridges && health.bridges.chains;
  if (!chains || typeof chains !== "object") return "unverified";
  const entry = chains[blockchain];
  if (entry === undefined) return "unsupported";
  if (entry && typeof entry === "object") {
    if (entry.ok === true) return "bridge-ok";
    if (entry.ok === false) return "bridge-down";
  }
  return "unverified";
}

/* ── cache (per isolate) ───────────────────────────────────────────────
   Module-level because an isolate serves many requests. Stores only the
   curated body — never a raw upstream response — and only for a
   successful, non-empty discovery (see handle). Tests reset it through
   clearDiscoveryCache(). */
let cache = null;

export function clearDiscoveryCache() {
  cache = null;
}

/* TIDEPOOL_CACHE_MS: 0 disables caching; anything outside 0..600000 or
   non-numeric falls back to the 60-second default rather than trusting
   arbitrary input. Exported for test/networks.test.mjs. */
export function discoveryTtlMs(env) {
  const n = Number(env && env.TIDEPOOL_CACHE_MS);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CACHE_MS ? Math.floor(n) : DEFAULT_CACHE_MS;
}

/* TIDEPOOL_TIMEOUT_MS: 1..60000 ms, else the 5-second default — same
   bounds discipline as the parse Worker's PARSE_TIMEOUT_MS. Exported for
   test/networks.test.mjs. */
export function tidepoolTimeoutMs(env) {
  const n = Number(env && env.TIDEPOOL_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 && n <= 60_000 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    /* Freshness belongs to the server-side cache only — an intermediary
       holding this past our TTL is exactly the staleness we refuse. */
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

/* ═══════════════════════════════════════════════════════════════════════
 * Phase 3 — POST /quote: verified quotes, deposit instructions and
 * payment-intent records.
 *
 * Order of authority for one request: contract (get_link) -> eligibility
 * -> FRESH /v0/tokens -> INTENT_DO (serialized create-or-reuse, upstream
 * quote + signature verification inside). The frontend supplies only
 * routing choices (linkId, blockchain, assetId, refundTo,
 * idempotencyKey); every financial fact comes from the contract or from
 * verified Tidepool responses.
 * ═══════════════════════════════════════════════════════════════════════ */

/* The approved destination: the merchant is paid in this NEP-141 USDC.
   DEST_TOKEN is the invoice's token by identity — eligibility() refuses
   any invoice denominated elsewhere, which is what proves the invoice
   amount shares this asset's decimals (never assumed, never read from the
   source token). */
const DEST_ASSET = "nep141:usdc.tidepool-sandbox.testnet";
const DEST_TOKEN = DEST_ASSET.slice(DEST_ASSET.indexOf(":") + 1);

/* Tidepool's maker PUBLIC key — every Tidepool-signed quote verifies
   against it (docs: verify-quote-signatures; proven live against real
   signatures). Public data, deliberately NOT a wrangler secret;
   TIDEPOOL_MAKER_KEY overrides it (tests inject their own key). */
const DEFAULT_MAKER_KEY = "ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY";

/* NEAR contract + RPC defaults mirror frontend/config.js and the keeper's
   wrangler.toml (FastNEAR, not the deprecated rpc.testnet.near.org). */
const DEFAULT_CONTRACT_ID = "paylink-v2.testnet";
const DEFAULT_RPC_URL = "https://test.rpc.fastnear.com";

/* Quote deadline window: min(now + window, invoice expiry). Tidepool
   accepts live deadlines of 60 s .. 24 h, so the window is clamped to
   exactly that range; eligibility() refuses invoices expiring inside the
   same 60 s floor, so the computed deadline always fits. */
const DEFAULT_QUOTE_WINDOW_MS = 3_600_000;
const MIN_QUOTE_WINDOW_MS = 60_000;
const MAX_QUOTE_WINDOW_MS = 86_400_000;
/* Reconcile cooldown after an AMBIGUOUS quote-creation outcome: no new
   live quote before it elapses (spec: reconcile first). */
const DEFAULT_AMBIGUOUS_COOLDOWN_MS = 60_000;
const MAX_AMBIGUOUS_COOLDOWN_MS = 3_600_000;
/* Refuse invoices expiring less than this out — too short to deposit into. */
const INVOICE_LEEWAY_MS = 60_000;

/* Request and record bounds (guards, not claims about anyone's schema). */
const MAX_REQUEST_BYTES = 8_192;
const MIN_LINK_ID_LEN = 4;    // contract: "link id must be 4-64 characters"
const MAX_LINK_ID_LEN = 64;
const MAX_REFUND_TO = 128;
const MAX_IDEMPOTENCY_KEY = 128;
const MAX_DEPOSIT_ADDRESS = 256;
const MAX_DEPOSIT_MEMO = 256;
const MAX_INTENTS_PER_LINK = 20;   // abuse bound: each intent is a full quote cycle
/* Audit history cap (oldest dropped). Phase 6: raised 100 -> 256 so a
   full invoice lifecycle (MAX_INTENTS_PER_LINK 20 intents x ~12
   transitions each ≈ 240) keeps even its OLDEST entries — the active
   intent's creation_started must survive long enough to investigate it. */
const MAX_HISTORY = 256;
const RECORD_KEY = "record";       // one Durable Object storage key per invoice
const U128_MAX = (1n << 128n) - 1n;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;
const DO_CREATE_PATH = "https://intent.do/create";
const DO_STATUS_PATH = "https://intent.do/status";

/* GET /status read capability: pi_ + 64 bits of hex randomness (two
   newRid() halves). Only ever handed to whoever requested the quote; an
   id from another invoice, an old id or an invented id is a 404. */
const INTENT_ID_RE = /^pi_[0-9a-f]{16}$/;

/* Polling bounds (Phase 4): the documented Tidepool guidance is "poll
   every 2–5 s after a deposit; stop on SUCCESS / REFUNDED / FAILED; stop
   PENDING_DEPOSIT past the deadline" — so the floor defaults to 2000 ms
   and a poll cycle may never be scheduled closer than 1000 ms, nor
   stretched beyond 60 s by configuration. POLL_WATCH_LIMIT_MS mirrors
   Tidepool's own watcher: it stops watching an address 24 h after the
   quote deadline, so we stop asking at the same point. */
const DEFAULT_STATUS_MIN_INTERVAL_MS = 2_000;
const MIN_STATUS_MIN_INTERVAL_MS = 1_000;
const MAX_STATUS_MIN_INTERVAL_MS = 60_000;
const POLL_WATCH_LIMIT_MS = 86_400_000;

/* Internal states after which GET /status never touches an upstream
   again: SETTLED (Tidepool SUCCESS — awaiting Phase 5 verification),
   VERIFIED (Phase 5), and the terminal money-out/money-in states.
   Docs: stop on SUCCESS / REFUNDED / FAILED; EXPIRED is ours.
   Phase 5 carve-out: SETTLED is terminal for the TIDEPOOL legs (no
   further /v0/status reads — docs say stop on SUCCESS) but NOT for a
   SETTLED intent that still owes verification: such a cycle runs the
   Phase 5 evidence path instead (NEAR tx reads + one fresh get_link),
   and only ever leaves through SETTLED -> VERIFIED. A SETTLED intent
   with no captured payout-hash candidates keeps the zero-read hold. */
const POLLING_TERMINAL = new Set(["SETTLED", "VERIFIED", "REFUNDED", "FAILED", "EXPIRED"]);

/* Phase 6: a held candidate-less SETTLED still watches the INVOICE —
   authoritative contract reads only, at most once per this interval,
   NEVER a Tidepool re-read (docs: stop on SUCCESS) and never a NEAR tx
   read (nothing here can verify anything). This is the only
   zero-Tidepool-read state that still moves, and it exists solely so an
   invoice_paid conflict remains detectable AFTER polling stopped. A
   fresh record.onChainCheckedAt keeps the Phase 4/5 zero-read contract
   intact; other terminal states keep unconditional zero reads. */
const HOLD_CONTRACT_REFRESH_MS = 60_000;

/* ── env tunables (bounds discipline like discoveryTtlMs) ────────────── */

export function quoteWindowMs(env) {
  const n = Number(env && env.TIDEPOOL_QUOTE_WINDOW_MS);
  return Number.isFinite(n) && n >= MIN_QUOTE_WINDOW_MS && n <= MAX_QUOTE_WINDOW_MS
    ? Math.floor(n) : DEFAULT_QUOTE_WINDOW_MS;
}

export function ambiguousCooldownMs(env) {
  const n = Number(env && env.TIDEPOOL_AMBIGUOUS_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 && n <= MAX_AMBIGUOUS_COOLDOWN_MS
    ? Math.floor(n) : DEFAULT_AMBIGUOUS_COOLDOWN_MS;
}

/* TIDEPOOL_STATUS_MIN_INTERVAL_MS: the GET /status poll floor — default
   2000 ms (docs: poll every 2–5 s after a deposit), clamped to
   1000..60000 ms; anything outside falls back to the default rather
   than trusting arbitrary input. Exported for test/status.test.mjs. */
export function statusMinIntervalMs(env) {
  const n = Number(env && env.TIDEPOOL_STATUS_MIN_INTERVAL_MS);
  return Number.isFinite(n) && n >= MIN_STATUS_MIN_INTERVAL_MS && n <= MAX_STATUS_MIN_INTERVAL_MS
    ? Math.floor(n) : DEFAULT_STATUS_MIN_INTERVAL_MS;
}

/* Phase 5 — verification attempt backoff: the base delay after a hold,
   doubled per attempt up to the 1 h cap. TIDEPOOL_VERIFY_BACKOFF_MS is
   0..3600000 ms, else the 5 s default — the same bounds discipline as
   ambiguousCooldownMs (0 = retry on every eligible poll, used by tests
   that must observe the next attempt immediately). Exported for
   test/payout.test.mjs. */
const DEFAULT_VERIFY_BACKOFF_MS = 5_000;
const MAX_VERIFY_BACKOFF_MS = 3_600_000;
/* Evidence bound: one intent never fetches more than this many payout
   hashes per attempt (Tidepool's swapDetails is small; this is a guard,
   not a claim about anyone's schema). */
const MAX_PAYOUT_HASHES = 8;

export function verifyBackoffMs(env) {
  const n = Number(env && env.TIDEPOOL_VERIFY_BACKOFF_MS);
  return Number.isFinite(n) && n >= 0 && n <= MAX_VERIFY_BACKOFF_MS
    ? Math.floor(n) : DEFAULT_VERIFY_BACKOFF_MS;
}

/* The delay before the NEXT verification attempt after `attempts` prior
   holds: base * 2^(attempts-1), capped at 1 h. Exponent-bounded so the
   doubling can never overflow into Infinity. */
function verifyBackoffDelayMs(env, attempts) {
  const base = verifyBackoffMs(env);
  if (base <= 0) return 0;
  const exp = Math.min(Math.max(Number(attempts) || 0, 0), 20);
  return Math.min(base * 2 ** exp, MAX_VERIFY_BACKOFF_MS);
}

/* A deposit, once observed, is never un-observed. transition() writes
   the flag; this helper also back-computes it for records written
   before the flag existed, so a DEPOSIT_SEEN that later sits in
   RECONCILE can still never be expired (Part 4: "DEPOSIT_SEEN must
   never be incorrectly expired"). */
export const depositObserved = (i) =>
  !!i && (i.depositObserved === true ||
    i.status === "DEPOSIT_SEEN" || i.status === "SETTLING" ||
    i.status === "SETTLED" || i.status === "VERIFIED");

export function makerKey(env) {
  const k = env && typeof env.TIDEPOOL_MAKER_KEY === "string" ? env.TIDEPOOL_MAKER_KEY.trim() : "";
  return k || DEFAULT_MAKER_KEY;
}

const tidepoolOrigin = (env) =>
  String((env && env.TIDEPOOL_ORIGIN) || DEFAULT_TIDEPOOL_ORIGIN).replace(/\/+$/, "");
const contractId = (env) =>
  (env && typeof env.CONTRACT_ID === "string" && env.CONTRACT_ID) ? env.CONTRACT_ID : DEFAULT_CONTRACT_ID;
/* Non-secret fee-tier selector: any X-API-Key value is accepted by
   Tidepool; the value only chooses the keyed fee tier, exactly like the
   existing frontend rail sends. Not a secret, not a wrangler secret. */
const xApiKey = (env) =>
  (env && typeof env.TIDEPOOL_X_API_KEY === "string" && env.TIDEPOOL_X_API_KEY)
    ? env.TIDEPOOL_X_API_KEY : "paylink-testnet";

/* ── internal state machine (Part 6) ─────────────────────────────────── */

/* The ten states the Phase 3 spec requires, by name. */
export const SPEC_STATES = Object.freeze([
  "QUOTE_ISSUED", "AWAITING_DEPOSIT", "DEPOSIT_SEEN", "SETTLING", "RECONCILE",
  "VERIFIED", "REFUNDED", "FAILED", "EXPIRED", "UNKNOWN",
]);
/* Two implementation states join them:
     CREATING — persisted BEFORE the upstream call: the ambiguity checkpoint
                that makes a lost creation detectable instead of repeatable.
     SETTLED  — Tidepool reported SUCCESS: external success only, NEVER
                verification (SETTLED -> VERIFIED is Phase 5's job). */
export const INTERNAL_STATES = Object.freeze([...SPEC_STATES, "CREATING", "SETTLED"]);

/* The single transition authority. Invariants encoded here:
     - VERIFIED has no exits: a verified payment can never be overwritten
       by a later pending, failed or even SUCCESS update.
     - REFUNDED / FAILED / EXPIRED are terminal: a retried payment is a NEW
       intent (its own record), never a resurrection of a dead one.
     - SETTLED -> VERIFIED is the only exit of SETTLED (Phase 5).
     - CREATING has no inbound edge: it exists only as a fresh record.
     - DEPOSIT_SEEN can never become EXPIRED: a deposit that was observed
       settles or refunds — it does not quietly expire.
     - Everything else may move to RECONCILE / UNKNOWN (losing information
       is honest) and to the terminal money-in/money-out states. */
const TRANSITIONS = {
  CREATING:         ["QUOTE_ISSUED", "RECONCILE", "FAILED"],
  QUOTE_ISSUED:     ["AWAITING_DEPOSIT", "DEPOSIT_SEEN", "SETTLING", "SETTLED", "RECONCILE", "EXPIRED", "FAILED", "REFUNDED", "UNKNOWN"],
  AWAITING_DEPOSIT: ["DEPOSIT_SEEN", "SETTLING", "SETTLED", "RECONCILE", "EXPIRED", "FAILED", "REFUNDED", "UNKNOWN"],
  DEPOSIT_SEEN:     ["SETTLING", "SETTLED", "RECONCILE", "FAILED", "REFUNDED", "UNKNOWN"],
  SETTLING:         ["SETTLED", "RECONCILE", "FAILED", "REFUNDED", "UNKNOWN"],
  SETTLED:          ["VERIFIED"],
  RECONCILE:        ["AWAITING_DEPOSIT", "DEPOSIT_SEEN", "SETTLING", "SETTLED", "EXPIRED", "FAILED", "REFUNDED", "UNKNOWN"],
  UNKNOWN:          ["AWAITING_DEPOSIT", "DEPOSIT_SEEN", "SETTLING", "SETTLED", "RECONCILE", "EXPIRED", "FAILED", "REFUNDED"],
  VERIFIED:         [],
  REFUNDED:         [],
  FAILED:           [],
  EXPIRED:          [],
};

export function canTransition(from, to) {
  if (typeof from !== "string" || typeof to !== "string" || from === to) return false;
  const next = TRANSITIONS[from];
  return Array.isArray(next) && next.includes(to);
}

/* Applies a transition in place; returns {from, to} or null (refused,
   intent untouched). Duplicate updates (from === to) are refused too —
   the caller treats them as a no-op, not an error. */
export function applyTransition(intent, to, reason, ts) {
  if (!intent || !canTransition(intent.status, to)) return null;
  const from = intent.status;
  intent.status = to;
  if (typeof ts === "number") intent.updatedAt = ts;
  if (reason) intent.lastReason = String(reason);
  return { from, to };
}

export const isTerminal = (s) => Array.isArray(TRANSITIONS[s]) && TRANSITIONS[s].length === 0;

/* States from which a NEW intent may be created — an explicit allowlist,
   safe by default: VERIFIED, SETTLED and every live state block a new
   intent; only a settled-out EXPIRED / REFUNDED / FAILED lets a payer
   start again. */
const NEW_INTENT_ALLOWED = new Set(["EXPIRED", "REFUNDED", "FAILED"]);

/* Tidepool status -> internal state. PENDING_DEPOSIT maps to "no
   transition": the quote is simply still waiting (its deadline decides
   whether that becomes EXPIRED — see reconcile). Anything unrecognised
   returns {ok:false} and is refused with 503 status_unknown — never
   guessed. */
const TIDEPOOL_STATE_MAP = {
  PENDING_DEPOSIT: null,
  KNOWN_DEPOSIT_TX: "DEPOSIT_SEEN",
  INCOMPLETE_DEPOSIT: "DEPOSIT_SEEN",
  PROCESSING: "SETTLING",
  SUCCESS: "SETTLED",
  REFUNDED: "REFUNDED",
  FAILED: "FAILED",
};

export function mapTidepoolStatus(status) {
  if (typeof status !== "string" ||
      !Object.prototype.hasOwnProperty.call(TIDEPOOL_STATE_MAP, status)) {
    return { ok: false };
  }
  return { ok: true, target: TIDEPOOL_STATE_MAP[status] };
}

/* ── quote signature: Base58 + json-stable-stringify + Ed25519 ────────
   The exact 1Click/Tidepool scheme (SDK 0.1.24 quote-signature.ts +
   Tidepool /docs/guides/verify-quote-signatures):
   json-stable-stringify({…12 required quoteRequest fields, …5 conditionals
   when truthy, …8 quote amount fields, + execution fields when NOT dry,
   timestamp}) -> SHA-256 -> Base58 -> UTF-8 bytes of THAT Base58 string
   -> Ed25519 verify against the maker key (Tidepool's own maker key
   ed25519:U1Mu… — the SDK default 1Click mainnet key never verifies a
   Tidepool quote). Dry quotes sign only the amount fields; non-dry
   quotes additionally sign depositAddress / depositMemo / deadline /
   timeWhenInactive / timeEstimate / refundFee / withdrawFee when
   present (Tidepool docs; empirically proven against real signatures
   from both modes). depositMode / sessionId / appFees / correlationId
   are excluded from the signed payload; the echoed quoteRequest still
   carries them, which is why validateQuoteResponse also compares every
   field we sent. */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return new Uint8Array([...Array(zeros).fill(0), ...out]);
}

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + out;
}

/* json-stable-stringify semantics for this payload shape: sorted keys,
   undefined properties dropped (as JSON.stringify drops them), JSON
   primitives, arrays with null for undefined slots. */
export function stableStringify(v) {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x === undefined ? null : x)).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

const SIGNED_REQUEST_FIELDS = [
  "dry", "swapType", "slippageTolerance", "originAsset", "depositType",
  "destinationAsset", "amount", "refundTo", "refundType", "recipient",
  "recipientType", "deadline",
];
const SIGNED_CONDITIONAL_FIELDS = [
  "quoteWaitingTimeMs", "referral", "virtualChainRecipient",
  "virtualChainRefundRecipient", "customRecipientMsg",
];
const SIGNED_QUOTE_FIELDS = [
  "amountIn", "amountInFormatted", "amountInUsd", "minAmountIn",
  "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut",
];
/* Non-dry quotes additionally sign the execution fields that exist on the
   quote object; absent ones are simply omitted from the payload (the
   SDK's stable stringify drops undefined). `deadline` here is the
   quote-level deadline — same value as the request deadline in practice;
   the spread order below lets it win, matching the signing side. */
const SIGNED_EXECUTION_FIELDS = [
  "depositAddress", "depositMemo", "deadline", "timeWhenInactive",
  "timeEstimate", "refundFee", "withdrawFee",
];

function signedQuoteParts(resp) {
  const qr = resp.quoteRequest;
  const q = resp.quote;
  if (!qr || typeof qr !== "object" || Array.isArray(qr)) return null;
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  const request = {};
  for (const k of SIGNED_REQUEST_FIELDS) request[k] = qr[k];
  for (const k of SIGNED_CONDITIONAL_FIELDS) if (qr[k]) request[k] = qr[k];
  const quote = {};
  for (const k of SIGNED_QUOTE_FIELDS) quote[k] = q[k];
  if (qr.dry !== true) {
    for (const k of SIGNED_EXECUTION_FIELDS) {
      if (q[k] !== undefined) quote[k] = q[k];
    }
  }
  return { request, quote };
}

export async function verifyQuoteSignature(resp, keyValue) {
  try {
    if (!resp || typeof resp !== "object") return false;
    const keyStr = typeof keyValue === "string" ? keyValue : "";
    if (!keyStr.startsWith("ed25519:")) return false;
    if (typeof resp.signature !== "string" || !resp.signature.startsWith("ed25519:")) return false;
    if (typeof resp.timestamp !== "string" || !resp.timestamp) return false;
    const parts = signedQuoteParts(resp);
    if (!parts) return false;
    const dataStr = stableStringify({ ...parts.request, ...parts.quote, timestamp: resp.timestamp });
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataStr));
    const msg = new TextEncoder().encode(b58encode(new Uint8Array(hash)));
    const sig = b58decode(resp.signature.slice("ed25519:".length));
    const pub = b58decode(keyStr.slice("ed25519:".length));
    if (sig.length !== 64 || pub.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch {
    return false; // malformed key/signature/payload: an invalid quote, not a crash
  }
}

/* ── quote response validation (Part 4) ───────────────────────────────
   Structural schema -> echo (every field we sent comes back byte-identical:
   the anti-replay guard — a signature alone only proves Tidepool signed
   SOMETHING) -> EXACT_OUTPUT amount invariants (BigInt string comparisons
   only; amountOut must equal the invoice amount exactly) -> live deadline
   -> deposit instructions -> signature under the maker key.
   Returns {ok:true, data} or {ok:false, reason}. */
const QUOTE_FAILS = {
  malformed:        ["quote_malformed", "Tidepool quote response was malformed"],
  echo_mismatch:    ["quote_echo_mismatch", "Quote did not echo our request"],
  amount_mismatch:  ["quote_amount_mismatch", "Quote amounts did not match the invoice"],
  deadline:         ["quote_deadline_invalid", "Quote deadline was missing or already past"],
  deposit:          ["quote_deposit_invalid", "Quote deposit instructions were incomplete"],
  signature:        ["quote_signature_invalid", "Quote signature could not be verified"],
};

export async function validateQuoteResponse(resp, sent, opts = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return fail("malformed");
  if (!sent || typeof sent !== "object" || Array.isArray(sent)) return fail("malformed");
  const qr = resp.quoteRequest;
  const q = resp.quote;
  if (!qr || typeof qr !== "object" || Array.isArray(qr)) return fail("malformed");
  if (!q || typeof q !== "object" || Array.isArray(q)) return fail("malformed");
  if (typeof resp.timestamp !== "string" || Number.isNaN(Date.parse(resp.timestamp))) return fail("malformed");
  if (typeof resp.signature !== "string" || !resp.signature.startsWith("ed25519:")) return fail("malformed");
  if (typeof resp.correlationId !== "string" || !resp.correlationId || resp.correlationId.length > 128) return fail("malformed");

  for (const k of Object.keys(sent)) {
    if (JSON.stringify(qr[k]) !== JSON.stringify(sent[k])) return fail("echo_mismatch");
  }

  for (const k of ["amountIn", "minAmountIn", "amountOut", "minAmountOut"]) {
    if (typeof q[k] !== "string" || !CANONICAL_UINT.test(q[k])) return fail("malformed");
  }
  const invoiceAmount = typeof opts.invoiceAmount === "string" ? opts.invoiceAmount : String(sent.amount);
  if (q.amountOut !== invoiceAmount) return fail("amount_mismatch");      // EXACT_OUTPUT is exact
  if (q.minAmountOut !== q.amountOut) return fail("amount_mismatch");     // …and slippage never eats it
  if (BigInt(q.amountIn) <= 0n) return fail("amount_mismatch");
  if (BigInt(q.minAmountIn) > BigInt(q.amountIn)) return fail("amount_mismatch");

  if (typeof q.deadline !== "string" || Number.isNaN(Date.parse(q.deadline))) return fail("deadline");
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  if (Date.parse(q.deadline) <= now) return fail("deadline");

  const addr = typeof q.depositAddress === "string" ? q.depositAddress.trim() : "";
  if (!addr || addr.length > MAX_DEPOSIT_ADDRESS) return fail("deposit");
  let memo = null;
  if (q.depositMemo !== undefined && q.depositMemo !== null) {
    if (typeof q.depositMemo !== "string" || !q.depositMemo || q.depositMemo.length > MAX_DEPOSIT_MEMO) return fail("deposit");
    memo = q.depositMemo;
  }
  if (sent.depositMode === "MEMO" && !memo) return fail("deposit");

  if (!(await verifyQuoteSignature(resp, opts.makerKey || DEFAULT_MAKER_KEY))) return fail("signature");

  return { ok: true, data: {
    depositAddress: addr,
    depositMemo: memo,
    correlationId: resp.correlationId,
    quoteTimestamp: resp.timestamp,
    amountIn: q.amountIn,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    deadlineMs: Date.parse(q.deadline),
    signature: resp.signature,
  } };
}

/* ── quote request construction (Part 3) ───────────────────────────────
   EXACT_OUTPUT with amount = the invoice amount in base units (the
   contract's own number), recipient = the contract's creator (the
   merchant — never client data), destination = the approved USDC.
   deposit/refund type follows the SOURCE chain: "near" settles through
   NEAR Intents (INTENTS), every other chain through its own rail
   (ORIGIN_CHAIN) — data-driven from the fresh token, not a chain list.
   deadline = min(now + window, invoice expiry). depositMode is OMITTED by
   default and only set by the single data-driven MEMO retry below. */
export function buildQuoteRequest(params) {
  const { link, source, destination, refundTo, now, windowMs, depositMode } = params;
  let deadlineMs = now + windowMs;
  if (typeof link.expires_at === "number") deadlineMs = Math.min(deadlineMs, link.expires_at);
  const onNear = source.blockchain === "near";
  const req = {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,          // mirrors the existing rail (app.js)
    originAsset: source.assetId,
    depositType: onNear ? "INTENTS" : "ORIGIN_CHAIN",
    destinationAsset: destination.assetId,
    amount: String(link.amount),
    refundTo,
    refundType: onNear ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: link.creator,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(deadlineMs).toISOString(),
  };
  if (depositMode) req.depositMode = depositMode;
  return req;
}

/* ── NEAR contract read (keeper-style failover, read-only) ───────────── */

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function rpcCall(env, method, args, signal) {
  const urls = [env && env.RPC_URL ? String(env.RPC_URL) : DEFAULT_RPC_URL];
  if (env && typeof env.RPC_URLS === "string") {
    for (const u of env.RPC_URLS.split(",")) {
      const t = u.trim();
      if (t && !urls.includes(t)) urls.push(t);
    }
  }
  const body = JSON.stringify({
    jsonrpc: "2.0", id: "1", method: "query",
    params: {
      request_type: "call_function", finality: "final",
      account_id: contractId(env), method_name: method,
      args_base64: b64encode(new TextEncoder().encode(JSON.stringify(args))),
    },
  });
  let last = { kind: "unreachable" };
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
    } catch {
      last = { kind: signal.aborted ? "timeout" : "unreachable" };
      continue;
    }
    if (!res.ok) { last = { kind: "http_status", status: res.status }; continue; }
    let parsed;
    try { parsed = await res.json(); } catch {
      last = { kind: signal.aborted ? "timeout" : "unreadable" };
      continue;
    }
    /* The node answered: JSON-RPC errors and contract panics are
       definitive answers, not retryable transport problems. */
    if (parsed && parsed.error) return { kind: "rpc_error" };
    const r = parsed && parsed.result;
    if (!r || typeof r !== "object") { last = { kind: "bad_shape" }; continue; }
    if (r.error) return { kind: "contract_error" };
    if (!Array.isArray(r.result)) { last = { kind: "bad_shape" }; continue; }
    try {
      const text = new TextDecoder().decode(Uint8Array.from(r.result));
      return { kind: "ok", value: JSON.parse(text) };
    } catch {
      return { kind: "bad_shape" };   // contract answered; undecodable = anomaly
    }
  }
  return last;
}

/* ── Phase 5: NEAR transaction evidence (read-only) ─────────────────────
   A generic JSON-RPC caller for an ARBITRARY method — rpcCall above is
   hard-wired to `query`, and payout evidence needs `tx_status` (the
   nearcore method that returns the receipt list with actions; plain `tx`
   carries none — established against live testnet nodes).

   Classification is exactly what the verification verdict consumes:
     unknown_transaction — this node has never seen the hash. Delayed
        visibility or non-archival retention: retryable, and worth one
        failover attempt on the next configured node first.
     malformed_request — the node refused OUR parameters (a string that
        is not a transaction hash): definitive, same on every node.
     method_missing — the node does not implement the method: try the
        next node, then the EXPERIMENTAL spelling of the same query.
     rpc_error — a definitive JSON-RPC error (definitive, like rpcCall).
     timeout / unreachable / http_status / unreadable / bad_shape —
        transport or shape problems: retryable, fail over.
   Definitive answers return at once; retryable ones move to the next
   configured node (same failover list as rpcCall), and `last` survives
   as the honest classification when every node failed. */
async function nearRpc(env, method, params, signal) {
  const urls = [env && env.RPC_URL ? String(env.RPC_URL) : DEFAULT_RPC_URL];
  if (env && typeof env.RPC_URLS === "string") {
    for (const u of env.RPC_URLS.split(",")) {
      const t = u.trim();
      if (t && !urls.includes(t)) urls.push(t);
    }
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  let last = { kind: "unreachable" };
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
    } catch {
      last = { kind: signal.aborted ? "timeout" : "unreachable" };
      continue;
    }
    /* The nodes answer a refused request (bad params — established live:
       a malformed hash comes back as HTTP 400 with a JSON-RPC error
       BODY) — classify the body before calling it a transport failure. */
    if (!res.ok) {
      try {
        const e = await res.json();
        const be = e && e.error;
        if (be) {
          const bc = be.cause && typeof be.cause === "object" ? be.cause : null;
          const bn = bc && bc.name || be.name;
          if (bn === "REQUEST_VALIDATION_ERROR" || be.name === "REQUEST_VALIDATION_ERROR") return { kind: "malformed_request" };
          if (bn === "UNKNOWN_TRANSACTION" || be.name === "UNKNOWN_TRANSACTION") { last = { kind: "unknown_transaction" }; continue; }
        }
      } catch { /* not a JSON-RPC body: plain transport failure */ }
      last = { kind: "http_status", status: res.status };
      continue;
    }
    let parsed;
    try { parsed = await res.json(); } catch {
      last = { kind: signal.aborted ? "timeout" : "unreadable" };
      continue;
    }
    const err = parsed && parsed.error;
    if (err) {
      const cause = err.cause && typeof err.cause === "object" ? err.cause : null;
      const name = cause && cause.name || err.name;
      const outer = err.name;
      if (name === "UNKNOWN_TRANSACTION" || outer === "UNKNOWN_TRANSACTION") { last = { kind: "unknown_transaction" }; continue; }
      if (name === "REQUEST_VALIDATION_ERROR" || outer === "REQUEST_VALIDATION_ERROR") return { kind: "malformed_request" };
      if (err.code === -32601 || name === "method_missing" || outer === "method_missing") { last = { kind: "method_missing" }; continue; }
      return { kind: "rpc_error" };
    }
    const r = parsed && parsed.result;
    if (!r || typeof r !== "object" || Array.isArray(r)) { last = { kind: "bad_shape" }; continue; }
    return { kind: "ok", value: r };
  }
  return last;
}

/* `sender_account_id` is syntactically required by tx_status but is NOT
   part of the lookup key — proven live against both configured testnet
   nodes (a deliberately wrong sender returns the full transaction). The
   fixed placeholder below is a syntax stand-in, never a claim about who
   signed anything: every fact in the verdict comes from the returned
   transaction itself. wait_until:"NONE" makes an absent transaction an
   instant, classifiable UNKNOWN_TRANSACTION instead of a 10 s stall. */
const TX_STATUS_SENDER = "placeholder.testnet";

async function nearTxStatus(env, hash) {
  const params = { tx_hash: hash, sender_account_id: TX_STATUS_SENDER, wait_until: "NONE" };
  let r = await nearRpcTimed(env, "tx_status", params);
  if (r.kind === "method_missing") {
    /* Nodes predating tx_status only carry the EXPERIMENTAL spelling
       (same result shape: receipts + receipts_outcome). */
    r = await nearRpcTimed(env, "EXPERIMENTAL_tx_status",
      [hash, TX_STATUS_SENDER, "NONE"]);
  }
  return r;
}

/* One nearRpc call with its own timeout budget — same per-read discipline
   as the contract and Tidepool reads (a hung node can never hold a
   status request past tidepoolTimeoutMs). */
function nearRpcTimed(env, method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), tidepoolTimeoutMs(env));
  return nearRpc(env, method, params, ctl.signal).finally(() => clearTimeout(timer));
}

const getLink = (env, linkId, signal) =>
  rpcCall(env, "get_link", { link_id: linkId }, signal);

/* Contract Link -> our normalized shape, or null (malformed). Fields the
   quote path does not use (paid_by, description…) are dropped here —
   curation on the way in, like normalizeToken. expectedId ties the
   response to the request: a mismatched link_id is corruption, not data. */
function normalizeLink(raw, expectedId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const link_id = typeof raw.link_id === "string" ? raw.link_id : "";
  if (expectedId !== undefined && link_id !== expectedId) return null;
  if (link_id.length < MIN_LINK_ID_LEN || link_id.length > MAX_LINK_ID_LEN) return null;
  const creator = typeof raw.creator === "string" ? raw.creator : "";
  if (!ACCOUNT_RE.test(creator)) return null;
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!ACCOUNT_RE.test(token)) return null;
  const amount = typeof raw.amount === "string" ? raw.amount : "";
  if (!CANONICAL_UINT.test(amount)) return null;
  let amt;
  try { amt = BigInt(amount); } catch { return null; }
  if (amt <= 0n || amt > U128_MAX) return null;
  if (!Number.isInteger(raw.created_at) || raw.created_at < 0) return null;
  let expires_at = null;
  if (raw.expires_at !== null && raw.expires_at !== undefined) {
    if (!Number.isInteger(raw.expires_at) || raw.expires_at <= 0) return null;
    expires_at = raw.expires_at;
  }
  const status = raw.status;
  if (status !== "OPEN" && status !== "PAID" && status !== "CLAIMED" &&
      status !== "CANCELLED" && status !== "EXPIRED") return null;
  return { link_id, creator, amount, token, created_at: raw.created_at, expires_at, status };
}

/* Eligibility for an EXTERNAL payment (Part 1): effective status OPEN
   (get_link derives EXPIRED on read), not expiring inside the deposit
   floor, and denominated in the destination token itself. Returns a
   machine code so both the worker and the Durable Object answer the
   same 409s. */
function checkEligibility(link, now) {
  if (link.status === "PAID" || link.status === "CLAIMED") {
    return { ok: false, code: "invoice_settled", message: "Invoice has already been settled" };
  }
  if (link.status === "CANCELLED") {
    return { ok: false, code: "invoice_cancelled", message: "Invoice was cancelled" };
  }
  if (link.status === "EXPIRED") {
    return { ok: false, code: "invoice_expired", message: "Invoice has expired" };
  }
  if (link.status !== "OPEN") {
    return { ok: false, code: "invoice_not_open", message: "Invoice is not open" };
  }
  if (link.token !== DEST_TOKEN) {
    return { ok: false, code: "invoice_token_unsupported", message: "Invoice token cannot be paid through Tidepool" };
  }
  if (link.expires_at !== null && link.expires_at - now < INVOICE_LEEWAY_MS) {
    return { ok: false, code: "invoice_expiry_too_soon", message: "Invoice expires too soon to quote" };
  }
  return { ok: true };
}

/* Token metadata from the FRESH /v0/tokens item — the four curated
   fields, re-validated for bounds (defense in depth on both sides of the
   DO boundary). */
function normalizeMeta(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const assetId = typeof m.assetId === "string" ? m.assetId.trim() : "";
  const blockchain = typeof m.blockchain === "string" ? m.blockchain.trim() : "";
  const symbol = typeof m.symbol === "string" ? m.symbol.trim() : "";
  if (!assetId || assetId.length > MAX_ASSET_ID) return null;
  if (!blockchain || blockchain.length > MAX_CHAIN) return null;
  if (!symbol || symbol.length > MAX_SYMBOL) return null;
  const decimals = m.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;
  return { assetId, blockchain, symbol, decimals };
}

/* ── upstream: POST /v0/quote and GET /v0/status ─────────────────────── */

/* One live quote attempt (single timeout budget shared with any retry).
   The ONLY retry is data-driven: a 400 whose message names depositMode
   (memo-required chains say exactly that) is re-sent once with
   depositMode:"MEMO". A 400 means no quote was created, so the retry
   cannot duplicate anything; no chain list is hardcoded. */
async function requestQuote(base, req, env, signal, retried) {
  let res;
  try {
    res = await fetch(`${base}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": xApiKey(env) },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreachable" };
  }
  if (res.status === 400 && !retried && !req.depositMode) {
    let msg = "";
    try { msg = await res.text(); } catch { if (signal.aborted) return { kind: "timeout" }; }
    if (/depositMode/.test(msg)) {
      logEvent("quote_deposit_mode_retry", { reason: "deposit_mode_memo_required" });
      return requestQuote(base, { ...req, depositMode: "MEMO" }, env, signal, true);
    }
    return { kind: "http_status", status: 400, detail: msg.slice(0, 400) };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { if (signal.aborted) return { kind: "timeout" }; }
    return { kind: "http_status", status: res.status, detail: detail.slice(0, 400) };
  }
  try {
    return { kind: "ok", data: await res.json() };
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreadable" };
  }
}

/* Ambiguity rule (Part 6): ONLY a received 4xx is a definitive "no quote
   was created" (request-level rejection). 5xx, timeouts, transport
   failures and unreadable bodies may all have created a quote whose
   deposit address we never received — nobody could fund an address they
   were never shown, but the spec still requires reconciling before the
   next live quote, so those outcomes cool down instead of retrying. */
const isDefinitiveFailure = (out) =>
  out.kind === "http_status" && out.status >= 400 && out.status < 500;

/* Retry-After (RFC: delay-seconds) -> milliseconds. Only a finite,
   non-negative number is honoured, and the result is clamped to the
   ambiguous-cooldown ceiling so an upstream header can never park an
   intent for longer than this Worker's own maximum cooldown. */
function parseRetryAfter(header) {
  const n = Number(header);
  if (header === null || header === "" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n * 1000), MAX_AMBIGUOUS_COOLDOWN_MS);
}

async function queryStatus(env, depositAddress, depositMemo, signal) {
  let url = `${tidepoolOrigin(env)}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;
  if (depositMemo) url += `&depositMemo=${encodeURIComponent(depositMemo)}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreachable" };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { if (signal.aborted) return { kind: "timeout" }; }
    /* A 429 (or any failure) may carry Retry-After: the status path
       honours it on top of its own cooldown; the caller clamps again. */
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    return {
      kind: "http_status", status: res.status, detail: detail.slice(0, 400),
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    };
  }
  try {
    const data = await res.json();
    if (!data || typeof data !== "object" || typeof data.status !== "string") return { kind: "bad_shape" };
    return {
      kind: "ok",
      status: data.status,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
      /* Phase 5: server-side capture of the settlement-hash candidates
         (swapDetails is never returned to a client or logged — only the
         classified list below is kept, on the intent). */
      payout: extractPayoutHashes(data),
    };
  } catch {
    return { kind: signal.aborted ? "timeout" : "unreadable" };
  }
}

/* Phase 5 candidate capture from swapDetails: nearTxHashes[] plus
   destinationChainTxHashes[].hash — the destination chain IS NEAR for
   this worker, and the docs' real SUCCESS example carries the same hash
   in both lists, so candidates are deduplicated. originChainTxHashes is
   the deposit leg and intentHashes are never transactions: both
   excluded.

   Classification of each candidate string:
     0x…hex           — another chain's hash syntax: skipped (not a NEAR
                        hash, and not a malformed NEAR hash)
     32-byte base58   — a NEAR transaction hash: kept, capped at
                        MAX_PAYOUT_HASHES per intent
     anything else    — a NEAR-lookalike that fails validation: counted
                        malformed, which BLOCKS verification — a candidate
                        we cannot even address might be the payout we
                        have not seen, so it must never be ignored
   The result is stored on the intent only: never echoed to a client,
   never written to a log line. */
function extractPayoutHashes(data) {
  const hashes = [];
  let invalid = 0;
  const sd = data && data.swapDetails;
  if (!sd || typeof sd !== "object" || Array.isArray(sd)) return { hashes, invalid };
  const consider = (v) => {
    if (typeof v !== "string") return;               // not a hash at all: nothing to address
    const t = v.trim();
    if (t.length > 128) { invalid++; return; }        // bound before any decode work
    if (/^0x[0-9a-fA-F]+$/.test(t)) return;          // other chain's syntax: skipped, not malformed
    let bytes = null;
    try { bytes = b58decode(t); } catch { invalid++; return; }
    if (bytes.length !== 32) { invalid++; return; }  // NEAR transaction hashes are 32 bytes
    if (hashes.length < MAX_PAYOUT_HASHES && !hashes.includes(t)) hashes.push(t);
  };
  if (Array.isArray(sd.nearTxHashes)) for (const v of sd.nearTxHashes) consider(v);
  if (Array.isArray(sd.destinationChainTxHashes)) {
    for (const item of sd.destinationChainTxHashes) {
      consider(item && typeof item === "object" && !Array.isArray(item) ? item.hash : item);
    }
  }
  return { hashes, invalid };
}

/* Persist captured candidates on the intent — called from every
   successful status read, including the cycle that lands SETTLED: that
   read's swapDetails is what the NEXT (verification) cycle fetches from
   the node. The malformed counter accumulates across reads (one bad
   candidate anywhere blocks verification), the hash list only grows
   (union, capped), and both fields stay server-side forever. */
function mergePayoutHashes(intent, payout) {
  if (!payout || !Array.isArray(payout.hashes)) return;
  if (payout.hashes.length === 0 && !(payout.invalid > 0)) return;
  if (!Array.isArray(intent.payoutHashes)) intent.payoutHashes = [];
  for (const h of payout.hashes) {
    if (intent.payoutHashes.length >= MAX_PAYOUT_HASHES) break;
    if (!intent.payoutHashes.includes(h)) intent.payoutHashes.push(h);
  }
  intent.payoutHashInvalid =
    (Number.isInteger(intent.payoutHashInvalid) ? intent.payoutHashInvalid : 0) +
    (Number.isInteger(payout.invalid) ? payout.invalid : 0);
}

/* ── payment-intent record helpers ───────────────────────────────────── */

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const retryAfterSec = (untilMs, now) => Math.max(1, Math.ceil((untilMs - now) / 1000));

export function pushHistory(record, intentId, from, to, reason, ts) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push({ ts, intentId, from: from ?? null, to, reason: reason || null });
  if (record.history.length > MAX_HISTORY) {
    record.history.splice(0, record.history.length - MAX_HISTORY);
  }
}

/* The ONLY way an intent status changes: refused transitions leave the
   intent untouched, accepted ones append an audit-history entry and an
   intent_transition log line. */
function transition(record, intent, to, reason, ts, rid) {
  const t = applyTransition(intent, to, reason, ts);
  if (!t) return false;
  /* Crossing into the deposit/settlement family makes the observation
     permanent: from here on this intent can never be expired, no matter
     which state later failures park it in (reconcile() and the status
     path both consult depositObserved()). */
  if (to === "DEPOSIT_SEEN" || to === "SETTLING" || to === "SETTLED") {
    intent.depositObserved = true;
  }
  pushHistory(record, intent.intentId, t.from, t.to, reason, ts);
  logEvent("intent_transition", {
    rid, linkId: record.linkId, intentId: intent.intentId,
    from: t.from, to: t.to, reason,
  });
  return true;
}

async function save(storage, record, now) {
  record.updatedAt = now;
  try {
    await storage.put(RECORD_KEY, record);
  } catch {
    const err = new Error("persistence_failed");
    err.code = "persistence_failed";
    throw err;
  }
}

/* ── Phase 6: record integrity ─────────────────────────────────────────
   The persisted record is the ONLY thing this Worker acts on, so it is
   validated before it is served or acted upon. The checks are
   deliberately type/shape-level: they must accept every record Phases
   2–5 can legitimately produce (including minimal seeded fixtures and
   fields that are legitimately absent while an intent is CREATING) and
   refuse anything unreadable. Nothing here ever rewrites a fact — repair
   is an operator decision (OPERATIONS.md "record integrity"), never
   this code path's. */

/* Intent-level problems: null = usable for serving and acting. */
export function intentRecordProblem(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return "intent_invalid";
  /* An unreadable status is the critical case: it decides every
     transition, expiry and hold below — see quarantineStatus(). */
  if (typeof intent.status !== "string" || !INTERNAL_STATES.includes(intent.status)) return "status_invalid";
  const boundedStr = (v, max) =>
    v === undefined || v === null || (typeof v === "string" && v.length <= max);
  if (!boundedStr(intent.linkId, MAX_LINK_ID_LEN)) return "link_invalid";
  if (!boundedStr(intent.depositAddress, MAX_DEPOSIT_ADDRESS)) return "deposit_address_invalid";
  if (!boundedStr(intent.depositMemo, MAX_DEPOSIT_MEMO)) return "deposit_memo_invalid";
  if (!(intent.quoteDeadlineMs === undefined || intent.quoteDeadlineMs === null ||
        (typeof intent.quoteDeadlineMs === "number" && Number.isFinite(intent.quoteDeadlineMs)))) {
    return "quote_deadline_invalid";
  }
  if (!boundedStr(intent.merchant, 128)) return "merchant_invalid";
  /* Financial values: exact canonical base-unit integers only — anything
     else would poison BigInt arithmetic or a client-facing amount. */
  for (const key of ["invoiceAmount", "expectedInputAmount", "minInputAmount", "expectedOutputAmount"]) {
    const v = intent[key];
    if (v !== undefined && v !== null &&
        !(typeof v === "string" && v.length <= 80 && CANONICAL_UINT.test(v))) {
      return "amount_invalid";
    }
  }
  for (const key of ["source", "destination"]) {
    const v = intent[key];
    if (v !== undefined && v !== null &&
        (typeof v !== "object" || Array.isArray(v) ||
         typeof v.assetId !== "string" || !v.assetId || v.assetId.length > MAX_ASSET_ID)) {
      return "meta_invalid";
    }
  }
  if (!boundedStr(intent.correlationId, MAX_IDEMPOTENCY_KEY)) return "correlation_invalid";
  if (!boundedStr(intent.tidepoolStatus, 64)) return "tidepool_status_invalid";
  if (!boundedStr(intent.lastReason, 128)) return "reason_invalid";
  return null;
}

/* Record-level problems (audit + conflict bookkeeping): null = usable.
   These never block serving — statusBody/statusView already guard what
   they render, and verifyPayout holds on ANY truthy conflict — but they
   are stamped and logged so an operator sees them. */
export function recordLevelProblem(record) {
  if (record.history !== undefined && !Array.isArray(record.history)) return "history_invalid";
  const c = record.conflict;
  if (c !== undefined && c !== null &&
      (typeof c !== "object" || Array.isArray(c) ||
       typeof c.kind !== "string" || !c.kind || c.kind.length > 64)) {
    return "conflict_invalid";
  }
  return null;
}

/* Persist an integrity finding ONCE per distinct reason: the stamp is
   forensic (record.invalid never clears), the log line never floods, and
   a repeat finding costs no write and no line. */
async function stampInvalid(storage, record, intentId, reason, rid) {
  const fresh = !record.invalid || record.invalid.reason !== reason;
  if (!fresh) return false;
  const now = Date.now();
  record.invalid = { reason, at: now };
  logEvent("record_invalid", {
    level: "error", rid, linkId: record.linkId, intentId: intentId ?? null, reason,
  });
  await save(storage, record, now);
  return true;
}

/* A corrupt-but-recognized record HOLDS in place: no state change, no
   upstream call, no silent repair — 503 record_invalid with a bounded
   Retry-After. Such a record does NOT self-heal (an operator inspects
   it), so repeats answer identically: no re-log, no re-write. */
async function holdInvalid(env, storage, record, intentId, reason, rid) {
  await stampInvalid(storage, record, intentId, reason, rid);
  return respond(503, {
    error: "Payment record needs operator reconciliation; retry later",
    code: "record_invalid",
    retryAfterSec: Math.max(1, Math.ceil(ambiguousCooldownMs(env) / 1000)),
  });
}

/* An unreadable persisted STATUS: force-quarantine to RECONCILE — the
   state that means "needs reconciliation" — bypassing the transition
   table ON PURPOSE (it has no edge FROM an unreadable state, and
   inventing one would be a silent repair). History and intent_transition
   record what happened, the cooldown is persisted WITH the quarantine,
   and the request answers 503 record_invalid. From RECONCILE the normal
   reconcile path resolves against upstream truth — recovery never
   assumes the interrupted request's outcome, and never reaches VERIFIED
   without the full Phase 5 evidence path. */
async function quarantineStatus(env, storage, record, intent, problem, rid) {
  const now = Date.now();
  const from = typeof intent.status === "string" ? intent.status.slice(0, 64) : "[unreadable]";
  intent.status = "RECONCILE";
  intent.lastReason = "record_malformed";
  intent.reconcileUntil = now + ambiguousCooldownMs(env);
  pushHistory(record, intent.intentId, from, "RECONCILE", "record_malformed", now);
  logEvent("intent_transition", {
    rid, linkId: record.linkId, intentId: intent.intentId,
    from, to: "RECONCILE", reason: "record_malformed",
  });
  const fresh = !record.invalid || record.invalid.reason !== problem;
  record.invalid = { reason: problem, at: now };
  if (fresh) {
    logEvent("record_invalid", {
      level: "error", rid, linkId: record.linkId, intentId: intent.intentId, reason: problem,
    });
  }
  /* The state changed: persist unconditionally (even if this reason was
     already stamped — the quarantine itself must survive). */
  await save(storage, record, now);
  return respond(503, {
    error: "Payment record needs operator reconciliation; retry later",
    code: "record_invalid",
    retryAfterSec: retryAfterSec(intent.reconcileUntil, now),
  });
}

/* Client view of an intent: deposit instructions and verification facts,
   no signature, no internal bookkeeping (the signature stays server-side
   in the record — it is proof, not something the frontend can check). */
function publicIntent(i) {
  const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
  return {
    intentId: i.intentId,
    linkId: i.linkId,
    status: i.status,
    depositAddress: i.depositAddress,
    depositMemo: i.depositMemo ?? null,
    source: i.source,
    destination: i.destination,
    merchant: i.merchant,
    invoiceAmount: i.invoiceAmount,
    expectedInputAmount: i.expectedInputAmount,
    minInputAmount: i.minInputAmount,
    expectedOutputAmount: i.expectedOutputAmount,
    quoteDeadline: iso(i.quoteDeadlineMs),
    correlationId: i.correlationId,
    tidepoolStatus: i.tidepoolStatus,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
  };
}

/* ── Durable Object core: create-or-reuse, serialized per invoice ────── */

/* Resolve an existing active intent. Returns:
     {done:true,  response}  — answered without creating (reuse, cooldown,
                               or a blocking 409);
     {done:false}            — the old intent reached a NEW_INTENT_ALLOWED
                               state (or never existed): fall through and
                               create. */
async function resolveActive(env, storage, record, active, now, cooldownMs, rid) {
  /* Anything waiting on reconciliation inside its cooldown answers 503 +
     Retry-After — a status read in flight or recently failed must not be
     hammered, and must never be raced by a second live quote. */
  if ((active.status === "RECONCILE" || active.status === "UNKNOWN") &&
      typeof active.reconcileUntil === "number" && now < active.reconcileUntil) {
    return {
      done: true,
      response: respond(503, {
        error: "Payment status is being reconciled; retry later",
        code: "reconcile_cooldown",
        retryAfterSec: retryAfterSec(active.reconcileUntil, now),
      }),
    };
  }

  if (active.status === "CREATING") {
    /* In flight (another request queued behind us) or interrupted. Either
       way no deposit address was ever persisted, so nothing anyone could
       know has been funded — but the spec's cooldown still applies before
       a replacement is allowed. */
    const until = active.createdAt + cooldownMs;
    if (now < until) {
      return {
        done: true,
        response: respond(503, {
          error: "Quote creation is being reconciled; retry later",
          code: "reconcile_cooldown",
          retryAfterSec: retryAfterSec(until, now),
        }),
      };
    }
    transition(record, active, "FAILED", "creation_interrupted", now, rid);
    await save(storage, record, now);
    return { done: false };
  }

  if (active.status === "RECONCILE") {
    if (active.depositAddress) return reconcile(env, storage, record, active, now, cooldownMs, rid);
    /* No address persisted: the ambiguous creation produced nothing that
       ever left this server. After the cooldown the intent is closed as
       abandoned and a fresh quote may proceed. */
    transition(record, active, "FAILED", "creation_abandoned", now, rid);
    await save(storage, record, now);
    return { done: false };
  }

  if (active.status === "UNKNOWN") return reconcile(env, storage, record, active, now, cooldownMs, rid);

  /* An active intent past its deadline: reconcile against Tidepool BEFORE
     anything can create a second deposit address. */
  if (typeof active.quoteDeadlineMs === "number" && now >= active.quoteDeadlineMs) {
    return reconcile(env, storage, record, active, now, cooldownMs, rid);
  }

  /* Active and valid: one intent per invoice — every request gets the
     SAME deposit instructions (200 reused), whatever idempotency key or
     asset it arrived with. */
  return {
    done: true,
    response: respond(200, {
      ok: true, reused: true,
      intent: publicIntent(active),
      onChainStatus: record.onChainStatus,
    }),
  };
}

/* One Tidepool status read for an active/uncertain intent. Resolves to a
   real state, or to RECONCILE/UNKNOWN + cooldown — an uncertain deposit
   NEVER permits a second address. */
async function reconcile(env, storage, record, intent, now, cooldownMs, rid) {
  /* The cooldown clock must be PERSISTED together with the state it
     protects: set reconcileUntil FIRST, then save, then answer. A 503
     whose Retry-After evaporates on the next read would let the very next
     request hammer a dead upstream. Phase 6: an upstream Retry-After
     (parsed and clamped by parseRetryAfter) is honoured ON TOP of our
     own cooldown — max(own, upstream), exactly like the status path has
     done since Phase 4 — so a 429 from Tidepool can never be undercut
     by a shorter local cooldown. */
  const startCooldown = (upstreamRetryAfterMs) => {
    intent.reconcileUntil = Date.now() +
      Math.max(cooldownMs, Number(upstreamRetryAfterMs) || 0);
  };
  const cooldown = (code, message) =>
    respond(503, { error: message, code, retryAfterSec: retryAfterSec(intent.reconcileUntil, Date.now()) });
  /* The canonical "this intent, its instructions, right now" answer. */
  const reused = () => ({
    done: true,
    response: respond(200, {
      ok: true, reused: true,
      intent: publicIntent(intent),
      onChainStatus: record.onChainStatus,
    }),
  });

  if (!intent.depositAddress) {
    /* Defensive: an addressless intent cannot be queried. Hold the line
       (503) rather than guess. */
    if (intent.status !== "RECONCILE") transition(record, intent, "RECONCILE", "no_deposit_address", now, rid);
    startCooldown();
    await save(storage, record, now);
    return { done: true, response: cooldown("reconcile_cooldown", "Payment status is being reconciled; retry later") };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tidepoolTimeoutMs(env));
  let res;
  try {
    res = await queryStatus(env, intent.depositAddress, intent.depositMemo, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (res.kind !== "ok") {
    if (intent.status !== "RECONCILE") {
      transition(record, intent, "RECONCILE", `status_query_${res.kind}`, Date.now(), rid);
    }
    intent.lastError = res.kind;
    startCooldown(res.retryAfterMs);
    await save(storage, record, Date.now());
    logEvent("quote_upstream_error", {
      level: "error", rid, linkId: record.linkId, target: "status",
      kind: res.kind, status: res.status, detail: res.detail,
    });
    return { done: true, response: cooldown("reconcile_cooldown", "Payment status could not be read; retry later") };
  }

  const mapped = mapTidepoolStatus(res.status);
  if (!mapped.ok) {
    /* Unknown status string: record the raw value, move the internal state
       to UNKNOWN (honest: we do not know), and refuse with 503 — never
       invent an interpretation. */
    if (intent.status !== "UNKNOWN") transition(record, intent, "UNKNOWN", "unmapped_status", Date.now(), rid);
    intent.tidepoolStatus = res.status.slice(0, 64);
    intent.lastError = "unmapped_status";
    startCooldown();
    await save(storage, record, Date.now());
    logEvent("quote_upstream_error", {
      level: "warn", rid, linkId: record.linkId, target: "status",
      kind: "unmapped_status", status: res.status.slice(0, 64),
    });
    return { done: true, response: cooldown("status_unknown", "Tidepool reported an unrecognized payment status") };
  }

  intent.tidepoolStatus = res.status;
  intent.tidepoolStatusUpdatedAt = res.updatedAt || null;
  /* Phase 5: same candidate capture as the status path — a reconcile
     that lands SETTLED must leave its evidence for the next poll. */
  mergePayoutHashes(intent, res.payout);

  if (mapped.target === null) {
    /* PENDING_DEPOSIT: Tidepool has no EXPIRED status — past OUR deadline
       with no observed deposit the docs say to stop and request a new
       quote, which is exactly the EXPIRED transition; before the deadline
       it simply keeps waiting. depositObserved() gates the expiry: a
       deposit outranks a lapsed deadline even when an earlier failure
       parked the intent in RECONCILE/UNKNOWN (Phase 4: DEPOSIT_SEEN must
       never be incorrectly expired — the transition table alone cannot
       see a deposit that was observed before the park). */
    if (typeof intent.quoteDeadlineMs === "number" && Date.now() >= intent.quoteDeadlineMs &&
        !depositObserved(intent)) {
      const expired = transition(record, intent, "EXPIRED", "no_deposit_past_deadline", Date.now(), rid);
      await save(storage, record, Date.now());
      /* Belt and braces: if the table still refused the move, keep THIS
         intent and its instructions; a second deposit address must never
         open over an observed deposit. */
      if (!expired) return reused();
      return { done: false };
    }
    if (intent.status === "RECONCILE" || intent.status === "UNKNOWN") {
      /* A definite upstream answer ends the uncertainty. With no deposit
         ever observed that is AWAITING_DEPOSIT; with one on record the
         honest state is DEPOSIT_SEEN — AWAITING_DEPOSIT would claim
         nothing was seen. */
      transition(record, intent, depositObserved(intent) ? "DEPOSIT_SEEN" : "AWAITING_DEPOSIT",
        "status_resolved", Date.now(), rid);
    }
    await save(storage, record, Date.now());
    return reused();
  }

  const target = mapped.target;
  if (intent.status === target) {
    /* Duplicate external status (e.g. KNOWN_DEPOSIT_TX read twice): the
       state machine's from===to refusal is a no-op, not an error — the
       answer is still this intent's instructions. External facts above
       (tidepoolStatus / updatedAt) are persisted with it. */
    await save(storage, record, Date.now());
  } else {
    const moved = transition(record, intent, target, `tidepool_${res.status}`, Date.now(), rid);
    if (!moved) {
      /* The state machine refused the move (a regression the table does
         not permit). External status is recorded; internal state is left
         alone; the caller is told the state is unknown — never guessed. */
      startCooldown();
      await save(storage, record, Date.now());
      return { done: true, response: cooldown("status_unknown", "Payment state could not be reconciled") };
    }
    await save(storage, record, Date.now());
  }

  if (target === "DEPOSIT_SEEN" || target === "SETTLING") {
    /* A deposit (or settlement) already observed stays attached to THIS
       intent: return its instructions, never a second address. */
    return reused();
  }
  if (target === "SETTLED") {
    /* Tidepool SUCCESS: settlement happened externally, verification has
       not — no new intent, and definitely not VERIFIED. */
    return {
      done: true,
      response: respond(409, {
        error: "Tidepool reported settlement; awaiting independent verification",
        code: "payment_settled",
      }),
    };
  }
  /* REFUNDED / FAILED: terminal, the money went back — a new attempt may
     start as a new intent. */
  return { done: false };
}

/* ═══════════════════════════════════════════════════════════════════════
 * Phase 4 — GET /status: deposit tracking + transaction reconciliation.
 *
 * One request performs at most ONE contract read + ONE /v0/status read,
 * only for a non-terminal intent that is outside its reconcile cooldown,
 * past the 2–5 s poll floor and inside 24 h of its quote deadline. The
 * browser never supplies an upstream fact: the stored record's own
 * deposit address is the only address queried, and possession of the
 * intentId is the read capability. There is no background loop — the
 * client drives, this Worker bounds.
 * ═══════════════════════════════════════════════════════════════════════ */

/* The seven documented Tidepool statuses (docs/concepts/status-lifecycle)
   — the ONLY upstream values this Worker ever surfaces. Anything else
   (including a raw value stored during an UNKNOWN park) reads back as
   null: an unrecognised status is never presented as if it were real. */
const TIDEPOOL_STATUSES = new Set(Object.keys(TIDEPOOL_STATE_MAP));

const iso = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);

/* Safe client view: identity, state and clocks — nothing else. No
   deposit address, no depositMemo, no signature, no correlation id, no
   swapDetails / tx hashes, no history, no raw upstream body. */
function statusView(intent) {
  return {
    intentId: intent.intentId,
    linkId: intent.linkId,
    status: intent.status,
    tidepoolStatus: TIDEPOOL_STATUSES.has(intent.tidepoolStatus) ? intent.tidepoolStatus : null,
    quoteDeadline: iso(intent.quoteDeadlineMs),
    lastReason: intent.lastReason ?? null,
    createdAt: iso(intent.createdAt),
    updatedAt: iso(intent.updatedAt),
  };
}

/* The 200 body: the view plus record-level facts the client may need —
   the last authoritative invoice state (with when we last checked it)
   and the cross-provider conflict flag, both already stored server-side. */
function statusBody(record, intent, changed) {
  return {
    ok: true,
    intent: statusView(intent),
    onChainStatus: typeof record.onChainStatus === "string" ? record.onChainStatus : null,
    onChainStatusCheckedAt: iso(record.onChainCheckedAt),
    conflict: record.conflict && typeof record.conflict.kind === "string" ? record.conflict.kind : null,
    changed,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * Phase 5 — independent payout verification (SETTLED -> VERIFIED).
 *
 * Tidepool's SUCCESS (SETTLED) is an EXTERNAL claim, never proof: the
 * merchant counts as paid only when authoritative NEAR transaction
 * evidence shows it. A verification cycle — a GET /status poll that
 * ENTERS with SETTLED and captured payout-hash candidates — runs, in
 * order:
 *
 *   1. stored-conflict hold — a recorded invoice_paid / double_payout /
 *      payout_reversed conflict means zero reads and no auto-verify,
 *      ever (manual reconciliation only);
 *   2. malformed-candidate hold — a candidate hash that fails NEAR
 *      validation blocks verification before any read (it might be the
 *      payout we have not seen);
 *   3. evidence — every captured hash is fetched from a NEAR node
 *      (tx_status with failover, classified: pending / malformed /
 *      inconclusive). The receipts must show EXACTLY ONE successful
 *      ft_transfer executed on the configured USDC token contract, to
 *      the merchant, for exactly the invoice amount (integer base-unit
 *      comparison), with function-call args and the NEP-297 event
 *      agreeing when both are present. A wrong receiver, a wrong
 *      amount, a failed or unprovable transfer, a transfer FROM the
 *      merchant (reversal) or a second payout (double pay) all HOLD;
 *   4. a FRESH get_link immediately before the transition — the invoice
 *      must still be OPEN (PAID/CLAIMED is the cross-provider race:
 *      record/preserve invoice_paid and hold for manual reconciliation),
 *      and the contract's merchant / amount / token must equal this
 *      intent's stored facts (BigInt equality on the amount);
 *   5. only then: SETTLED -> VERIFIED, the transition table's only exit.
 *
 * Every hold persists its reason (logged once per distinct reason —
 * reason codes only, never a hash, amount or address), backs off the
 * next attempt (TIDEPOOL_VERIFY_BACKOFF_MS, doubling to the 1 h cap)
 * and answers 200 from the record: unknown / malformed / incomplete /
 * contradictory evidence NEVER becomes VERIFIED, and every hold is
 * retryable — nothing is refunded, cancelled or forced. Candidates come
 * from this Worker's own Tidepool reads and are FETCHED from the node,
 * never believed; browser input is not an evidence source anywhere.
 * ═══════════════════════════════════════════════════════════════════════ */

/* NEAR outcome status shapes in the wild: modern objects
   ({"SuccessValue":""} / {"SuccessReceiptId":…} / {"Failure":…}) and the
   legacy bare strings ("SuccessValue" / "Failure"). Anything else —
   including a MISSING outcome — is "unknown": never counted as success. */
function receiptStatusClass(s) {
  if (s === null || s === undefined) return "unknown";
  if (typeof s === "string") {
    if (s === "Failure") return "failed";
    if (s === "SuccessValue" || s === "SuccessReceiptId") return "success";
    return "unknown";
  }
  if (typeof s === "object") {
    if ("Failure" in s) return "failed";
    if ("SuccessValue" in s || "SuccessReceiptId" in s) return "success";
  }
  return "unknown";
}

function b64text(s) {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/* ft_transfer args: {receiver_id, amount, memo} — receiver and canonical
   base-unit amount are mandatory; anything else is malformed evidence. */
function parseFtTransferArgs(raw) {
  const text = typeof raw === "string" ? b64text(raw) : null;
  if (text === null) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const receiver = typeof obj.receiver_id === "string" ? obj.receiver_id : "";
  const amount = typeof obj.amount === "string" ? obj.amount : "";
  if (!receiver || !CANONICAL_UINT.test(amount)) return null;
  try { if (BigInt(amount) <= 0n) return null; } catch { return null; }
  return { receiver, amount };
}

/* The NEP-297 event that corroborates a transfer, when the token logged
   one: returns {from, to, amount}, {matched:false} when an nep141
   ft_transfer event exists but is unusable (malformed evidence), or
   null when this receipt carries no such event (events are corroboration,
   not a requirement — args remain the primary claim). */
function findFtTransferEvent(logs) {
  if (!Array.isArray(logs)) return null;
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
    let ev;
    try { ev = JSON.parse(line.slice("EVENT_JSON:".length)); } catch { continue; }
    if (!ev || typeof ev !== "object" || ev.standard !== "nep141" || ev.event !== "ft_transfer") continue;
    const d = Array.isArray(ev.data) ? ev.data[0] : null;
    const to = d && typeof d === "object" && typeof d.new_owner_id === "string" ? d.new_owner_id : "";
    const amount = d && typeof d === "object" && typeof d.amount === "string" ? d.amount : "";
    const from = d && typeof d === "object" && typeof d.old_owner_id === "string" ? d.old_owner_id : "";
    if (!to || !CANONICAL_UINT.test(amount)) return { matched: false };
    return { matched: true, from, to, amount };
  }
  return null;
}

/* The receipt list from tx_status: [{receipt_id, predecessor_id,
   receiver_id, receipt:{Action:{actions}}}] joined to receipts_outcome
   by id. nearcore OMITS the first (transaction) receipt when
   signer_id === receiver_id — documented behaviour — so that receipt is
   synthesized from transaction (its actions) + transaction_outcome (its
   outcome); every other shape problem returns null (malformed). */
function collectTxReceipts(res) {
  if (!res || typeof res !== "object") return null;
  const tx = res.transaction;
  const txOut = res.transaction_outcome;
  if (!tx || typeof tx !== "object" || !Array.isArray(res.receipts)) return null;
  const list = res.receipts.slice();
  const txOutId = txOut && typeof txOut === "object" && typeof txOut.id === "string" ? txOut.id : null;
  if (txOutId && !list.some((r) => r && r.receipt_id === txOutId) &&
      typeof tx.signer_id === "string" && tx.signer_id === tx.receiver_id) {
    list.unshift({
      receipt_id: txOutId,
      predecessor_id: tx.signer_id,
      receiver_id: typeof tx.receiver_id === "string" ? tx.receiver_id : "",
      receipt: { Action: { actions: Array.isArray(tx.actions) ? tx.actions : [] } },
    });
  }
  return list;
}

/* One transaction's contribution to the verdict. Every ft_transfer
   executed ON the configured token contract is examined; receipts on
   other contracts are ignored — the settlement transaction moves
   several tokens and runs dip4 ledger moves (nep245 events live in the
   verifier's own receipt, which is not a token receipt), none of which
   is this invoice's payout claim. Each examined transfer is classified
   against the invoice facts:
     payout   — success, to the merchant, exact amount, NOT from the merchant
     reversal — success, FROM the merchant, exact amount (funds left)
     mismatch — success but wrong receiver / wrong amount / self-transfer
     failed   — the receipt failed (moved nothing)
     unknown  — the receipt's outcome is missing or unrecognisable
   An args-vs-event disagreement is malformed evidence (a data-integrity
   failure, not a payment fact). */
function scanTxForTransfers(res, expect, out) {
  const receipts = collectTxReceipts(res);
  if (!receipts) { out.malformed++; return; }
  const outcomes = new Map();
  if (Array.isArray(res.receipts_outcome)) {
    for (const o of res.receipts_outcome) if (o && typeof o.id === "string") outcomes.set(o.id, o);
  }
  const txOutId = res.transaction_outcome && typeof res.transaction_outcome.id === "string"
    ? res.transaction_outcome.id : null;
  for (const r of receipts) {
    if (!r || typeof r !== "object" || r.receiver_id !== DEST_TOKEN) continue;
    const rc = r.receipt;
    const actions = rc && typeof rc === "object" && rc.Action && Array.isArray(rc.Action.actions)
      ? rc.Action.actions : null;
    if (!actions) continue;                       // not an action receipt: no transfer of ours
    for (const a of actions) {
      if (!a || typeof a !== "object") continue;
      const fc = a.FunctionCall;
      if (!fc || typeof fc !== "object" || fc.method_name !== "ft_transfer") continue;
      const args = parseFtTransferArgs(fc.args);
      if (!args) { out.malformed++; continue; }
      const outcome = outcomes.get(r.receipt_id) ||
        (txOutId && r.receipt_id === txOutId ? res.transaction_outcome : null);
      const oOutcome = outcome && typeof outcome === "object" && outcome.outcome ? outcome.outcome : null;
      const cls = receiptStatusClass(oOutcome ? oOutcome.status : undefined);
      const ev = findFtTransferEvent(oOutcome ? oOutcome.logs : null);
      if (ev && ev.matched === false) { out.malformed++; continue; }   // unusable event: malformed
      if (ev && (ev.to !== args.receiver || ev.amount !== args.amount)) {
        out.malformed++;                                               // args and event disagree
        continue;
      }
      out.transfers.push({
        to: args.receiver,
        amount: args.amount,
        /* who was debited: the NEP-297 old_owner when the token logged
           one, else the receipt's predecessor (who initiated it) */
        from: ev && ev.from ? ev.from
          : (typeof r.predecessor_id === "string" ? r.predecessor_id : ""),
        status: cls,
      });
    }
  }
}

/* Integer base-unit classification of every examined transfer against
   the invoice's (merchant, amount). Amounts are canonical decimal
   strings (validated on entry) compared as BigInt — never floats. */
function classifyTransfers(transfers, expect) {
  const v = { payouts: 0, reversal: 0, mismatch: 0, failed: 0, unknown: 0 };
  let want;
  try { want = BigInt(expect.amount); } catch { return null; }
  for (const t of transfers) {
    if (t.status === "unknown") { v.unknown++; continue; }
    if (t.status === "failed") { v.failed++; continue; }
    let got;
    try { got = BigInt(t.amount); } catch { v.mismatch++; continue; }
    if (t.from === expect.merchant && got === want && t.to !== expect.merchant) v.reversal++;
    else if (t.to === expect.merchant && got === want && t.from !== expect.merchant) v.payouts++;
    else v.mismatch++;
  }
  return v;
}

/* Fetch every candidate hash and classify what the nodes answer.
   unknown_transaction = delayed visibility (retryable), malformed_request
   = the node refused our hash (definitive), everything else that is not
   a usable result = an inconclusive read (retryable). */
async function gatherPayoutEvidence(env, hashes, expect) {
  const out = { transfers: [], pending: 0, malformed: 0, inconclusive: 0, v: null };
  for (const h of hashes) {
    const r = await nearTxStatus(env, h);
    if (r.kind === "ok") { scanTxForTransfers(r.value, expect, out); continue; }
    if (r.kind === "unknown_transaction") out.pending++;
    else if (r.kind === "malformed_request") out.malformed++;
    else out.inconclusive++; // rpc_error / timeout / transport / bad_shape: no result is NO proof
  }
  out.v = classifyTransfers(out.transfers, expect);
  return out;
}

async function verifyPayout(env, storage, record, intent, rid) {
  const intentId = intent.intentId;
  const linkId = record.linkId;

  /* One hold: a persisted reason (logged once per distinct reason),
     for an attempted verification a backoff deadline, and an honest 200
     answered from the record. Nothing here ever transitions state. */
  const persistHold = async (reason, isAttempt) => {
    const first = intent.payoutHoldReason !== reason;
    intent.payoutHoldReason = reason;
    if (isAttempt) {
      const prior = Number.isInteger(intent.verifyAttempts) ? intent.verifyAttempts : 0;
      intent.verifyUntil = Date.now() + verifyBackoffDelayMs(env, prior);
      intent.verifyAttempts = prior + 1;
    }
    if (first) {
      logEvent("payout_verify_hold", {
        level: "warn", rid, linkId, intentId, reason,
      });
    }
    if (first || isAttempt) await save(storage, record, Date.now());
    return respond(200, statusBody(record, intent, false));
  };

  /* ── 1. stored conflict: never auto-verify a conflicted intent ──
     Zero reads: a conflict already recorded on this invoice (detected
     by any earlier cycle, on any intent) is the answer until an
     operator reconciles. This gate only BLOCKS — the fresh read below
     still re-checks the invoice on every attempt that gets that far. */
  if (record.conflict) {
    const kind = typeof record.conflict.kind === "string" ? record.conflict.kind : "invoice_conflict";
    return persistHold(kind, false);
  }

  /* ── 2. malformed candidates block before any read ──
     A candidate that fails NEAR-hash validation might be the payout we
     have not seen: verification stays closed until reconciliation. */
  if ((Number.isInteger(intent.payoutHashInvalid) ? intent.payoutHashInvalid : 0) > 0) {
    return persistHold("evidence_malformed", true);
  }

  const expect = { merchant: intent.merchant, amount: intent.invoiceAmount };
  if (typeof expect.merchant !== "string" || !expect.merchant ||
      typeof expect.amount !== "string" || !CANONICAL_UINT.test(expect.amount)) {
    return persistHold("invoice_mismatch", true);  // stored invoice facts unusable: fail closed
  }
  const hashes = Array.isArray(intent.payoutHashes) ? intent.payoutHashes : [];
  if (hashes.length === 0) return persistHold("no_payout_hash", true);

  /* ── 3. evidence from the nodes ── */
  const ev = await gatherPayoutEvidence(env, hashes, expect);
  if (!ev.v) return persistHold("invoice_mismatch", true);

  /* Proven conflicts first: a fact read from ANY hash outranks a read
     problem on another one (it would still be true after a retry). */
  if (ev.v.reversal > 0 || ev.v.payouts >= 2) {
    const kind = ev.v.reversal > 0 ? "payout_reversed" : "double_payout";
    record.conflict = {
      kind, onChainStatus: record.onChainStatus, detectedAt: Date.now(),
    };
    logEvent("payout_conflict", { level: "error", rid, linkId, intentId, kind });
    return persistHold(kind, true);
  }
  /* Read-quality gates, proven-problems first. */
  if (ev.v.mismatch > 0) return persistHold("evidence_mismatch", true);
  if (ev.malformed > 0) return persistHold("evidence_malformed", true);
  if (ev.inconclusive > 0) return persistHold("rpc_inconclusive", true);
  if (ev.pending > 0) return persistHold("evidence_pending", true);
  if (ev.v.payouts !== 1) {
    if (ev.v.failed > 0) return persistHold("transfer_failed", true);
    if (ev.v.unknown > 0) return persistHold("evidence_pending", true);
    return persistHold("no_transfer_evidence", true);
  }
  /* Exactly one clean payout proven — now the invoice must authorize it. */

  /* ── 4. FRESH contract read, immediately before the transition ──
     Everything from here to the transition is synchronous: the invoice
     state that authorizes VERIFIED is the freshest observable, and the
     DO's single-threadedness means no other event can interleave. */
  const rpcCtl = new AbortController();
  const rpcTimer = setTimeout(() => rpcCtl.abort(), tidepoolTimeoutMs(env));
  let lr;
  try {
    lr = await getLink(env, intent.linkId, rpcCtl.signal);
  } finally {
    clearTimeout(rpcTimer);
  }
  if (lr.kind !== "ok") return persistHold("contract_inconclusive", true);
  const link = normalizeLink(lr.value, record.linkId);
  if (!link) return persistHold("contract_inconclusive", true);

  const checkedAt = Date.now();
  const previous = record.onChainStatus;
  record.onChainStatus = link.status;
  record.onChainCheckedAt = checkedAt;

  if (link.status === "PAID" || link.status === "CLAIMED") {
    /* The cross-provider race, closed: the invoice settled on the NEAR
       rail after the last Phase 4 poll — or between that poll and this
       fresh read. Record/preserve the conflict, log it once in the
       Phase 4 shape, hold for manual reconciliation: never verify. */
    if (!record.conflict) {
      record.conflict = { kind: "invoice_paid", onChainStatus: link.status, detectedAt: checkedAt };
      logEvent("invoice_conflict", {
        level: "error", rid, linkId, intentId,
        previous, onChainStatus: link.status,
      });
    }
    return persistHold("invoice_paid", true);
  }

  /* Stored facts vs fresh contract: merchant, amount (BigInt), token —
     the evidence above was checked against these same stored facts, so
     equality here makes the whole chain authoritative. */
  const amountMatches = CANONICAL_UINT.test(intent.invoiceAmount || "") &&
    BigInt(intent.invoiceAmount) === BigInt(link.amount);
  if (link.creator !== intent.merchant || !amountMatches ||
      link.token !== DEST_TOKEN ||
      !intent.destination || intent.destination.assetId !== DEST_ASSET) {
    return persistHold("invoice_mismatch", true);
  }

  /* ── 5. every check passed: the only exit of SETTLED ── */
  intent.payoutHoldReason = null;
  intent.verifyUntil = null;
  const attempts = Number.isInteger(intent.verifyAttempts) ? intent.verifyAttempts : 0;
  intent.verifyAttempts = 0;
  const moved = transition(record, intent, "VERIFIED", "payout_verified", Date.now(), rid);
  if (!moved) return persistHold("transition_refused", true); // can't happen under the DO; fail closed anyway
  await save(storage, record, Date.now());
  logEvent("payout_verify_ok", { rid, linkId, intentId, attempts });
  return respond(200, statusBody(record, intent, true));
}

/* ── Phase 6: one authoritative contract refresh, shared ───────────────
   Reads get_link, updates record.onChainStatus / onChainCheckedAt and
   RECORDS (never clears) an invoice_paid conflict — which is persisted
   IMMEDIATELY, before this function returns, so a Worker/DO interruption
   can never lose a conflict we already detected (persist-before-complete;
   the invoice_conflict log line always has a record to match it). A
   failed read keeps the last known state and does NOT advance
   onChainCheckedAt, so every consumer honestly sees how stale our
   contract knowledge is. Returns the link status, or null. */
async function refreshInvoice(env, storage, record, intent, rid) {
  const rpcCtl = new AbortController();
  const rpcTimer = setTimeout(() => rpcCtl.abort(), tidepoolTimeoutMs(env));
  let lr;
  try {
    lr = await getLink(env, intent.linkId, rpcCtl.signal);
  } finally {
    clearTimeout(rpcTimer);
  }
  if (lr.kind !== "ok") {
    logEvent("status_upstream_error", {
      level: "warn", rid, linkId: record.linkId, intentId: intent.intentId,
      target: "contract", kind: lr.kind, status: lr.status,
    });
    return null;
  }
  const link = normalizeLink(lr.value, record.linkId);
  if (!link) {
    logEvent("status_upstream_error", {
      level: "warn", rid, linkId: record.linkId, intentId: intent.intentId,
      target: "contract", kind: "bad_shape",
    });
    return null;
  }
  const checkedAt = Date.now();
  const previous = record.onChainStatus;
  record.onChainStatus = link.status;
  record.onChainCheckedAt = checkedAt;
  if ((link.status === "PAID" || link.status === "CLAIMED") && !record.conflict) {
    /* OPEN -> PAID/CLAIMED while a Tidepool intent is in flight: both
       rails may be paying the merchant. Detected once, logged once at
       level error, persisted right here, surfaced as conflict on EVERY
       response from now on — and NEVER cleared (an earlier conflict is
       evidence, not state to overwrite). Observation continues, because
       only observing the Tidepool leg tells us whether the double pay
       actually happened; nothing in this Worker can stop that leg
       (quote swaps have no cancel API — probed live; only the deadline
       refund exists). */
    record.conflict = { kind: "invoice_paid", onChainStatus: link.status, detectedAt: checkedAt };
    logEvent("invoice_conflict", {
      level: "error", rid, linkId: record.linkId, intentId: intent.intentId,
      previous, onChainStatus: link.status,
    });
    await save(storage, record, checkedAt);
  }
  return link.status;
}

async function handleStatus(env, storage, payload) {
  const now = Date.now();
  const rid = typeof payload.rid === "string" ? payload.rid : undefined;

  let record;
  try {
    record = await storage.get(RECORD_KEY);
  } catch {
    return respond(500, { error: "Intent store read failed", code: "persistence_failed" });
  }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      !Array.isArray(record.intents) || record.linkId !== payload.linkId) {
    return respond(404, { error: "Payment intent not found", code: "intent_not_found" });
  }
  /* Capability check: the intentId must belong to THIS invoice's record.
     linkId only routed us here — an id from another invoice, an old id
     or an invented id all get the same 404, so ids cannot be probed. */
  const intent = record.intents.find((i) => i && i.intentId === payload.intentId) || null;
  if (!intent) {
    return respond(404, { error: "Payment intent not found", code: "intent_not_found" });
  }

  /* Phase 6: validate BEFORE serving or acting. A record we cannot read
     is never read as a state it might not be in: an unreadable status
     is quarantined into RECONCILE (503 record_invalid), a corrupt field
     holds the intent in place (503 record_invalid), and record-level
     corruption (history / conflict) is stamped + logged without changing
     state — verifyPayout's truthy-conflict hold keeps a malformed
     conflict blocking, so nothing here can slip toward VERIFIED. */
  const recProblem = recordLevelProblem(record);
  if (recProblem) await stampInvalid(storage, record, intent.intentId, recProblem, rid);
  const itProblem = intentRecordProblem(intent);
  if (itProblem === "status_invalid") {
    return quarantineStatus(env, storage, record, intent, itProblem, rid);
  }
  if (itProblem) return holdInvalid(env, storage, record, intent.intentId, itProblem, rid);

  /* Terminal (docs: stop on SUCCESS / REFUNDED / FAILED — plus our
     VERIFIED and EXPIRED): answer from the record with ZERO upstream
     reads, from now on. Nothing can change here, so changed is false.
     Phase 5 carve-out: a SETTLED intent that still holds payout-hash
     candidates is NOT finished — it falls through to the verification
     path below (NEAR evidence + one fresh get_link; never a Tidepool
     re-read — docs say stop on SUCCESS). A SETTLED intent WITHOUT
     candidates can never be independently verified: hold it here with
     zero reads and say so once (reason codes only). */
  const pendingVerification = intent.status === "SETTLED" &&
    ((Array.isArray(intent.payoutHashes) && intent.payoutHashes.length > 0) ||
     (Number.isInteger(intent.payoutHashInvalid) && intent.payoutHashInvalid > 0));
  if (POLLING_TERMINAL.has(intent.status) && !pendingVerification) {
    if (intent.status === "SETTLED") {
      /* Phase 6: a held SETTLED keeps watching the INVOICE — contract
         reads only, at most once per HOLD_CONTRACT_REFRESH_MS, never a
         Tidepool re-read (docs: stop on SUCCESS) and never a tx read
         (this branch verifies nothing). This is how an invoice_paid
         conflict is still detected AFTER polling stopped; a fresh
         record.onChainCheckedAt keeps the Phase 4/5 zero-read contract
         byte-identical for a fresh record. */
      const stale = typeof record.onChainCheckedAt !== "number" ||
        Date.now() - record.onChainCheckedAt >= HOLD_CONTRACT_REFRESH_MS;
      if (stale) await refreshInvoice(env, storage, record, intent, rid);
      const holdReason = record.conflict && typeof record.conflict.kind === "string"
        ? record.conflict.kind : "no_payout_hash";
      const reasonChanged = intent.payoutHoldReason !== holdReason;
      if (reasonChanged) {
        intent.payoutHoldReason = holdReason;
        logEvent("payout_verify_hold", {
          level: "warn", rid, linkId: record.linkId, intentId: intent.intentId,
          reason: holdReason,
        });
      }
      /* Persist the refreshed contract state (and/or the new hold
         reason) so the next hold is served from the record. */
      if (reasonChanged || stale) await save(storage, record, Date.now());
    }
    return respond(200, statusBody(record, intent, false));
  }

  /* Backoff after a failed or unrecognised read: 503 + Retry-After, no
     reads. reconcileUntil was persisted together with the failure it
     protects (same rule as resolveActive). */
  if ((intent.status === "RECONCILE" || intent.status === "UNKNOWN") &&
      typeof intent.reconcileUntil === "number" && now < intent.reconcileUntil) {
    return respond(503, {
      error: "Payment status is being reconciled; retry later",
      code: "reconcile_cooldown",
      retryAfterSec: retryAfterSec(intent.reconcileUntil, now),
    });
  }

  /* Nothing addressable to query (CREATING in flight, or an ambiguous
     creation that never produced an address): answer from the record.
     No upstream call can be steered by browser input here either. */
  if (!intent.depositAddress) {
    return respond(200, statusBody(record, intent, false));
  }

  /* Duplicate / rapid polling: inside the documented 2–5 s window the
     record already IS the freshest answer this Worker will give — zero
     upstream calls. lastStatusPollAt is persisted BEFORE the reads
     below, so a request interleaving while this one waits on the
     upstream sees the stamp and stands down (prevents overlapping
     cycles and duplicate transitions). */
  const minInterval = statusMinIntervalMs(env);
  if (typeof intent.lastStatusPollAt === "number" && now - intent.lastStatusPollAt < minInterval) {
    return respond(200, statusBody(record, intent, false));
  }

  /* Phase 5 attempt backoff: a held verification waits out its window
     with zero reads — the record (including any conflict) IS the answer
     until the next attempt is due. */
  if (pendingVerification && typeof intent.verifyUntil === "number" && now < intent.verifyUntil) {
    return respond(200, statusBody(record, intent, false));
  }

  /* Docs: Tidepool stops watching a deposit address 24 h after the
     quote deadline — we stop asking at the same point. The record keeps
     its last known state; a later POST /quote still reconciles it
     through reconcile() if a new attempt is ever wanted. */
  if (typeof intent.quoteDeadlineMs === "number" && now >= intent.quoteDeadlineMs + POLL_WATCH_LIMIT_MS) {
    return respond(200, statusBody(record, intent, false));
  }

  /* ── one poll cycle ──────────────────────────────────────────────────
     Stamp FIRST and persist it: the DO input gates hold delivery during
     this write, and any request arriving while we wait on the upstream
     reads the stamp and is throttled to the record above. */
  intent.lastStatusPollAt = now;
  await save(storage, record, now);

  /* ── Phase 5: this cycle's ONE job is verification ──
     Entered with SETTLED + captured candidates: gather the NEAR payout
     evidence, re-read the invoice fresh, and either make the machine's
     only SETTLED exit or hold (persisted reason + backoff). The
     Tidepool status leg is deliberately NOT read again — docs: stop on
     SUCCESS — so this branch never calls queryStatus. */
  if (pendingVerification) {
    return verifyPayout(env, storage, record, intent, rid);
  }

  /* Contract re-read — the cross-provider race detector (Phase 4 §5),
     now the shared refreshInvoice (Phase 6): every non-terminal cycle
     refreshes the authoritative invoice state, a detected conflict is
     persisted immediately, and a failure here is logged while keeping
     the last known state — it never fails the status response (the
     Tidepool leg is what this endpoint is for), and onChainCheckedAt is
     NOT advanced, so the response honestly shows how stale our contract
     knowledge is. */
  await refreshInvoice(env, storage, record, intent, rid);

  /* ── the one Tidepool status read ── */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tidepoolTimeoutMs(env));
  let res;
  try {
    res = await queryStatus(env, intent.depositAddress, intent.depositMemo, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (res.kind !== "ok") {
    /* Transport failure, 5xx, 404 (this address unknown to Tidepool —
       still OUR stored address, never a browser-supplied one): park in
       RECONCILE with a persisted cooldown that honours any upstream
       Retry-After, then answer 503. Never a guess. */
    if (intent.status !== "RECONCILE") {
      transition(record, intent, "RECONCILE", `status_query_${res.kind}`, Date.now(), rid);
    }
    intent.lastError = res.kind;
    intent.reconcileUntil = Date.now() + Math.max(ambiguousCooldownMs(env), res.retryAfterMs || 0);
    await save(storage, record, Date.now());
    logEvent("status_upstream_error", {
      level: "error", rid, linkId: record.linkId, intentId: intent.intentId,
      target: "status", kind: res.kind, status: res.status,
    });
    return respond(503, {
      error: "Payment status could not be read; retry later",
      code: "reconcile_cooldown",
      retryAfterSec: retryAfterSec(intent.reconcileUntil, Date.now()),
    });
  }

  const mapped = mapTidepoolStatus(res.status);
  if (!mapped.ok) {
    /* An unrecognised upstream status: store the raw value (bounded),
       park in UNKNOWN, answer 503 status_unknown — an unknown status is
       NEVER interpreted as success, or as anything else. The raw value
       is read back as null by statusView; the cooldown stops a client
       from hammering an upstream that is talking nonsense. */
    if (intent.status !== "UNKNOWN") transition(record, intent, "UNKNOWN", "unmapped_status", Date.now(), rid);
    intent.tidepoolStatus = res.status.slice(0, 64);
    intent.lastError = "unmapped_status";
    intent.reconcileUntil = Date.now() + ambiguousCooldownMs(env);
    await save(storage, record, Date.now());
    logEvent("status_upstream_error", {
      level: "warn", rid, linkId: record.linkId, intentId: intent.intentId,
      target: "status", kind: "unmapped_status", status: res.status.slice(0, 64),
    });
    return respond(503, {
      error: "Tidepool reported an unrecognized payment status",
      code: "status_unknown",
      retryAfterSec: retryAfterSec(intent.reconcileUntil, Date.now()),
    });
  }

  intent.tidepoolStatus = res.status;
  intent.tidepoolStatusUpdatedAt = res.updatedAt || null;
  /* Phase 5: keep any settlement-hash candidates this read carried —
     captured now so the cycle that lands SETTLED (below) leaves the
     evidence for the verification cycle that follows. */
  mergePayoutHashes(intent, res.payout);
  let changed = false;

  if (mapped.target === null) {
    /* PENDING_DEPOSIT — the same expiry rule as reconcile(): past OUR
       actual quote deadline with no observed deposit is EXPIRED (docs:
       Tidepool has no EXPIRED status of its own, so we derive it from
       the real deadline); an observed deposit never expires, and a
       definite answer out of RECONCILE/UNKNOWN resolves honestly. */
    const pastDeadline = typeof intent.quoteDeadlineMs === "number" && Date.now() >= intent.quoteDeadlineMs;
    if (pastDeadline && !depositObserved(intent)) {
      changed = transition(record, intent, "EXPIRED", "no_deposit_past_deadline", Date.now(), rid);
    } else if (intent.status === "RECONCILE" || intent.status === "UNKNOWN") {
      changed = transition(record, intent, depositObserved(intent) ? "DEPOSIT_SEEN" : "AWAITING_DEPOSIT",
        "status_resolved", Date.now(), rid);
    }
    await save(storage, record, Date.now());
    return respond(200, statusBody(record, intent, changed));
  }

  const target = mapped.target;
  if (intent.status !== target) {
    changed = transition(record, intent, target, `tidepool_${res.status}`, Date.now(), rid);
    if (!changed) {
      /* The table refused a move the map asked for — a regression, not
         a duplicate (duplicates never reach here). Park with a cooldown
         and say the state is unknown; never force a state the machine
         does not permit. */
      intent.reconcileUntil = Date.now() + ambiguousCooldownMs(env);
      await save(storage, record, Date.now());
      logEvent("status_upstream_error", {
        level: "warn", rid, linkId: record.linkId, intentId: intent.intentId,
        target: "status", kind: "transition_refused", from: intent.status, to: target,
      });
      return respond(503, {
        error: "Payment state could not be reconciled",
        code: "status_unknown",
        retryAfterSec: retryAfterSec(intent.reconcileUntil, Date.now()),
      });
    }
  }
  /* Duplicate external status (from === to) is a no-op, not an error:
     external facts above (tidepoolStatus / updatedAt) persist with the
     save. SUCCESS lands as SETTLED — awaiting independent verification,
     never VERIFIED; REFUNDED and FAILED stay distinct terminal states. */
  await save(storage, record, Date.now());
  return respond(200, statusBody(record, intent, changed));
}

/* ── GET /status worker handler ──────────────────────────────────────── */
async function statusRequest(request, env, ctx) {
  const { rid, rh, ip, t0 } = ctx;
  const reject = (status, code, message, extra = {}) => {
    logEvent("status_rejected", { rid, ip, status, code, reason: code, ...extra });
    return json({ error: message, code }, status, rh);
  };

  /* Capability + routing validation. Unknown parameters are ignored on
     purpose: a browser-supplied depositAddress= (or any other field) is
     never read, never believed, never queried. */
  const url = new URL(request.url);
  const linkId = url.searchParams.get("linkId") || "";
  if (linkId.length < MIN_LINK_ID_LEN || linkId.length > MAX_LINK_ID_LEN) {
    return reject(400, "invalid_link_id", "linkId must be 4-64 characters");
  }
  const intentId = url.searchParams.get("id") || "";
  if (!INTENT_ID_RE.test(intentId)) {
    return reject(400, "invalid_intent_id", "id must be a payment intent id", { linkId });
  }

  if (!env.INTENT_DO || typeof env.INTENT_DO.idFromName !== "function" ||
      typeof env.INTENT_DO.get !== "function") {
    logEvent("service_error", { level: "error", rid, error: "INTENT_DO binding missing" });
    return json({ error: "Intent store is not configured", code: "intent_store_unconfigured" }, 500, rh);
  }

  /* The DO is addressed by linkId only — the intentId is matched against
     that invoice's record inside, so an id from another invoice 404s.
     Real runtime API: idFromName() returns a DurableObjectId; only
     namespace.get(id) returns the stub whose .fetch reaches the object
     (caught by the workerd run — a Node harness that returns the stub
     straight from idFromName would mask this). */
  const stub = env.INTENT_DO.get(env.INTENT_DO.idFromName(linkId));
  let dbody = null;
  let status = 0;
  try {
    const dres = await stub.fetch(new Request(DO_STATUS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rid, linkId, intentId }),
    }));
    status = dres.status;
    dbody = await dres.json();
  } catch (err) {
    logEvent("service_error", { level: "error", rid, error: "intent store failed: " + scrub(String((err && err.message) || err)) });
    return json({ error: "Intent store failed", code: "intent_store_failed" }, 500, rh);
  }

  const headers = { ...rh };
  if (dbody && Number.isFinite(dbody.retryAfterSec)) headers["Retry-After"] = String(dbody.retryAfterSec);

  if (status === 200) {
    /* status_ok only when a poll actually CHANGED something — routine
       2-second polls are silent, so a watching client can never burn
       the log budget (transitions already log intent_transition). */
    if (dbody && dbody.changed === true) {
      logEvent("status_ok", {
        rid, ip, linkId, intentId,
        status: dbody.intent && dbody.intent.status,
        tidepoolStatus: (dbody.intent && dbody.intent.tidepoolStatus) || null,
        conflict: dbody.conflict || null,
        ms: Date.now() - t0,
      });
    }
    return json(dbody, 200, headers);
  }
  if (status === 400 || status === 404) {
    logEvent("status_rejected", {
      rid, ip, status, linkId,
      code: (dbody && dbody.code) || "rejected",
      reason: (dbody && dbody.code) || "rejected",
    });
    return json(dbody || { error: "request failed" }, status, headers);
  }
  /* 503 (backoff / unknown status) and any unexpected code: the
     originating failure already produced its own log line — answer
     only, never a second line per poll. */
  return json(dbody || { error: "request failed" }, status, headers);
}

async function handleCreate(env, storage, payload) {
  const now = Date.now();
  const rid = typeof payload.rid === "string" ? payload.rid : undefined;
  const cooldownMs = ambiguousCooldownMs(env);
  const windowMs = quoteWindowMs(env);

  /* Defense in depth: everything the worker already validated is
     validated again here, because the DO is the last gate before money
     moves. */
  const link = normalizeLink(payload.link, typeof payload.linkId === "string" ? payload.linkId : undefined);
  if (!link) return respond(400, { error: "Authoritative invoice data was invalid", code: "invalid_link" });
  const elig = checkEligibility(link, now);
  if (!elig.ok) return respond(409, { error: elig.message, code: elig.code });
  const source = normalizeMeta(payload.source);
  const destination = normalizeMeta(payload.destination);
  if (!source || !destination || destination.assetId !== DEST_ASSET || source.assetId === DEST_ASSET) {
    return respond(400, { error: "Token metadata was invalid", code: "invalid_token_meta" });
  }
  const refundTo = typeof payload.refundTo === "string" ? payload.refundTo.trim() : "";
  if (!refundTo || refundTo.length > MAX_REFUND_TO) {
    return respond(400, { error: "refundTo was invalid", code: "invalid_refund_to" });
  }
  let idempotencyKey = null;
  if (payload.idempotencyKey !== undefined && payload.idempotencyKey !== null) {
    if (typeof payload.idempotencyKey !== "string" || !payload.idempotencyKey ||
        payload.idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
      return respond(400, { error: "idempotencyKey was invalid", code: "invalid_idempotency_key" });
    }
    idempotencyKey = payload.idempotencyKey;
  }

  /* Load the invoice's record (one storage key, one object per invoice). */
  let record;
  try {
    record = await storage.get(RECORD_KEY);
  } catch {
    return respond(500, { error: "Intent store read failed", code: "persistence_failed" });
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    record = {
      linkId: link.link_id, merchant: link.creator, onChainStatus: link.status,
      onChainCheckedAt: now, conflict: null,
      activeIntentId: null, intents: [], history: [],
      createdAt: now, updatedAt: now,
    };
  }
  if (record.linkId !== link.link_id) {
    return respond(400, { error: "Record does not belong to this invoice", code: "invalid_link" });
  }

  /* Phase 6: validate BEFORE acting. A present-but-unreadable intents
     list or active-intent pointer must never read as "nothing is going
     on" — that would open a second deposit address over an uncertain or
     already-verified payment. Such a record HOLDS (503 record_invalid,
     stamped once per reason); it is never repaired into permissiveness. */
  if (record.intents === undefined) record.intents = [];
  if (!Array.isArray(record.intents)) {
    return holdInvalid(env, storage, record, null, "intents_invalid", rid);
  }
  const recProblem = recordLevelProblem(record);
  if (recProblem) await stampInvalid(storage, record, null, recProblem, rid);
  if (!Array.isArray(record.history)) record.history = [];
  if (record.activeIntentId !== null && record.activeIntentId !== undefined) {
    if (typeof record.activeIntentId !== "string" ||
        !record.intents.some((i) => i && i.intentId === record.activeIntentId)) {
      return holdInvalid(env, storage, record, null, "active_intent_unresolvable", rid);
    }
  } else if (record.intents.length > 0) {
    /* Intents exist but no pointer: which one is live is unreadable —
       the old silent "null it out" repair would have treated that as
       "no active intent" and minted a second address. */
    return holdInvalid(env, storage, record, null, "active_intent_missing", rid);
  }
  record.merchant = link.creator;
  record.onChainStatus = link.status;
  /* This create just read the authoritative contract state — record when
     (GET /status reports it; the race detector compares against it). */
  record.onChainCheckedAt = now;

  const active = record.intents.find((i) => i && i.intentId === record.activeIntentId) || null;
  if (active) {
    /* Phase 6: the active intent is validated before any reuse / 409
       decision — an unreadable active record is quarantined or held,
       never served as publicIntent() and never read as terminal. */
    const itProblem = intentRecordProblem(active);
    if (itProblem === "status_invalid") {
      return quarantineStatus(env, storage, record, active, itProblem, rid);
    }
    if (itProblem) return holdInvalid(env, storage, record, active.intentId, itProblem, rid);
    if (active.status === "VERIFIED") {
      return respond(409, { error: "Invoice payment already verified", code: "payment_verified" });
    }
    if (active.status === "SETTLED") {
      return respond(409, { error: "Payment settled externally; awaiting verification", code: "payment_settled" });
    }
    if (!NEW_INTENT_ALLOWED.has(active.status)) {
      const resolution = await resolveActive(env, storage, record, active, now, cooldownMs, rid);
      if (resolution.done) return resolution.response;
      /* falls through: the old intent reached EXPIRED / REFUNDED / FAILED */
    }
  }

  /* ── create a new intent ── */
  if (record.intents.length >= MAX_INTENTS_PER_LINK) {
    return respond(409, { error: "Too many payment intents for this invoice", code: "intent_history_full" });
  }
  const intentId = `pi_${newRid()}${newRid()}`;
  const intent = {
    intentId,
    linkId: link.link_id,
    idempotencyKey,
    status: "CREATING",
    createdAt: now,
    updatedAt: now,
    depositAddress: null,
    depositMemo: null,
    source,
    destination,
    merchant: link.creator,
    invoiceAmount: link.amount,
    expectedInputAmount: null,
    minInputAmount: null,
    expectedOutputAmount: null,
    quoteDeadlineMs: null,
    quoteTimestamp: null,
    signature: null,
    signatureValid: false,
    correlationId: null,
    tidepoolStatus: null,
    tidepoolStatusUpdatedAt: null,
    lastReason: null,
    lastError: null,
    reconcileUntil: null,
    /* Phase 4 polling bookkeeping: no deposit seen yet, no status cycle
       run yet (null lets the first GET /status read immediately). */
    depositObserved: false,
    lastStatusPollAt: null,
    /* Phase 5 verification bookkeeping: payout-hash candidates are
       captured SERVER-SIDE from Tidepool's swapDetails (never client
       input, never echoed or logged), the malformed counter blocks
       verification if any candidate cannot even be addressed, and each
       hold persists its reason + backoff clocks. */
    payoutHashes: null,
    payoutHashInvalid: 0,
    payoutHoldReason: null,
    verifyUntil: null,
    verifyAttempts: 0,
    sentQuoteRequest: null,
  };
  record.intents.push(intent);
  record.activeIntentId = intentId;
  pushHistory(record, intentId, null, "CREATING", "creation_started", now);
  logEvent("intent_transition", {
    rid, linkId: record.linkId, intentId, from: null, to: "CREATING", reason: "creation_started",
  });
  /* Checkpoint BEFORE any upstream call: if anything after this line is
     interrupted, the record shows an ambiguous CREATING intent instead of
     an empty slate — that is what stops a retry from double-creating. */
  await save(storage, record, now);

  const req = buildQuoteRequest({ link, source, destination, refundTo, now, windowMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tidepoolTimeoutMs(env));
  let out;
  try {
    out = await requestQuote(tidepoolOrigin(env), req, env, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (out.kind !== "ok") {
    if (isDefinitiveFailure(out)) {
      /* 4xx: Tidepool rejected the request before creating anything. */
      transition(record, intent, "FAILED", "upstream_rejected", Date.now(), rid);
      intent.lastError = `http_${out.status}`;
      await save(storage, record, Date.now());
      logEvent("quote_upstream_error", {
        level: "warn", rid, linkId: record.linkId, target: "quote",
        kind: "http_status", status: out.status, detail: out.detail,
      });
      return respond(502, {
        error: "Tidepool rejected the quote request",
        code: "quote_upstream_rejected",
      });
    }
    /* Ambiguous outcome: reconcile first — no blind second quote (Part 6). */
    transition(record, intent, "RECONCILE", "creation_ambiguous", Date.now(), rid);
    intent.reconcileUntil = Date.now() + cooldownMs;
    intent.lastError = out.kind;
    await save(storage, record, Date.now());
    logEvent("quote_upstream_error", {
      level: "error", rid, linkId: record.linkId, target: "quote",
      kind: out.kind, status: out.status, detail: out.detail, ambiguous: true,
    });
    return respond(503, {
      error: "Quote creation outcome is uncertain; retry after reconciliation",
      code: "reconcile_cooldown",
      retryAfterSec: retryAfterSec(intent.reconcileUntil, Date.now()),
    });
  }

  const v = await validateQuoteResponse(out.data, req, {
    makerKey: makerKey(env),
    invoiceAmount: link.amount,
    now: Date.now(),
  });
  if (!v.ok) {
    /* A full response we hold but refuse (bad signature, wrong amounts,
       replayed echo…): its address never reaches a client, so the intent
       closes as FAILED and an immediate retry may try again. */
    const [code, message] = QUOTE_FAILS[v.reason] || QUOTE_FAILS.malformed;
    transition(record, intent, "FAILED", `quote_${v.reason}`, Date.now(), rid);
    intent.lastError = v.reason;
    await save(storage, record, Date.now());
    logEvent("quote_upstream_error", {
      level: "error", rid, linkId: record.linkId, target: "quote", kind: v.reason,
    });
    return respond(502, { error: message, code });
  }

  /* Persist the verified quote: two recorded transitions, one write. */
  intent.depositAddress = v.data.depositAddress;
  intent.depositMemo = v.data.depositMemo;
  intent.expectedInputAmount = v.data.amountIn;
  intent.minInputAmount = v.data.minAmountIn;
  intent.expectedOutputAmount = v.data.amountOut;
  intent.quoteDeadlineMs = v.data.deadlineMs;
  intent.quoteTimestamp = v.data.quoteTimestamp;
  intent.signature = v.data.signature;
  intent.signatureValid = true;
  intent.correlationId = v.data.correlationId;
  intent.sentQuoteRequest = req;
  const t1 = Date.now();
  transition(record, intent, "QUOTE_ISSUED", "quote_verified", t1, rid);
  transition(record, intent, "AWAITING_DEPOSIT", "awaiting_deposit", t1, rid);
  await save(storage, record, t1);

  return respond(201, {
    ok: true, reused: false,
    intent: publicIntent(intent),
    onChainStatus: record.onChainStatus,
  });
}

/* ── the Durable Object ─────────────────────────────────────────────────
   One instance per invoice id (idFromName(linkId)). Its input gates
   serialize concurrent requests per invoice, and the CREATING checkpoint
   above keeps correctness even if the runtime interleaves during the
   upstream call: a second request can only ever reuse the first intent,
   cool down, or wait — it cannot mint a second deposit address. */
export class PaymentIntent {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method !== "POST" || (path !== "/create" && path !== "/status")) {
        return respond(404, { error: "not found" });
      }
      let payload;
      try { payload = await request.json(); } catch { payload = null; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return respond(400, { error: "Invalid intent payload", code: "invalid_payload" });
      }
      if (path === "/status") {
        /* Defense in depth, like handleCreate: the worker already
           validated both ids; the DO re-checks before touching money
           state, because it is the last gate. */
        if (typeof payload.linkId !== "string" ||
            payload.linkId.length < MIN_LINK_ID_LEN || payload.linkId.length > MAX_LINK_ID_LEN ||
            typeof payload.intentId !== "string" || !INTENT_ID_RE.test(payload.intentId)) {
          return respond(400, { error: "Invalid status request", code: "invalid_payload" });
        }
        return await handleStatus(this.env, this.state.storage, payload);
      }
      return await handleCreate(this.env, this.state.storage, payload);
    } catch (err) {
      if (err && err.code === "persistence_failed") {
        try {
          logEvent("service_error", { level: "error", error: "persistence_failed" });
        } catch { /* logging must never mask the failure */ }
        return respond(500, { error: "Intent store write failed", code: "persistence_failed" });
      }
      try {
        logEvent("service_error", {
          level: "error",
          error: scrub(String((err && err.message) || err)),
        });
      } catch { /* logging must never mask the failure */ }
      return respond(500, { error: "internal error", code: "internal_error" });
    }
  }
}

/* ── POST /quote worker handler ──────────────────────────────────────── */
async function quote(request, env, ctx) {
  const { rid, rh, ip, t0 } = ctx;
  const reject = (status, code, message, extra = {}) => {
    logEvent("quote_rejected", { rid, ip, status, code, reason: code, linkId: extra.linkId, ...extra });
    return json({ error: message, code }, status, rh);
  };

  /* Body: size-bounded, then parsed. Content-Length is honoured when the
     client sends one; otherwise the read body is checked (Workers caps
     request bodies long before this becomes a memory concern). */
  const lenHdr = request.headers.get("content-length");
  if (lenHdr !== null && Number(lenHdr) > MAX_REQUEST_BYTES) {
    logEvent("quote_rejected", { rid, ip, status: 413, code: "payload_too_large", reason: "payload_too_large" });
    return json({ error: "Request body too large", code: "payload_too_large" }, 413, rh);
  }
  let raw;
  try { raw = await request.text(); } catch { raw = null; }
  if (raw === null) return reject(400, "invalid_json", "Request body could not be read");
  if (raw.length > MAX_REQUEST_BYTES) {
    logEvent("quote_rejected", { rid, ip, status: 413, code: "payload_too_large", reason: "payload_too_large" });
    return json({ error: "Request body too large", code: "payload_too_large" }, 413, rh);
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reject(400, "invalid_json", "Request body is not valid JSON");
  }

  /* Field validation: the client's four routing choices, bounded. */
  const linkId = typeof body.linkId === "string" ? body.linkId : "";
  if (linkId.length < MIN_LINK_ID_LEN || linkId.length > MAX_LINK_ID_LEN) {
    return reject(400, "invalid_link_id", "linkId must be 4-64 characters");
  }
  const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
  if (!assetId || assetId.length > MAX_ASSET_ID) {
    return reject(400, "invalid_asset_id", "assetId is required");
  }
  const blockchain = typeof body.blockchain === "string" ? body.blockchain.trim() : "";
  if (!blockchain || blockchain.length > MAX_CHAIN) {
    return reject(400, "invalid_blockchain", "blockchain is required");
  }
  const refundTo = typeof body.refundTo === "string" ? body.refundTo.trim() : "";
  if (!refundTo || refundTo.length > MAX_REFUND_TO) {
    return reject(400, "invalid_refund_to", "refundTo is required");
  }
  let idempotencyKey = null;
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey ||
        body.idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
      return reject(400, "invalid_idempotency_key", "idempotencyKey must be 1-128 characters");
    }
    idempotencyKey = body.idempotencyKey;
  }
  /* Tidepool refuses origin === destination outright (probed live: 400
     "originAsset and destinationAsset must differ"), and the invoice IS
     the destination asset — such a payer needs the native rail, not a
     quote. Caught here so it never becomes an upstream round trip. */
  if (assetId === DEST_ASSET) {
    return reject(400, "same_asset_source", "Source asset must differ from the destination asset");
  }

  /* Config check before any upstream work. */
  if (!env.INTENT_DO || typeof env.INTENT_DO.idFromName !== "function" ||
      typeof env.INTENT_DO.get !== "function") {
    logEvent("service_error", { level: "error", rid, error: "INTENT_DO binding missing" });
    return json({ error: "Intent store is not configured", code: "intent_store_unconfigured" }, 500, rh);
  }

  /* ── authoritative invoice: get_link, straight from the contract ── */
  const rpcCtl = new AbortController();
  const rpcTimer = setTimeout(() => rpcCtl.abort(), tidepoolTimeoutMs(env));
  let lr;
  try {
    lr = await getLink(env, linkId, rpcCtl.signal);
  } finally {
    clearTimeout(rpcTimer);
  }
  if (lr.kind !== "ok") {
    const timeout = lr.kind === "timeout";
    logEvent("quote_upstream_error", {
      level: "error", rid, target: "contract", kind: lr.kind, status: lr.status,
    });
    return json(
      { error: timeout ? "NEAR RPC timed out" : "Could not read the invoice from the contract",
        code: timeout ? "invoice_lookup_timeout" : "invoice_lookup_failed" },
      timeout ? 504 : 502, rh,
    );
  }
  if (lr.value === null) return reject(404, "invoice_not_found", "Invoice not found");
  const link = normalizeLink(lr.value, linkId);
  if (!link) {
    logEvent("quote_upstream_error", { level: "error", rid, target: "contract", kind: "bad_shape" });
    return json({ error: "Invoice data from the contract was malformed", code: "invoice_malformed" }, 502, rh);
  }

  /* ── eligibility (contract truth, never the frontend's word) ── */
  const elig = checkEligibility(link, Date.now());
  if (!elig.ok) return reject(409, elig.code, elig.message, { linkId });

  /* ── FRESH /v0/tokens: the cached discovery is never authorization ── */
  const tokCtl = new AbortController();
  const tokTimer = setTimeout(() => tokCtl.abort(), tidepoolTimeoutMs(env));
  let tk;
  try {
    tk = await getJson(`${tidepoolOrigin(env)}/v0/tokens`, tokCtl.signal);
  } finally {
    clearTimeout(tokTimer);
  }
  if (tk.kind !== "ok") {
    logEvent("quote_upstream_error", { level: "error", rid, target: "tokens", ...tokensFailure(tk) });
    return json({ ...tokensErrorMessage(tk), code: "tokens_unavailable" },
      tk.kind === "timeout" ? 504 : 502, rh);
  }
  if (!Array.isArray(tk.data)) {
    logEvent("quote_upstream_error", { level: "error", rid, target: "tokens", kind: "bad_shape" });
    return json({ error: "Tidepool response was malformed", code: "tokens_unavailable" }, 502, rh);
  }
  let src = null;
  let dst = null;
  for (const item of tk.data) {
    const t = normalizeToken(item);
    if (!t) continue;
    if (t.assetId === assetId) src = t;
    if (t.assetId === DEST_ASSET) dst = t;
  }
  if (!dst) {
    logEvent("quote_upstream_error", { level: "error", rid, target: "tokens", kind: "destination_missing" });
    return json({ error: "Destination asset is not available on Tidepool", code: "destination_unavailable" }, 502, rh);
  }
  if (!src) return reject(400, "asset_unsupported", "assetId is not supported by Tidepool right now", { linkId });
  if (src.blockchain !== blockchain) {
    return reject(400, "network_token_mismatch", "assetId is not on the requested network", { linkId });
  }
  const source = { assetId: src.assetId, blockchain: src.blockchain, symbol: src.symbol, decimals: src.decimals };
  const destination = { assetId: dst.assetId, blockchain: dst.blockchain, symbol: dst.symbol, decimals: dst.decimals };

  /* ── serialized create-or-reuse in the Durable Object ──
     Real runtime API: idFromName() yields the id, namespace.get(id)
     yields the stub (the workerd run caught the harness-masked
     difference). */
  const stub = env.INTENT_DO.get(env.INTENT_DO.idFromName(linkId));
  let dbody = null;
  let status = 0;
  try {
    const dres = await stub.fetch(new Request(DO_CREATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rid, linkId, link, source, destination, refundTo, idempotencyKey }),
    }));
    status = dres.status;
    dbody = await dres.json();
  } catch (err) {
    logEvent("service_error", { level: "error", rid, error: "intent store failed: " + scrub(String((err && err.message) || err)) });
    return json({ error: "Intent store failed", code: "intent_store_failed" }, 500, rh);
  }

  const headers = { ...rh };
  if (dbody && Number.isFinite(dbody.retryAfterSec)) headers["Retry-After"] = String(dbody.retryAfterSec);

  if (status === 200 || status === 201) {
    logEvent("quote_ok", {
      rid, ip, linkId,
      intentId: dbody.intent && dbody.intent.intentId,
      reused: status === 200,
      state: dbody.intent && dbody.intent.status,
      ms: Date.now() - t0,
    });
    return json(dbody, status, headers);
  }
  if (status === 502) {
    logEvent("quote_upstream_error", {
      level: "error", rid, linkId, target: "quote", kind: (dbody && dbody.code) || "upstream",
    });
    return json(dbody || { error: "Tidepool quote failed", code: "quote_failed" }, status, headers);
  }
  if (status === 500) {
    logEvent("service_error", { level: "error", rid, error: (dbody && dbody.code) || "intent_store_failed" });
    return json(dbody || { error: "internal error" }, status, headers);
  }
  /* 400 / 404 / 409 / 503: client-visible rejections with machine codes. */
  logEvent("quote_rejected", {
    rid, ip, linkId, status, code: (dbody && dbody.code) || "rejected",
    reason: (dbody && dbody.code) || "rejected",
  });
  return json(dbody || { error: "request failed" }, status, headers);
}
