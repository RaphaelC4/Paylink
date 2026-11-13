/* Paylink × Tidepool — cross-chain payment rail (Phase 7).
   Static ES module: no build step, no dependencies, no top-level DOM access.
   The browser talks to exactly ONE payment endpoint — the Paylink Tidepool
   Worker (CONFIG.tidepoolWorker.endpoint, injected via initTidepool) — for
   discovery (/networks), quotes (/quote) and payment status (/status). It
   never calls Tidepool directly for anything payment-related, and it never
   renders a payment as complete until the Worker says VERIFIED.

   Hard rules encoded throughout this file:
     - money is BigInt / base-unit strings only — no parseFloat, no Number()
       arithmetic on amounts, ever;
     - every Worker response is untrusted: shapes are validated before a
       single field reaches the DOM, and only an allowlist of fields is
       rendered (no signature, no correlationId, no payout hashes, no
       lastReason, no history, no raw bodies);
     - only VERIFIED is success. Tidepool SUCCESS (→ SETTLED) is an external
       claim shown as "awaiting independent verification"; UNKNOWN /
       RECONCILE / conflict are never styled as success;
     - polling talks to the Paylink Worker only, honours Retry-After /
       retryAfterSec, never runs faster than the backend permits (2 s floor),
       never overlaps itself, pauses when the page is hidden or the pay panel
       is not active, stops on terminal states, and CONTINUES through SETTLED
       (the verification journey) — a network error is a retry, never a
       payment failure;
     - persistence is the minimum needed to resume: linkId, intentId and the
       payer's own form inputs. Deposit instructions live only in memory and
       are re-fetched from the Worker on resume;
     - no intent is ever created automatically — only an explicit "Get quote"
       / "Request a new quote" / "Show deposit details" press, and retries
       reuse the same idempotency key so an uncertain outcome can never mint
       a second deposit address.

   Structure: (1) contract constants, (2) pure helpers — all exported for the
   test suites, (3) createTidepoolRail(deps) — the injectable state machine,
   (4) the singleton wiring app.js uses. */

/* The receipt sentence is shared with receipt.js / app.js so the card, the
   panel and the PDF all say the same one line — a sibling pure module, still
   no dependencies and no build step. */
import { RECEIPT_SENTENCE } from "./receipt.js";

/* ══════════════════════════════════════════════ 1. contract constants ══ */

/* The 12 intent states, each with the presentation label the spec fixes.
   tone maps onto the existing .tx-line vocabulary: pending / ok / err, with
   "neutral" meaning the default (unstyled) .tx-line. Only VERIFIED gets "ok". */
export const TP_STATES = {
  CREATING: {
    label: "Preparing payment",
    tone: "pending",
    detail: "Setting up your cross-chain payment with the service.",
  },
  QUOTE_ISSUED: {
    label: "Quote ready",
    tone: "pending",
    detail: "The quote was verified — waiting for your deposit.",
  },
  AWAITING_DEPOSIT: {
    label: "Waiting for your deposit",
    tone: "pending",
    detail: "Send the quoted amount to the deposit address below before the quote deadline.",
  },
  DEPOSIT_SEEN: {
    label: "Deposit seen",
    tone: "pending",
    detail: "Your deposit was detected — Tidepool is converting it now.",
  },
  SETTLING: {
    label: "Converting",
    tone: "pending",
    detail: "The conversion is in progress. Nothing to do but wait.",
  },
  SETTLED: {
    label: "Converted — awaiting verification",
    tone: "pending",
    detail:
      "Tidepool reports the swap complete. That is a provider claim, not proof: Paylink is now independently verifying the payout to the merchant on NEAR.",
  },
  VERIFIED: {
    label: "Payment verified",
    tone: "ok",
    detail:
      "Paylink verified the payout to the merchant from authoritative NEAR transaction evidence. This payment is final.",
  },
  EXPIRED: {
    label: "Quote expired",
    tone: "neutral",
    detail: "The quote deadline passed before the payment settled. You can request a new quote.",
  },
  REFUNDED: {
    label: "Refunded",
    tone: "neutral",
    detail: "The attempt ended with your funds returned to the source chain.",
  },
  FAILED: {
    label: "Failed",
    tone: "err",
    detail: "This attempt did not complete. Request a new quote to try again.",
  },
  UNKNOWN: {
    label: "Status unavailable",
    tone: "pending",
    detail: "The status service did not answer. Paylink keeps retrying on its own.",
  },
  RECONCILE: {
    label: "Under review",
    tone: "err",
    detail:
      "This payment is held for manual reconciliation. No action is needed from you — do not send another payment.",
  },
};

/* Terminal for THIS attempt: polling stops, and (except VERIFIED) the payer
   is free to start over or use the native NEAR button again. */
export const TP_TERMINAL = new Set(["VERIFIED", "EXPIRED", "REFUNDED", "FAILED"]);

/* The only state the page may present as a completed payment. */
export const TP_VERIFIED = "VERIFIED";

/* States whose deposit instructions can be safely rebuilt by re-quoting:
   the backend reuses the SAME active intent (reused:true) for these, so a
   re-quote can never mint a second deposit address. CREATING is excluded on
   purpose — that one stays status-only, because only an explicit press may
   ever create an intent. */
export const TP_REUSE_SET = new Set(["QUOTE_ISSUED", "AWAITING_DEPOSIT", "DEPOSIT_SEEN", "SETTLING"]);

/* Upstream (Tidepool) status → progress detail line. These are informational
   only; the intent state above is what drives the presentation. */
export const TP_TIDEPOOL_DETAIL = {
  PENDING_DEPOSIT: "Tidepool: quote still waiting for the deposit.",
  KNOWN_DEPOSIT_TX: "Tidepool: your deposit transaction is known.",
  INCOMPLETE_DEPOSIT: "Tidepool: deposit still completing.",
  PROCESSING: "Tidepool: processing the conversion.",
  SUCCESS: "Tidepool reports SUCCESS — an external claim, never proof. Verification on NEAR decides.",
  REFUNDED: "Tidepool: refunded.",
  FAILED: "Tidepool: failed.",
};

/* Discovery availability (Worker's fail-closed vocabulary) → label + whether
   the network may be selected at all. Anything unknown is unselectable. */
export const TP_AVAILABILITY = {
  native: { label: "live", pick: true },
  "bridge-ok": { label: "live", pick: true },
  "bridge-down": { label: "bridge down", pick: false },
  unsupported: { label: "unsupported", pick: false },
  unverified: { label: "unverified", pick: false },
};

/* Client-side guidance per backend error code. The backend's own `error`
   string is always shown first (it is authoritative); the hint adds what the
   payer should DO. Unknown codes fall back to a generic, non-promising hint. */
export const TP_ERROR_HINTS = {
  invoice_settled: "This invoice is already settled — there is nothing left to pay.",
  invoice_cancelled: "This invoice was cancelled. No payment is possible.",
  invoice_expired: "This invoice has expired — ask the payee for a new link.",
  invoice_not_open: "This invoice is no longer open for payment.",
  invoice_not_found: "This invoice does not exist on chain.",
  invoice_token_unsupported: "This invoice's token cannot be paid through Tidepool — use the NEAR button.",
  invoice_expiry_too_soon: "The invoice expires too soon to quote. The payee must extend it first.",
  payment_verified: "This payment is already verified — do not pay again.",
  payment_settled: "This payment already settled and is awaiting verification — do not pay again.",
  intent_history_full: "This invoice has reached its attempt limit — an operator must reconcile it.",
  intent_not_found: "That payment attempt no longer exists — start again.",
  same_asset_source: "The invoice is denominated in that very token — pay with the NEAR button instead.",
  asset_unsupported: "That token is not supported right now — pick another one.",
  network_token_mismatch: "That token is not on the selected network — pick another combination.",
  destination_unavailable: "The destination token is unavailable on Tidepool right now — try again later.",
  tokens_unavailable: "Tidepool's token list is unavailable right now — try again in a moment.",
  quote_failed: "Tidepool could not price this quote right now — try again in a moment.",
  invoice_lookup_failed: "The invoice could not be read from the contract — try again.",
  invoice_lookup_timeout: "Reading the invoice from the contract timed out — try again.",
  reconcile_cooldown: "This payment is inside a cooldown window — wait for the stated time, then retry.",
  status_unknown: "Status is temporarily unknown — Paylink retries on its own.",
  record_invalid: "The stored payment record needs operator reconciliation — do not start another payment.",
  intent_store_unconfigured: "The payment service is not configured — this cannot be quoted right now.",
  intent_store_failed: "The payment service could not store the attempt — try again.",
  invalid_json: "The request was malformed — try again.",
  payload_too_large: "The request was too large — try again.",
  network: "Could not reach the Paylink payment service — check your connection and retry. Retrying reuses the same request, so no duplicate payment intent can be created.",
  bad_shape: "The payment service returned an unexpected response — nothing was saved. Try again.",
};
const TP_GENERIC_HINT = "Try again. If it keeps failing, use the NEAR button or come back later.";

/* Validation mirrors of the Worker's rules (the Worker re-validates every
   one of them — this is only so the form can refuse bad input early and the
   renderer can refuse bad output before it reaches the DOM). */
const TP_LINK_ID_RE = /^[\w.-]{4,64}$/;
const TP_INTENT_ID_RE = /^pi_[0-9a-f]{16}$/;
const TP_CANONICAL_UINT_RE = /^\d{1,80}$/;
const TP_MAX_REFUND_TO = 128;
const TP_MAX_IDEMPOTENCY_KEY = 128;
const TP_MAX_ENDPOINT = 256;

/* Polling bounds. FLOOR mirrors the backend's TIDEPOOL_STATUS_MIN_INTERVAL_MS
   default (2000): the page NEVER polls faster than the backend allows, even
   if a response lies about retryAfterSec. */
export const TP_POLL = {
  FLOOR: 2000,        // backend poll floor, default
  BASE: 3000,         // steady-state cadence while a deposit is pending
  SETTLED: 5000,      // verification cycles do NEAR tx reads — slightly slower
  SLOW: 10000,        // UNKNOWN / RECONCILE without a stated cooldown
  ERR_CAP: 30000,     // network-error backoff cap
  MAX_WAIT: 3600000,  // a stated Retry-After is honoured up to one hour
};

/* The sessionStorage journey: the minimum that lets a reload resume. Deposit
   instructions are deliberately NOT part of it — they are re-fetched. */
const TP_STORE_KEY = "paylink:tp-journey:v1";

/* ══════════════════════════════════════════════ 2. pure helpers ══════ */

/* Escape before any string reaches innerHTML. Matches app.js semantics:
   text content and quoted attributes only — our markup always quotes attrs. */
export function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* "1.5" + 6 → 1500000n. BigInt only: the string is split on "." and each
   half becomes an integer — no float ever touches an amount. Rejects signs,
   exponents, empty halves, and more fraction digits than the asset has. */
export function tpParseAmount(input, decimals) {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (frac.length > decimals) return null;
  const base = BigInt(whole) * 10n ** BigInt(decimals);
  return frac ? base + BigInt(frac.padEnd(decimals, "0")) : base;
}

/* 1500000n + 6 → "1.5"; trailing zeros trimmed; 0 → "0". Exact — the value
   round-trips through tpParseAmount with no drift. Input must be a canonical
   base-unit integer string (what the backend always sends) or a bigint. */
export function tpFormatBase(base, decimals) {
  let v;
  if (typeof base === "bigint") v = base;
  else if (typeof base === "string" && /^\d{1,80}$/.test(base)) v = BigInt(base);
  else return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const tpValidLinkId = (v) => typeof v === "string" && TP_LINK_ID_RE.test(v);
export const tpValidIntentId = (v) => typeof v === "string" && TP_INTENT_ID_RE.test(v);

/* Refund destination: a NEAR account (lowercase, dots for sub-accounts) or a
   0x hex address on the source chain. Bounded to the backend's 128. */
export function tpValidRefundTo(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > TP_MAX_REFUND_TO) return false;
  if (/^0x[0-9a-fA-F]{40,64}$/.test(s)) return true;
  return /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(s);
}

/* One idempotency key per attempt: generated on the first press, REUSED on
   every retry of that attempt, discarded only when the attempt succeeds or
   the payer explicitly starts over. ik_ + 32 hex (16 random bytes). */
export function tpNextIdemKey(cryptoObj) {
  const c = cryptoObj || (typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null);
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return `ik_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `ik_${hex}`;
}

/* Quote deadline → {ms, expired, warn, text}. warn flips inside the last
   minute so the instruction block can shout BEFORE money is sent. */
export function tpDeadlineInfo(deadline, nowMs) {
  if (typeof deadline !== "string") return null;
  const t = Date.parse(deadline);
  if (!Number.isFinite(t)) return null;
  const ms = t - nowMs;
  if (ms <= 0) return { ms, expired: true, warn: true, text: "Quote expired" };
  const s = Math.ceil(ms / 1000);
  const txt = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return { ms, expired: false, warn: ms <= 60000, text: `Quote expires in ${txt}` };
}

/* Retry-After header → whole seconds clamped to [1, 3600], or null. Accepts
   delta-seconds and HTTP-date forms; anything else is ignored (never "0",
   never negative, never unbounded). */
export function tpParseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let sec = null;
  if (/^\d{1,7}$/.test(raw)) sec = Number(raw);
  else {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) sec = Math.ceil((t - (nowMs ?? Date.now())) / 1000);
  }
  if (sec === null || !Number.isFinite(sec)) return null;
  return Math.min(Math.max(sec, 1), 3600);
}

/* Classify any Worker response: status + body error/code + effective
   retryAfterSec (body wins, then the Retry-After header). Pure — the callers
   decide what each classification MEANS. */
export function tpClassify(status, headers, body, nowMs) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const code = typeof b.code === "string" ? b.code : null;
  const error = typeof b.error === "string" ? b.error : null;
  let retryAfterSec =
    Number.isFinite(b.retryAfterSec) && b.retryAfterSec >= 0 ? Math.floor(b.retryAfterSec) : null;
  if (retryAfterSec === null && headers && typeof headers.get === "function") {
    retryAfterSec = tpParseRetryAfter(headers.get("Retry-After"), nowMs);
  }
  return {
    status,
    code,
    error,
    retryAfterSec,
    ok: Number.isInteger(status) && status >= 200 && status < 300 && b.ok !== false,
  };
}

/* Human line for a classified failure: the backend's own words first (they
   are authoritative and already safe to show), then our hint. */
export function tpErrorMessage(c) {
  if (!c) return { message: "", hint: "" };
  const message =
    c.error ||
    (c.code === "network" ? "Could not reach the Paylink payment service." : "The payment service rejected the request.");
  const hint = TP_ERROR_HINTS[c.code || ""] || (c.code ? "" : TP_GENERIC_HINT);
  return { message, hint };
}

/* GET /networks body → validated network list, or null if the body is not a
   response this page may believe. A malformed network entry rejects the whole
   body (the Worker produced it — that is a defect, fail closed); a malformed
   token is dropped instead (one bad token must not hide every good one).
   An EMPTY list is a valid answer: [] means "nothing available right now". */
export function tpParseNetworks(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!Array.isArray(body.networks)) return null;
  const out = [];
  for (const n of body.networks) {
    if (!n || typeof n !== "object" || Array.isArray(n)) return null;
    if (typeof n.blockchain !== "string" || !n.blockchain || n.blockchain.length > 64) return null;
    /* name is NULLABLE by contract: NEAR is not a bridge chain, so health
       reports no display name and the page shows the chain code instead. */
    if (n.name != null && (typeof n.name !== "string" || n.name.length > 64)) return null;
    if (typeof n.availability !== "string" || n.availability.length > 32) return null;
    if (!Array.isArray(n.tokens)) return null;
    const tokens = [];
    for (const t of n.tokens) {
      if (!t || typeof t !== "object" || Array.isArray(t)) continue;
      if (typeof t.assetId !== "string" || !t.assetId || t.assetId.length > 128) continue;
      if (typeof t.symbol !== "string" || !t.symbol || t.symbol.length > 32) continue;
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
      if (t.contractAddress != null && (typeof t.contractAddress !== "string" || t.contractAddress.length > 128)) continue;
      tokens.push({
        assetId: t.assetId,
        symbol: t.symbol,
        decimals: t.decimals,
        contractAddress: typeof t.contractAddress === "string" ? t.contractAddress : null,
      });
    }
    out.push({
      blockchain: n.blockchain,
      name: typeof n.name === "string" && n.name ? n.name : null,
      availability: n.availability,
      pickable: !!(TP_AVAILABILITY[n.availability] && TP_AVAILABILITY[n.availability].pick) && tokens.length > 0,
      tokens,
    });
  }
  return out;
}

/* POST /quote body → the validated intent we are willing to render, or null.
   This is the allowlist: every field that can reach the DOM is checked here,
   and fields the backend never sends (signature, correlationId, hashes) are
   simply not read — even if a hostile response includes them. */
export function tpParseQuote(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.ok !== true) return null;
  const i = body.intent;
  if (!i || typeof i !== "object" || Array.isArray(i)) return null;
  if (!tpValidIntentId(i.intentId) || !tpValidLinkId(i.linkId)) return null;
  if (typeof i.status !== "string" || !TP_STATES[i.status]) return null;
  if (typeof i.depositAddress !== "string" || !i.depositAddress || i.depositAddress.length > 128) {
    return null;
  }
  if (i.depositMemo != null && typeof i.depositMemo !== "string") return null;
  if (typeof i.depositMemo === "string" && i.depositMemo.length > 128) return null;
  for (const k of ["invoiceAmount", "expectedInputAmount", "minInputAmount", "expectedOutputAmount"]) {
    if (typeof i[k] !== "string" || !TP_CANONICAL_UINT_RE.test(i[k])) return null;
  }
  const meta = (m) =>
    m &&
    typeof m === "object" &&
    !Array.isArray(m) &&
    typeof m.assetId === "string" &&
    typeof m.blockchain === "string" &&
    typeof m.symbol === "string" &&
    typeof m.decimals === "number" &&
    Number.isInteger(m.decimals) &&
    m.decimals >= 0 &&
    m.decimals <= 36;
  if (!meta(i.source) || !meta(i.destination)) return null;
  if (typeof i.merchant !== "string" || i.merchant.length > 128) return null;
  if (i.quoteDeadline != null && typeof i.quoteDeadline !== "string") return null;
  if (i.tidepoolStatus != null && typeof i.tidepoolStatus !== "string") return null;
  if (i.createdAt != null && typeof i.createdAt !== "string") return null;
  if (i.updatedAt != null && typeof i.updatedAt !== "string") return null;
  /* Returned object carries only what the renderers may read — nothing else
     from the response survives, whatever else it contained. */
  return {
    intentId: i.intentId,
    linkId: i.linkId,
    status: i.status,
    depositAddress: i.depositAddress,
    depositMemo: i.depositMemo || null,
    source: {
      assetId: i.source.assetId,
      blockchain: i.source.blockchain,
      symbol: i.source.symbol,
      decimals: i.source.decimals,
    },
    destination: {
      assetId: i.destination.assetId,
      blockchain: i.destination.blockchain,
      symbol: i.destination.symbol,
      decimals: i.destination.decimals,
    },
    merchant: i.merchant,
    invoiceAmount: i.invoiceAmount,
    expectedInputAmount: i.expectedInputAmount,
    minInputAmount: i.minInputAmount,
    expectedOutputAmount: i.expectedOutputAmount,
    quoteDeadline: i.quoteDeadline || null,
    tidepoolStatus: typeof i.tidepoolStatus === "string" ? i.tidepoolStatus : null,
    createdAt: i.createdAt || null,
    updatedAt: i.updatedAt || null,
  };
}

/* GET /status body → validated status view, or null. Same allowlist rule:
   lastReason and any history-ish fields are not read, so they cannot leak. */
export function tpParseStatus(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.ok !== true) return null;
  const i = body.intent;
  if (!i || typeof i !== "object" || Array.isArray(i)) return null;
  if (!tpValidIntentId(i.intentId) || !tpValidLinkId(i.linkId)) return null;
  if (typeof i.status !== "string" || !i.status) return null;
  if (i.tidepoolStatus != null && typeof i.tidepoolStatus !== "string") return null;
  if (i.quoteDeadline != null && typeof i.quoteDeadline !== "string") return null;
  let conflict = null;
  if (body.conflict != null) {
    /* The Worker's documented wire shape is a bare kind STRING ("invoice_paid"
       or null — statusBody in the Worker), while an object {kind} is also
       accepted so either form parses. Anything else (number, array, empty
       string) fails closed: a malformed conflict is never read as
       "no conflict". */
    if (typeof body.conflict === "string") {
      if (!body.conflict) return null;
      conflict = { kind: body.conflict };
    } else if (typeof body.conflict === "object" && !Array.isArray(body.conflict)) {
      conflict = { kind: typeof body.conflict.kind === "string" ? body.conflict.kind : "invoice_conflict" };
    } else {
      return null;
    }
  }
  const onChain = body.onChainStatus == null ? null : typeof body.onChainStatus === "string" ? body.onChainStatus : null;
  if (body.onChainStatus != null && onChain === null) return null;
  return {
    intentId: i.intentId,
    linkId: i.linkId,
    status: i.status,
    tidepoolStatus: typeof i.tidepoolStatus === "string" ? i.tidepoolStatus : null,
    quoteDeadline: i.quoteDeadline || null,
    createdAt: typeof i.createdAt === "string" ? i.createdAt : null,
    updatedAt: typeof i.updatedAt === "string" ? i.updatedAt : null,
    conflict,
    onChainStatus: onChain,
    changed: body.changed === true,
  };
}

/* The exact POST /quote body — the four routing choices plus the idempotency
   key. Deliberately has NO amount field: the Worker derives the invoice
   amount from the contract, never from anything the browser claims. */
export function tpBuildQuoteBody(o) {
  const body = {
    linkId: o.linkId,
    assetId: o.assetId,
    blockchain: o.blockchain,
    refundTo: o.refundTo,
  };
  if (o.idempotencyKey != null) body.idempotencyKey = o.idempotencyKey;
  return body;
}

/* State → presentation view. Unknown states fail closed to a non-final
   "unrecognized" presentation — never success, never terminal. */
export function tpStateView(status) {
  if (typeof status !== "string" || !status) return null;
  const known = TP_STATES[status];
  if (known) return { status, ...known, terminal: TP_TERMINAL.has(status) };
  return {
    status,
    label: "Status unavailable",
    tone: "pending",
    detail: "The service reported a state this page does not recognize — treating it as non-final.",
    terminal: false,
  };
}

/* Conflict kind → what the payer is told. Always paired with "do not pay
   again" by the renderer; the kind itself is backend-supplied display text,
   not reconciliation evidence. */
export function tpConflictText(kind) {
  const k = typeof kind === "string" ? kind : "";
  const head =
    {
      invoice_paid: "This invoice was already paid — possibly outside this attempt.",
      invoice_conflict: "This invoice was already paid — possibly outside this attempt.",
      double_payout: "More than one payout was detected for this invoice.",
      payout_reversed: "The payout to the merchant was reversed.",
      contract_inconclusive: "The invoice could not be read reliably at verification time.",
      record_invalid: "The stored payment record failed validation.",
    }[k] || "This payment needs operator review.";
  return `${head} Do not send another payment — an operator reconciles it, and no action is needed from you.`;
}

/* The poll planner — one pure function decides every delay:
     null            stop (terminal, or nothing to poll)
     retryAfterSec   honoured verbatim (clamped ≥ floor, ≤ 1 h)
     errCount > 0    exponential backoff for network/shape failures
     SETTLED         verification cadence — polling CONTINUES
     UNKNOWN/RECONCILE  slow cadence — still not terminal
     otherwise       steady cadence
   active/visible false → null (paused; the engine resumes on change). */
export function tpNextPoll(o) {
  if (!o) return null;
  if (o.active === false || o.visible === false) return null;
  const status = typeof o.status === "string" ? o.status : "";
  if (!status || TP_TERMINAL.has(status)) return null;
  if (o.retryAfterSec != null && Number.isFinite(o.retryAfterSec) && o.retryAfterSec >= 0) {
    return Math.min(Math.max(Math.ceil(o.retryAfterSec * 1000), TP_POLL.FLOOR), TP_POLL.MAX_WAIT);
  }
  const err = Number.isInteger(o.errCount) && o.errCount > 0 ? o.errCount : 0;
  if (err > 0) return Math.min(TP_POLL.BASE * 2 ** (err - 1), TP_POLL.ERR_CAP);
  if (status === "SETTLED") return TP_POLL.SETTLED;
  if (status === "UNKNOWN" || status === "RECONCILE") return TP_POLL.SLOW;
  return TP_POLL.BASE;
}

/* Journey records round-trip through sessionStorage: every field re-validated
   on read, so a tampered or stale record is dropped instead of trusted. */
export function tpValidJourney(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (!tpValidLinkId(j.linkId) || !tpValidIntentId(j.intentId)) return null;
  if (typeof j.refundTo !== "string" || !j.refundTo || j.refundTo.length > TP_MAX_REFUND_TO) return null;
  if (typeof j.assetId !== "string" || !j.assetId || j.assetId.length > 128) return null;
  if (typeof j.blockchain !== "string" || !j.blockchain || j.blockchain.length > 64) return null;
  return {
    linkId: j.linkId,
    intentId: j.intentId,
    refundTo: j.refundTo,
    assetId: j.assetId,
    blockchain: j.blockchain,
    at: Number.isFinite(j.at) ? j.at : 0,
  };
}

/* Endpoint sanity: only http(s) URLs up to the backend's bounds are ever
   fetched — a javascript: or data: value in config simply disables the rail. */
export function tpValidEndpoint(v) {
  if (typeof v !== "string" || !v || v.length > TP_MAX_ENDPOINT) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === "https:" || u.protocol === "http:";
}

/* ══════════════════════════════════ 2b. markup builders (pure) ═══════
   Every builder is a pure function of validated data → HTML string. The rail
   only ever passes values that came through the parsers above, and these
   builders esc() everything interpolated, so no response field can inject
   markup. Exported so the test suites can assert on exact output. */

const TP_COPY_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

/* Copy button in the app's shared shape: data-copy-text is picked up by the
   existing delegated handler (it needs the inner <span> to swap its label). */
export function tpCopyBtn(value, label, aria) {
  return `<button class="copy" type="button" data-copy-text="${esc(value)}" data-copy-label="${esc(label)}" title="${esc(aria)}" aria-label="${esc(aria)}">${TP_COPY_SVG}<span>Copy</span></button>`;
}

/* Discovery → <option> list. Unselectable networks stay VISIBLE (the payer
   can see they exist) but are disabled with the reason appended — this is
   how "prevent unsupported combos" is enforced before a request is made. */
export function tpNetworkOptionsHtml(nets, selected) {
  if (!Array.isArray(nets)) return "";
  return nets
    .map((n) => {
      const info = TP_AVAILABILITY[n.availability];
      const suffix = n.pickable ? "" : ` — ${info ? info.label : "unavailable"}`;
      const title = n.name || n.blockchain; // name is nullable by contract
      return `<option value="${esc(n.blockchain)}"${n.pickable ? "" : " disabled"}${
        n.blockchain === selected && n.pickable ? " selected" : ""
      }>${esc(title)}${esc(suffix)}</option>`;
    })
    .join("");
}

/* The chosen network → its tokens ONLY. The list is rebuilt from discovery
   on every network change, so a token can never be paired with a network it
   does not belong to (the Worker would refuse it — this just refuses first). */
export function tpTokenOptionsHtml(nets, blockchain, selectedAsset) {
  const n = Array.isArray(nets) ? nets.find((x) => x.blockchain === blockchain && x.pickable) : null;
  if (!n || n.tokens.length === 0) {
    return `<option value="" disabled selected>no tokens available</option>`;
  }
  return n.tokens
    .map(
      (t) =>
        `<option value="${esc(t.assetId)}"${t.assetId === selectedAsset ? " selected" : ""}>${esc(
          t.symbol
        )} · ${t.decimals} decimals</option>`
    )
    .join("");
}

/* Availability caption under the network select: plain words, and it names
   the network so the choice is unambiguous on a narrow screen. */
export function tpAvailabilityHtml(nets, blockchain) {
  const n = Array.isArray(nets) ? nets.find((x) => x.blockchain === blockchain) : null;
  if (!n) return "";
  const info = TP_AVAILABILITY[n.availability];
  const label = info ? info.label : "unverified";
  const tone = info && info.pick ? "tp-avail ok" : "tp-avail err";
  const title = n.name || n.blockchain; // name is nullable by contract
  return `<span class="${tone}">${esc(title)}: ${esc(label)}</span>`;
}

/* The deposit instruction block: the three things a payer needs (amount,
   address, deadline) plus the sentence that keeps the deposit address and
   the merchant's NEAR payout address from ever being confused. Renders ONLY
   allowlisted intent fields — never a signature, correlation id or hash,
   whatever else the response carried. */
export function tpInstructionsHtml(intent, nowMs) {
  if (!intent) return "";
  const src = intent.source;
  const expected = tpFormatBase(intent.expectedInputAmount, src.decimals);
  const min = tpFormatBase(intent.minInputAmount, src.decimals);
  const dl = tpDeadlineInfo(intent.quoteDeadline, nowMs);
  const minNote = min && expected && min !== expected ? ` (minimum ${min})` : "";
  const rows = [];
  rows.push(`<div class="tp-ih">Deposit instructions</div>`);
  rows.push(
    `<p class="tp-need">Send <strong>${esc(expected)} ${esc(src.symbol)}</strong>${esc(
      minNote
    )} on ${esc(src.blockchain)} to:</p>`
  );
  rows.push(
    `<div class="tp-code"><code title="${esc(intent.depositAddress)}">${esc(
      intent.depositAddress
    )}</code>${tpCopyBtn(intent.depositAddress, "Address copied!", "Copy deposit address")}</div>`
  );
  if (intent.depositMemo) {
    rows.push(
      `<div class="tp-code"><code title="${esc(intent.depositMemo)}">${esc(
        intent.depositMemo
      )}</code>${tpCopyBtn(intent.depositMemo, "Memo copied!", "Copy deposit memo")}</div>`
    );
  }
  if (dl) {
    rows.push(
      `<p class="tp-deadline${dl.warn ? " warn" : ""}">${esc(dl.text)}${
        dl.expired
          ? " — request a new quote before sending anything."
          : " — a deposit that arrives after the deadline may not be matched."
      }</p>`
    );
  }
  rows.push(
    `<p class="tp-fine">Only the address above receives this deposit, on ${esc(
      src.blockchain
    )}, for this quote alone. It is <strong>not</strong> the merchant's NEAR address (<code>${esc(
      intent.merchant
    )}</code>): after verification the merchant is paid in ${esc(
      intent.destination.symbol
    )} on NEAR automatically &mdash; never send funds there yourself.</p>`
  );
  return `<div class="tp-instr">${rows.join("")}</div>`;
}

/* The VERIFIED receipt — the only celebratory block in this module, and it
   exists only for VERIFIED. It is the SINGLE success surface in the panel:
   the state label and its detail live here exactly once (never echoed by a
   second status line), followed by the verifiable facts and the one-click
   PDF button, which app.js handles through its delegated click router. */
export function tpReceiptHtml(status, facts) {
  const v = status || TP_STATES.VERIFIED;
  return `<div class="tp-receipt tx-line ok" role="status"><strong>${esc(v.label)}</strong><span>${esc(
    v.detail
  )}</span>${tpReceiptRowsHtml(facts)}${tpReceiptFootHtml(facts)}</div>`;
}

/* Label → value rows. Every value is a fact the caller already holds —
   nothing is derived here, and a row with no value simply does not render. */
function tpReceiptRowsHtml(facts) {
  if (!facts) return "";
  const rows = [];
  if (facts.amountLabel) rows.push(["Amount received", facts.amountLabel]);
  if (facts.time) rows.push(["Verified", new Date(facts.time).toLocaleString()]);
  if (facts.reference) rows.push(["Payment reference", facts.reference]);
  if (facts.invoice) rows.push(["Invoice", facts.invoice]);
  if (!rows.length) return "";
  return `<div class="rcpt-rows">${rows
    .map(([k, v]) => `<span class="rcpt-k">${esc(k)}</span><span class="rcpt-v">${esc(v)}</span>`)
    .join("")}</div>`;
}

/* The closing line (the sentence the receipt is known by), the explorer
   link to the invoice, and the PDF button. */
function tpReceiptFootHtml(facts) {
  const sig = facts && facts.sentence ? `<span class="rcpt-sig">${esc(facts.sentence)}</span>` : "";
  const x =
    facts && facts.explorerUrl
      ? `<a class="rcpt-x" href="${esc(facts.explorerUrl)}" target="_blank" rel="noopener">View invoice on NEAR explorer</a>`
      : "";
  return `${sig}<div class="rcpt-foot">${x}<button class="btn btn-sm rcpt-pdf" type="button" data-receipt-pdf="cross"><span>Download PDF receipt</span></button></div>`;
}

/* ══════════════════════════════ 3. the rail ═════════════════════════
   createTidepoolRail(deps) is fully injectable — fetch, clock, storage,
   timers, visibility/activity predicates, the DOM lookup and the callbacks —
   so the test suites drive the exact production code with scripted responses
   and a fake element. In the browser, app.js wires the singleton below. */

export function createTidepoolRail(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
  const unschedule = deps.unschedule || ((h) => clearTimeout(h));
  const isActive = deps.isActive || (() => true);
  const isVisible = deps.isVisible || (() => typeof document === "undefined" || !document.hidden);
  const getEl =
    deps.getEl || ((id) => (typeof document !== "undefined" ? document.getElementById(id) : null));
  const cryptoObj = deps.crypto || (typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null);

  const S = {
    enabled: false,
    endpoint: "",
    /* Where an invoice can be read back on chain — only used to put an
       explorer link on the receipt; empty (tests, no config) hides it. */
    explorer: "",
    contractId: "",
    linkId: null,
    ctx: { st: null, mine: false, accountId: null, amountLabel: null },
    panelOpen: false,
    nets: null,
    netsFetching: false,
    netsErr: null,
    form: { blockchain: "", assetId: "", refundTo: "" },
    formErr: "",
    quoting: false,
    idemKey: null,      // one per attempt: born on first press, reused on retry
    quoteErr: null,
    progressNote: null,
    journey: null,     // {linkId, intentId, refundTo, assetId, blockchain, at} — persisted
    intent: null,      // validated publicIntent — memory only
    status: null,      // validated status view — memory only
    lastStatusMsg: null,
    errCount: 0,
    retryAfterSec: null,
    verifiedNotified: false,
    staleNotified: false,
    pollTimer: null,
    inFlight: false,
    boundWrap: null,
    boundVisibility: false,
    onVerified: deps.onVerified || (() => {}),
    onInvoiceStale: deps.onInvoiceStale || (() => {}),
    onActionsChanged: deps.onActionsChanged || (() => {}),
  };

  /* ── persistence: the journey only, never instructions ─────────────── */
  const store = () => {
    if (deps.storage) return typeof deps.storage === "function" ? deps.storage() : deps.storage;
    try {
      return typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch {
      return null;
    }
  };
  function readJourney() {
    try {
      const s = store();
      if (!s) return null;
      return tpValidJourney(JSON.parse(s.getItem(TP_STORE_KEY) || "null"));
    } catch {
      return null;
    }
  }
  function writeJourney(j) {
    try {
      const s = store();
      if (!s) return;
      if (j) s.setItem(TP_STORE_KEY, JSON.stringify(j));
      else s.removeItem(TP_STORE_KEY);
    } catch {
      /* private mode: resume simply does not survive a reload */
    }
  }

  /* ── small plumbing ────────────────────────────────────────────────── */
  const changed = () => {
    try {
      S.onActionsChanged();
    } catch {
      /* a repaint failure must never break the payment state machine */
    }
  };

  function stopPoll() {
    if (S.pollTimer != null) {
      unschedule(S.pollTimer);
      S.pollTimer = null;
    }
  }

  async function fetchWithTimeout(url, init, ms) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), ms) : null;
    try {
      return await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init);
    } finally {
      if (to) clearTimeout(to);
    }
  }

  const statusUrl = () =>
    `${S.endpoint}/status?linkId=${encodeURIComponent(S.journey.linkId)}&id=${encodeURIComponent(
      S.journey.intentId
    )}`;

  /* ── the pay-action gate ─────────────────────────────────────────────
     null            → the normal NEAR buttons render untouched
     "checking"      → a quote/resume is in flight: block, show nothing yet
     "active"        → an attempt is unresolved (or its status is unknown):
                       block, point at the panel
     "verified"      → VERIFIED: never offer another payment
     "conflict"      → invoice already PAID/CLAIMED while this attempt is
                       not VERIFIED: warn, never offer another payment */
  function blockReason() {
    if (!S.enabled || !S.linkId) return null;
    if (S.quoting) return "checking";
    if (!S.journey || S.journey.linkId !== S.linkId) return null;
    const st = S.status ? S.status.status : S.intent ? S.intent.status : null;
    if (st === TP_VERIFIED) return "verified";
    const invoicePaid =
      S.ctx.st === "PAID" ||
      S.ctx.st === "CLAIMED" ||
      (S.status && (S.status.onChainStatus === "PAID" || S.status.onChainStatus === "CLAIMED"));
    if (invoicePaid) return "conflict";
    if (st && TP_TERMINAL.has(st)) return null; // EXPIRED / REFUNDED / FAILED
    return "active"; // non-terminal, or status not yet known → uncertain → block
  }

  const TP_BLOCK_TEXT = {
    /* The gate line only does the gate's job: the full verification lives
       in the receipt inside the panel, so this never repeats its headline. */
    verified: "Nothing more to pay for this invoice.",
    conflict:
      "This invoice is already marked <strong>paid</strong> — do not send another payment. Paylink is treating the mismatch as a reconciliation item.",
    checking: "Checking your existing cross-chain payment…",
    active:
      "A cross-chain payment for this invoice is in progress — its progress is shown below, and the Pay button stays off until this attempt resolves.",
  };

  function blockHtml() {
    const r = blockReason();
    if (!r) return "";
    const role = r === "conflict" ? "alert" : "status";
    const cls =
      r === "verified" ? "tx-line ok" : r === "conflict" ? "tx-line err" : "tx-line pending";
    return `<div class="${cls}" role="${role}">${TP_BLOCK_TEXT[r]}</div>`;
  }

  /* The secondary toggle in the pay actions. Never rendered while the rail
     is disabled, while it is blocked (the panel is pinned open then), or for
     the payee. The primary NEAR button's markup is not touched anywhere. */
  function toggleHtml() {
    if (!S.enabled || !S.linkId || S.ctx.mine) return "";
    if (blockReason()) return "";
    return `<button class="btn btn-sm tp-toggle" type="button" data-tp-toggle aria-expanded="${
      S.panelOpen ? "true" : "false"
    }"><span>${S.panelOpen ? "Hide cross-chain pay" : "Pay from another chain"}</span></button>`;
  }

  function toggle() {
    S.panelOpen = !S.panelOpen;
    if (S.panelOpen && !S.nets && !S.netsFetching) loadNetworks();
    render();
    changed();
  }

  /* ── discovery ─────────────────────────────────────────────────────── */
  function pickDefaults() {
    const nets = S.nets || [];
    const n =
      nets.find((x) => x.pickable && x.blockchain === S.form.blockchain) ||
      nets.find((x) => x.pickable);
    if (!n) {
      S.form.blockchain = "";
      S.form.assetId = "";
      return;
    }
    S.form.blockchain = n.blockchain;
    if (!n.tokens.some((t) => t.assetId === S.form.assetId)) {
      S.form.assetId = n.tokens[0] ? n.tokens[0].assetId : "";
    }
  }

  async function loadNetworks(force) {
    if (!S.enabled || S.netsFetching) return;
    if (S.nets && !force) return;
    S.netsFetching = true;
    S.netsErr = null;
    render();
    try {
      const res = await fetchWithTimeout(
        `${S.endpoint}/networks`,
        { headers: { accept: "application/json" } },
        15000
      );
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      S.netsFetching = false;
      if (!(res && Number.isInteger(res.status) && res.status >= 200 && res.status < 300)) {
        const c = tpClassify(res && res.status, res && res.headers, body, now());
        S.netsErr = (c.error && typeof c.error === "string" && c.error) || "The payment service did not answer.";
        render();
        return;
      }
      const nets = tpParseNetworks(body);
      if (!nets) {
        S.netsErr = "The payment service returned an unexpected response.";
        render();
        return;
      }
      S.nets = nets;
      pickDefaults();
      render();
    } catch {
      S.netsFetching = false;
      S.netsErr = "Could not reach the payment service — check your connection.";
      render();
    }
  }

  /* ── panel rendering ───────────────────────────────────────────────── */
  const visible = () => S.enabled && !!S.linkId && !S.ctx.mine && S.panelOpen;

  function render() {
    const el = getEl("tpWrap");
    if (!el) return;
    if (S.boundWrap !== el) {
      el.addEventListener("click", onPanelClick);
      el.addEventListener("change", onPanelChange);
      el.addEventListener("input", onPanelInput);
      S.boundWrap = el;
    }
    const html = visible() ? panelHtml() : "";
    if (el.innerHTML === html) return;
    /* Keep the caret where the payer left it across repaints (the deadline
       and poll ticks re-render while they type nothing themselves). */
    const active =
      typeof document !== "undefined" && document.activeElement && el.contains
        ? document.activeElement
        : null;
    const focusId = active && active.id && el.contains(active) ? active.id : null;
    const selStart = active && Number.isFinite(active.selectionStart) ? active.selectionStart : null;
    const selEnd = active && Number.isFinite(active.selectionEnd) ? active.selectionEnd : null;
    el.innerHTML = html;
    if (focusId && typeof el.querySelector === "function") {
      const again = el.querySelector(`#${focusId}`);
      if (again && typeof again.focus === "function") {
        again.focus();
        if (selStart != null && typeof again.setSelectionRange === "function") {
          try {
            again.setSelectionRange(selStart, selEnd);
          } catch {
            /* non-text input */
          }
        }
      }
    }
  }

  function onPanelClick(e) {
    const btn = e && e.target && e.target.closest ? e.target.closest("[data-tp-action]") : null;
    if (!btn) return;
    const a = btn.dataset.tpAction;
    if (a === "quote") startQuote({ reuse: false });
    else if (a === "details") showDetails();
    else if (a === "restart") restart();
    else if (a === "recheck") recheck();
    else if (a === "retry-nets") loadNetworks(true);
  }

  function onPanelChange(e) {
    const id = e && e.target ? e.target.id : "";
    if (id === "tpNet") {
      S.form.blockchain = typeof e.target.value === "string" ? e.target.value : "";
      const n = (S.nets || []).find((x) => x.pickable && x.blockchain === S.form.blockchain);
      if (!n || !n.tokens.some((t) => t.assetId === S.form.assetId)) {
        S.form.assetId = n && n.tokens[0] ? n.tokens[0].assetId : "";
      }
      S.formErr = "";
      render();
    } else if (id === "tpTok") {
      S.form.assetId = typeof e.target.value === "string" ? e.target.value : "";
      S.formErr = "";
    }
  }

  function onPanelInput(e) {
    if (e && e.target && e.target.id === "tpRef") {
      S.form.refundTo = typeof e.target.value === "string" ? e.target.value : "";
      if (S.formErr) {
        S.formErr = "";
        render();
      }
    }
  }

  function quoteErrBlock() {
    if (!S.quoteErr) return "";
    const bits = [esc(S.quoteErr.message)];
    if (S.quoteErr.hint) bits.push(`<span class="tp-hint">${esc(S.quoteErr.hint)}</span>`);
    if (S.quoteErr.retryAfterSec != null) {
      bits.push(`<span class="tp-hint">Try again in ${S.quoteErr.retryAfterSec}s.</span>`);
    }
    return `<div class="tx-line err" role="alert">${bits.join("")}</div>`;
  }

  function formHtml() {
    const out = [];
    if (S.progressNote) {
      out.push(`<div class="tx-line" role="status">${esc(S.progressNote)}</div>`);
    }
    if (S.netsFetching && !S.nets) {
      out.push(`<div class="tx-line pending" role="status">Loading available networks&hellip;</div>`);
      return `<div class="tp-body">${out.join("")}</div>`;
    }
    if (S.netsErr) {
      out.push(`<div class="tx-line err" role="alert">${esc(S.netsErr)}</div>`);
      out.push(
        `<button class="btn btn-sm" type="button" data-tp-action="retry-nets"><span>Try again</span></button>`
      );
      return `<div class="tp-body">${out.join("")}</div>`;
    }
    if (!S.nets || !S.nets.some((n) => n.pickable)) {
      out.push(
        `<div class="tx-line" role="status">No networks are available for cross-chain payment right now. Use the NEAR button instead.</div>`
      );
      out.push(
        `<button class="btn btn-sm" type="button" data-tp-action="retry-nets"><span>Check again</span></button>`
      );
      return `<div class="tp-body">${out.join("")}</div>`;
    }
    pickDefaults();
    out.push(quoteErrBlock());
    out.push(`
      <div class="tp-fields">
        <div class="field">
          <label class="label" for="tpNet">pay from</label>
          <select id="tpNet">${tpNetworkOptionsHtml(S.nets, S.form.blockchain)}</select>
          ${tpAvailabilityHtml(S.nets, S.form.blockchain)}
        </div>
        <div class="field">
          <label class="label" for="tpTok">token</label>
          <select id="tpTok">${tpTokenOptionsHtml(S.nets, S.form.blockchain, S.form.assetId)}</select>
        </div>
        <div class="field">
          <label class="label" for="tpRef">refund address <span class="tiny">&mdash; where funds return if this attempt fails</span></label>
          <input id="tpRef" type="text" autocomplete="off" spellcheck="false" maxlength="128"
            placeholder="your.near.account or 0x&hellip;" value="${esc(S.form.refundTo)}">
        </div>
      </div>`);
    if (S.formErr) out.push(`<p class="tp-err" role="alert">${esc(S.formErr)}</p>`);
    out.push(
      `<button class="btn btn-sm" type="button" data-tp-action="quote"${
        S.quoting ? " disabled" : ""
      }><span>${S.quoting ? "Getting quote&hellip;" : "Get quote"}</span></button>`
    );
    out.push(
      `<p class="tp-fine">The amount is fixed by the invoice on chain — this form only chooses where the deposit comes from and where a refund would return.</p>`
    );
    return `<div class="tp-body">${out.join("")}</div>`;
  }

  function actionsHtml(st, view) {
    const acts = [];
    const hasIntent = !!S.intent;
    if (st === "CREATING" && S.journey && S.journey.at && now() - S.journey.at > 90000) {
      acts.push(`<button class="btn btn-sm" type="button" data-tp-action="restart"><span>Start over</span></button>`);
    }
    if (TP_TERMINAL.has(st) && st !== TP_VERIFIED) {
      acts.push(`<button class="btn btn-sm" type="button" data-tp-action="restart"><span>Request a new quote</span></button>`);
    }
    if (!hasIntent && TP_REUSE_SET.has(st)) {
      acts.push(`<button class="btn btn-sm" type="button" data-tp-action="details"><span>Show deposit details</span></button>`);
    }
    if (st === "UNKNOWN" || S.lastStatusMsg) {
      acts.push(`<button class="btn btn-sm" type="button" data-tp-action="recheck"><span>Check again</span></button>`);
    }
    if (!acts.length) return "";
    return `<div class="tp-actions">${acts.join("")}</div>`;
  }

  /* Everything the receipt may state — facts only, straight from the
     validated status view, the journey and the card's own context. No
     value is derived or invented; missing facts simply omit their row. */
  function receiptFacts() {
    const t =
      S.status && S.status.updatedAt
        ? S.status.updatedAt
        : S.intent && S.intent.updatedAt
          ? S.intent.updatedAt
          : null;
    return {
      amountLabel: (S.ctx && S.ctx.amountLabel) || null,
      time: t && Number.isFinite(Date.parse(t)) ? t : null,
      reference: (S.journey && S.journey.intentId) || null,
      invoice: S.linkId || null,
      explorerUrl:
        S.explorer && S.contractId ? `${S.explorer}/accounts/${encodeURIComponent(S.contractId)}` : null,
      sentence: RECEIPT_SENTENCE,
    };
  }

  function journeyHtml() {
    const out = [];
    if (S.progressNote) {
      out.push(`<div class="tx-line" role="status">${esc(S.progressNote)}</div>`);
    }
    const st = S.status ? S.status.status : S.intent ? S.intent.status : "";
    const view = tpStateView(st);
    if (view) {
      if (st === TP_VERIFIED) {
        /* ONE success surface: the receipt carries the state label and its
           detail exactly once — the panel must never echo "Payment
           verified" on a second line right above it. */
        out.push(tpReceiptHtml(view, receiptFacts()));
      } else {
        const tone = view.tone === "neutral" ? "" : ` ${view.tone}`;
        const role = view.tone === "err" ? "alert" : "status";
        out.push(`<div class="tx-line${tone}" role="${role}">${esc(view.label)}</div>`);
        out.push(`<p class="tp-detail">${esc(view.detail)}</p>`);
        /* The upstream line speaks only when it ADDS to the intent state:
           dropped when it would restate the label (AWAITING_DEPOSIT already
           says "waiting for the deposit"), and never at VERIFIED, where
           Tidepool's claim is superseded by the receipt above. */
        const up = S.status && S.status.tidepoolStatus;
        if (up && TP_TIDEPOOL_DETAIL[up] && !(st === "AWAITING_DEPOSIT" && up === "PENDING_DEPOSIT")) {
          out.push(`<p class="tp-upstream">${esc(TP_TIDEPOOL_DETAIL[up])}</p>`);
        }
        /* The countdown lives in the deposit instructions — its single home.
           Rendering it here too printed the deadline line twice. */
      }
    } else {
      out.push(`<div class="tx-line pending" role="status">Restoring your payment&hellip;</div>`);
    }

    if (S.lastStatusMsg) {
      const when =
        S.retryAfterSec != null
          ? `Retrying in ${S.retryAfterSec}s.`
          : "Retrying automatically.";
      out.push(
        `<div class="tx-line err" role="alert">${esc(S.lastStatusMsg.message)}<span class="tp-hint">${
          esc(S.lastStatusMsg.hint || "") ? esc(S.lastStatusMsg.hint) + " " : ""
        }${esc(when)}</span></div>`
      );
    }

    const conflictKind = S.status && S.status.conflict ? S.status.conflict.kind : null;
    const invoicePaid =
      S.ctx.st === "PAID" ||
      S.ctx.st === "CLAIMED" ||
      (S.status && (S.status.onChainStatus === "PAID" || S.status.onChainStatus === "CLAIMED"));
    if (st !== TP_VERIFIED && (conflictKind || invoicePaid)) {
      out.push(
        `<div class="tx-line err" role="alert">${esc(tpConflictText(conflictKind))}</div>`
      );
    }

    if (S.intent && !TP_TERMINAL.has(st)) out.push(tpInstructionsHtml(S.intent, now()));
    else if (!S.intent && TP_REUSE_SET.has(st)) {
      out.push(
        `<p class="tp-fine">Deposit details are re-fetched from the service after a reload.</p>`
      );
    } else if (!S.intent && st === "CREATING") {
      out.push(`<p class="tp-fine">Deposit details appear once the quote is ready.</p>`);
    }

    out.push(
      `<p class="tp-fine">Invoice on chain: <strong>${
        S.ctx.st ? esc(S.ctx.st) : "&mdash;"
      }</strong> · attempt <code>${esc(S.journey.intentId)}</code></p>`
    );
    out.push(actionsHtml(st, view));
    return `<div class="tp-body">${out.join("")}</div>`;
  }

  function panelHtml() {
    const head =
      `<div class="tp-h">Pay from another chain` +
      `<span class="tp-hsub">deposit on one network &middot; merchant paid in NEAR</span></div>`;
    const body = S.journey ? journeyHtml() : formHtml();
    return `<section class="tp-panel" aria-label="Pay from another chain">${head}${body}</section>`;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */
  function init(opts = {}) {
    if (typeof opts.endpoint === "string") {
      S.endpoint = opts.endpoint.trim();
      S.enabled = tpValidEndpoint(S.endpoint);
    }
    if (typeof opts.explorer === "string") S.explorer = opts.explorer.replace(/\/+$/, "");
    if (typeof opts.contractId === "string") S.contractId = opts.contractId.trim();
    if (typeof opts.onVerified === "function") S.onVerified = opts.onVerified;
    if (typeof opts.onInvoiceStale === "function") S.onInvoiceStale = opts.onInvoiceStale;
    if (typeof opts.onActionsChanged === "function") S.onActionsChanged = opts.onActionsChanged;
    if (!S.boundVisibility && typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        if (isVisible() && S.journey && S.linkId && !S.inFlight) ensurePoll(true);
      });
      S.boundVisibility = true;
    }
    render();
    return api;
  }

  async function sync(link, ctx) {
    if (!S.enabled || !link) return;
    const linkId = typeof link.link_id === "string" ? link.link_id : "";
    if (!tpValidLinkId(linkId)) return;
    S.ctx = {
      st: ctx && typeof ctx.st === "string" ? ctx.st : null,
      mine: !!(ctx && ctx.mine),
      accountId: ctx && typeof ctx.accountId === "string" ? ctx.accountId : null,
      /* Pre-formatted invoice amount from the card ("5 USDC"): the rail
         shows it on the receipt without ever parsing base units itself. */
      amountLabel: ctx && typeof ctx.amountLabel === "string" ? ctx.amountLabel : null,
    };
    if (S.linkId !== linkId) {
      stopPoll();
      S.linkId = linkId;
      S.intent = null;
      S.status = null;
      S.quoteErr = null;
      S.formErr = "";
      S.progressNote = null;
      S.quoting = false;
      S.idemKey = null;
      S.errCount = 0;
      S.retryAfterSec = null;
      S.lastStatusMsg = null;
      S.verifiedNotified = false;
      S.staleNotified = false;
      const j = readJourney();
      S.journey = j && j.linkId === linkId ? j : null;
      S.panelOpen = !!S.journey; // a resuming attempt pins the panel open
      if (!S.netsFetching) loadNetworks();
    }
    if (!S.journey && !S.quoting && !S.form.refundTo && S.ctx.accountId) {
      S.form.refundTo = S.ctx.accountId; // prefill the payer's own account
    }
    if (S.ctx.mine) S.panelOpen = false;
    render();
    changed();
    /* Resume-or-continue: with no status yet this is the immediate first
       read; with one it is the planner's next hop (a no-op when a timer is
       already pending, terminal, or the view is inactive/hidden — the
       visibility handler and the next sync pick those back up). */
    if (S.journey && !S.inFlight && !S.quoting) ensurePoll(!S.status);
  }

  function teardown() {
    stopPoll();
    S.linkId = null;
    S.ctx = { st: null, mine: false, accountId: null, amountLabel: null };
    S.panelOpen = false;
    S.intent = null;
    S.status = null;
    render();
    changed();
  }

  /* ── quoting ───────────────────────────────────────────────────────── */
  function validateForm(f) {
    if (!tpValidLinkId(S.linkId || "")) return "This payment link is not valid.";
    if (typeof f.assetId !== "string" || !f.assetId || f.assetId.length > 128) {
      return "Choose a token to pay with.";
    }
    if (typeof f.blockchain !== "string" || !f.blockchain || f.blockchain.length > 64) {
      return "Choose a network to pay from.";
    }
    if (!tpValidRefundTo(f.refundTo)) {
      return "Enter a NEAR account (like alice.testnet) or a 0x address — where a failed attempt would return your funds.";
    }
    return "";
  }

  function failQuote(message, hint, code, retryAfterSec) {
    S.quoting = false;
    S.quoteErr = {
      message,
      hint: hint || "",
      code: code || "",
      retryAfterSec: retryAfterSec != null ? retryAfterSec : null,
    };
    render();
    changed();
  }

  function handleQuoteFailure(c) {
    const { message, hint } = tpErrorMessage(c);
    S.quoting = false;
    S.quoteErr = {
      message,
      hint,
      code: c.code || "",
      retryAfterSec: c.retryAfterSec != null ? c.retryAfterSec : null,
    };
    if (
      /^invoice_/.test(c.code || "") ||
      c.status === 404 ||
      c.code === "payment_verified" ||
      c.code === "payment_settled"
    ) {
      // The invoice changed under us — the card re-reads contract truth.
      try {
        S.onInvoiceStale();
      } catch {
        /* repaint failures never break quoting */
      }
    }
    if (c.code === "payment_verified" || c.code === "payment_settled") {
      if (S.journey) ensurePoll(true); // an attempt exists: status comes first
    }
    render();
    changed();
  }

  /* One press = one attempt. The idempotency key is born on the first press
     of an attempt and REUSED by every retry of it, so a lost response that
     actually committed can only ever be answered with the same intent — a
     second deposit address can never be minted by retrying. */
  async function startQuote(opts = {}) {
    if (!S.enabled || !S.linkId || S.quoting) return; // duplicate press
    const linkId = S.linkId;
    const fields = opts.fields || {
      assetId: S.form.assetId,
      blockchain: S.form.blockchain,
      refundTo: (S.form.refundTo || "").trim(),
    };
    const err = validateForm(fields);
    if (err) {
      if (opts.fields) S.progressNote = err;
      else S.formErr = err;
      render();
      return;
    }
    S.quoting = true;
    S.quoteErr = null;
    S.formErr = "";
    S.progressNote = null;
    if (!S.idemKey) S.idemKey = tpNextIdemKey(cryptoObj);
    render();
    changed();
    try {
      const res = await fetchWithTimeout(
        `${S.endpoint}/quote`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(tpBuildQuoteBody({ linkId, ...fields, idempotencyKey: S.idemKey })),
        },
        20000
      );
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      S.quoting = false;
      const c = tpClassify(res && res.status, res && res.headers, body, now());
      if (!c.ok) {
        handleQuoteFailure(c);
        return;
      }
      const intent = tpParseQuote(body);
      const expect = opts.expectIntentId || (S.journey ? S.journey.intentId : null);
      if (!intent || intent.linkId !== linkId) {
        failQuote(
          "The payment service returned an unexpected response.",
          TP_ERROR_HINTS.bad_shape,
          "bad_shape",
          null
        );
        return;
      }
      if (expect && intent.intentId !== expect) {
        /* The service answered with a DIFFERENT attempt than the one in
           progress: never display it, never persist it, never adopt it —
           status refresh only, and say so. */
        S.idemKey = null;
        S.progressNote =
          "The service answered with a different payment attempt than the one in progress. Nothing was changed — status only. Do not start a new payment.";
        render();
        changed();
        ensurePoll(true);
        return;
      }
      if (!S.journey) {
        S.journey = {
          linkId,
          intentId: intent.intentId,
          refundTo: fields.refundTo,
          assetId: fields.assetId,
          blockchain: fields.blockchain,
          at: now(),
        };
        writeJourney(S.journey);
      }
      S.intent = intent;
      S.status = {
        intentId: intent.intentId,
        linkId,
        status: intent.status,
        tidepoolStatus: intent.tidepoolStatus,
        quoteDeadline: intent.quoteDeadline,
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        conflict: null,
        onChainStatus: typeof body.onChainStatus === "string" ? body.onChainStatus : null,
        changed: false,
      };
      S.idemKey = null; // attempt landed → the next attempt gets a fresh key
      S.quoteErr = null;
      S.progressNote = null;
      S.errCount = 0;
      S.retryAfterSec = null;
      S.lastStatusMsg = null;
      S.panelOpen = true;
      render();
      changed();
      ensurePoll(true);
    } catch {
      failQuote(
        "Could not reach the Paylink payment service.",
        TP_ERROR_HINTS.network,
        "network",
        null
      );
    }
  }

  /* Re-fetch the deposit instructions for a resume without one. Only for
     TP_REUSE_SET states (the backend answers with the SAME active intent) and
     only on an explicit press — this is never automatic. */
  function showDetails() {
    if (!S.journey || S.intent || S.quoting) return;
    const st = S.status ? S.status.status : "";
    if (!TP_REUSE_SET.has(st)) return;
    return startQuote({
      reuse: true,
      fields: {
        assetId: S.journey.assetId,
        blockchain: S.journey.blockchain,
        refundTo: S.journey.refundTo,
      },
      expectIntentId: S.journey.intentId,
    });
  }

  /* Explicit reset. Offered ONLY for terminal non-verified attempts, or a
     CREATING that has sat longer than 90 s (the backend sanctions the
     replacement). Mid-uncertainty the button does not exist — and if it is
     somehow called anyway, this refuses. */
  function restart() {
    if (!S.journey) return;
    const st = S.status ? S.status.status : "";
    const age = S.journey.at ? now() - S.journey.at : 0;
    const allowed = (TP_TERMINAL.has(st) && st !== TP_VERIFIED) || (st === "CREATING" && age > 90000);
    if (!allowed) return;
    stopPoll();
    writeJourney(null);
    S.journey = null;
    S.intent = null;
    S.status = null;
    S.idemKey = null;
    S.errCount = 0;
    S.retryAfterSec = null;
    S.lastStatusMsg = null;
    S.verifiedNotified = false;
    S.staleNotified = false;
    S.quoteErr = null;
    S.formErr = "";
    S.progressNote =
      "Previous attempt cleared. If you had already sent a deposit, its status may still resolve on its own — do not assume it failed.";
    S.panelOpen = true;
    render();
    changed();
  }

  /* Manual re-check — one immediate status read, no faster than the floor
     beyond that (the planner takes over on the next hop). */
  function recheck() {
    if (!S.journey) return;
    S.errCount = 0;
    S.retryAfterSec = null;
    S.lastStatusMsg = null;
    stopPoll();
    ensurePoll(true);
    render();
    changed();
  }

  /* ── status polling ────────────────────────────────────────────────── */
  function ensurePoll(immediate) {
    if (!S.enabled || !S.journey || !S.linkId) return;
    if (S.inFlight || S.pollTimer != null) return;
    if (S.status && TP_TERMINAL.has(S.status.status)) return;
    if (!isActive() || !isVisible()) return; // paused: events resume it
    let delay = TP_POLL.BASE;
    if (immediate) delay = 0;
    else if (S.status) {
      delay = tpNextPoll({
        status: S.status.status,
        retryAfterSec: S.retryAfterSec,
        errCount: S.errCount,
        active: true,
        visible: true,
      });
    }
    if (delay == null) return;
    S.pollTimer = schedule(tick, delay);
  }

  function scheduleNext() {
    if (!S.journey || S.inFlight) return;
    const delay = tpNextPoll({
      status: S.status ? S.status.status : "CREATING",
      retryAfterSec: S.retryAfterSec,
      errCount: S.errCount,
      active: isActive(),
      visible: isVisible(),
    });
    if (delay == null) return;
    S.pollTimer = schedule(tick, delay);
  }

  async function tick() {
    S.pollTimer = null;
    if (!S.enabled || !S.journey || !S.linkId) return;
    if (!isActive() || !isVisible()) return; // paused: resumed by events
    if (S.inFlight) return;                   // never overlap two reads
    S.inFlight = true;
    let c = null;
    let view = null;
    let netErr = false;
    try {
      const res = await fetchWithTimeout(
        statusUrl(),
        { method: "GET", headers: { accept: "application/json" } },
        15000
      );
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      c = tpClassify(res && res.status, res && res.headers, body, now());
      if (c.ok) view = tpParseStatus(body);
    } catch {
      netErr = true;
    } finally {
      S.inFlight = false;
    }
    if (!S.journey) return; // torn down or restarted mid-flight
    if (c && c.ok && view && view.intentId === S.journey.intentId) {
      applyStatus(view);
    } else if (c && !c.ok && c.status === 404 && c.code === "intent_not_found") {
      dropJourney("That payment attempt no longer exists on the service — start again.");
      return;
    } else if (c && !c.ok && c.status === 400) {
      dropJourney("The stored payment attempt was rejected as invalid — start again.");
      return;
    } else {
      /* Any other failure — network, 5xx, malformed body, mismatched id —
         is a RETRY, never a payment failure: back off, say so, keep going. */
      S.errCount = Math.min(S.errCount + 1, 8);
      S.retryAfterSec = c ? c.retryAfterSec : null;
      S.lastStatusMsg = netErr
        ? tpErrorMessage({ code: "network" })
        : c && c.ok
          ? { message: "The payment service returned an unexpected response.", hint: TP_ERROR_HINTS.bad_shape }
          : tpErrorMessage(c);
      render();
      changed();
    }
    scheduleNext();
  }

  function applyStatus(view) {
    S.errCount = 0;
    S.retryAfterSec = null;
    S.lastStatusMsg = null;
    S.status = view;
    const st = view.status;
    const invoicePaid =
      S.ctx.st === "PAID" ||
      S.ctx.st === "CLAIMED" ||
      view.onChainStatus === "PAID" ||
      view.onChainStatus === "CLAIMED";
    if (st === TP_VERIFIED && !S.verifiedNotified) {
      S.verifiedNotified = true;
      S.panelOpen = true; // the receipt is the proof — keep it on screen
      render();
      changed();
      try {
        S.onVerified(S.linkId);
      } catch {
        /* notification failure never breaks the terminal read */
      }
      return;
    }
    if (invoicePaid && st !== TP_VERIFIED && !TP_TERMINAL.has(st) && !S.staleNotified) {
      S.staleNotified = true;
      render();
      changed();
      try {
        S.onInvoiceStale();
      } catch {
        /* repaint failure never breaks polling */
      }
      return;
    }
    render();
    changed();
  }

  function dropJourney(note) {
    stopPoll();
    writeJourney(null);
    S.journey = null;
    S.intent = null;
    S.status = null;
    S.idemKey = null;
    S.errCount = 0;
    S.retryAfterSec = null;
    S.lastStatusMsg = null;
    S.progressNote = note;
    S.panelOpen = true;
    render();
    changed();
  }

  const api = {
    init,
    sync,
    teardown,
    toggle,
    blockReason,
    blockHtml,
    toggleHtml,
    loadNetworks,
    render,
    quote: startQuote,
    details: showDetails,
    restart,
    recheck,
    /* The VERIFIED receipt's facts, for app.js's PDF builder. */
    receiptFacts,
    /* Test seam: the form is normally driven by the panel's own change/input
       listeners; tests set it directly. */
    setForm: (patch) => {
      if (patch && typeof patch === "object") Object.assign(S.form, patch);
      S.formErr = "";
      render();
    },
    snapshot: () => ({
      enabled: S.enabled,
      endpoint: S.endpoint,
      linkId: S.linkId,
      ctx: { ...S.ctx },
      panelOpen: S.panelOpen,
      nets: S.nets,
      netsFetching: S.netsFetching,
      netsErr: S.netsErr,
      form: { ...S.form },
      formErr: S.formErr,
      quoting: S.quoting,
      idemKey: S.idemKey,
      quoteErr: S.quoteErr ? { ...S.quoteErr } : null,
      progressNote: S.progressNote,
      journey: S.journey ? { ...S.journey } : null,
      intent: S.intent ? { ...S.intent } : null,
      status: S.status ? { ...S.status } : null,
      lastStatusMsg: S.lastStatusMsg ? { ...S.lastStatusMsg } : null,
      errCount: S.errCount,
      retryAfterSec: S.retryAfterSec,
      verifiedNotified: S.verifiedNotified,
      staleNotified: S.staleNotified,
      pollTimer: S.pollTimer,
      inFlight: S.inFlight,
      block: blockReason(),
    }),
  };
  return api;
}

/* ══════════════════════════════ 4. singleton ═════════════════════════
   app.js imports these five (plus init) — the module itself never touches
   the DOM at load time, so importing it in Node tests is safe. */

let railSingleton = null;

function railOf() {
  if (!railSingleton) railSingleton = createTidepoolRail({});
  return railSingleton;
}

/* Wire the rail once at boot: the Worker endpoint and the three callbacks
   (verified, invoice changed under us, repaint the pay actions). */
export function initTidepool(opts) {
  return railOf().init(opts || {});
}

/* renderPay calls this for every pay-card render, between the card paint and
   the action buttons, so the buttons see the current block reason. */
export function syncTidepool(link, ctx) {
  return railOf().sync(link, ctx || {});
}

/* The pay card went away (error state, navigation): stop polling. The
   journey itself survives in storage for the next successful render. */
export function teardownTidepool() {
  if (railSingleton) railSingleton.teardown();
}

/* Toggle / gates for renderPayActions. Safe before init: the rail is created
   disabled, which answers "" / null. */
export function tpToggle() {
  return railOf().toggle();
}
export function tpPayBlockReason() {
  return railSingleton ? railSingleton.blockReason() : null;
}
export function tpPayBlockHtml() {
  return railSingleton ? railSingleton.blockHtml() : "";
}
export function tpToggleHtml() {
  return railSingleton ? railSingleton.toggleHtml() : "";
}
/* Facts behind the panel's VERIFIED receipt — amount, time, reference and
   the invoice's explorer URL — or null before the rail exists. app.js turns
   them (plus what only the card knows) into the downloadable PDF. */
export function tpReceiptFacts() {
  return railSingleton ? railSingleton.receiptFacts() : null;
}
