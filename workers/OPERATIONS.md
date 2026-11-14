# Paylink Workers — Operations (M-01)

Monitoring and alerting for the Paylink Cloudflare Workers: **relayer**
(meta-transactions), **keeper** (claim sweep), **parse** (invoice reader)
and **Tidepool** (cross-chain payment rail, §2).
This file is the M-01 report: what is implemented in code and tested, versus
what still requires Cloudflare account configuration. All four Workers run
in production on workers.dev — relayer, keeper, parse and Tidepool (§2) —
so the gap this report tracks is the account-side setup: dashboard saved
queries, Workers Logs retention and webhook secrets, none of which is
configured yet. Every recommendation that needs account setup says so
explicitly and invents no credential values.

---

## 1. The log line (identical in all four Workers)

Every operational event is **one JSON line on stdout**:

```json
{"ts":"2026-11-10T03:27:55.810Z","svc":"paylink-parse","build":"20261110b","level":"error","event":"upstream_error","rid":"7910c9fa","kind":"http_status","status":500,"detail":"…"}
```

| Field   | Meaning |
|---------|---------|
| `ts`    | ISO-8601 UTC timestamp |
| `svc`   | `paylink-relayer` \| `paylink-keeper` \| `paylink-parse` \| `paylink-tidepool` |
| `build` | build stamp — relayer `20261110d`, keeper `20261110f`, parse `20261110b`, tidepool `20261111a` (in log lines only) |
| `level` | `info` \| `warn` \| `error` \| `alert` |
| `event` | catalog name from the tables below |
| …       | event-specific fields, always flat scalars or short string arrays |

Rules enforced by `logEvent` in each worker:

* **Only `level:"alert"` is webhook-eligible.** Warnings and errors are
  logged but never pushed to a channel, so a noisy rejection rate cannot
  spam anyone.
* **Scrub backstop on every string**: `ed25519:` key shapes, `AIza…`
  Google-key shapes, `Bearer …` tokens are redacted, and every string is
  capped at **240 characters** (a full signed delegate or upstream body
  cannot fit). The parse Worker additionally redacts the configured
  `GEMINI_API_KEY` **by value** — upstream error bodies echo it, and an
  arbitrary literal cannot be caught by shape patterns.
* **Delivery failures are swallowed** (3 s timeout, resolve `false`). A dead
  webhook can never break a submission, sweep, parse or Tidepool status
  cycle — the record is always persisted before delivery is awaited.

Correlation ids:

| Worker  | Id | Propagation |
|---------|----|-------------|
| relayer | `rid` (8 hex) | `X-Request-Id` response header + every log line of that request |
| parse   | `rid` (8 hex) | `X-Request-Id` on `POST /` responses + that request's lines |
| keeper  | `run_id` (8 hex) | every line of one sweep + returned in the `/tick` response report |
| tidepool | `rid` (8 hex) | `X-Request-Id` on `/networks`, `/quote`, `/status` responses + that request's lines |

Parse deliberately creates `rid` **after** the OPTIONS/405/404 checks, so
those responses are byte-identical to M-02 output (the `GET /` → `405` +
`Allow: POST` deploy signal is untouched; parse still exposes **no**
`GET /` build stamp — its build lives in log lines).

---

## 2. Event catalog (implemented)

### Relayer — `svc: paylink-relayer`

| Event | Level | Meaning / key fields |
|-------|-------|----------------------|
| `submit_ok` | info | Payment created — `rid`, `ip`, `link_id`, `sender_id`, `hash`, `ms`. Identifiers only: all three are public on chain; never the delegate bytes or payment args. |
| `submit_rejected` | info | Request rejected before/at parse — `rid`, `ip`, `status`, `reason`, `error`. Reasons: `bad_request`, `bad_json`, `body_too_large`, `bad_base64`, `invalid_delegate`, `bad_signature`, `unknown_sender_key`, `stale_nonce`, `expired_delegate`. |
| `rate_limited` | warn | 429 — `rid`, `ip`, `retry_after`, `layer` (`local` \| `binding` \| `binding_period` family; M-07 layers preserved). |
| `service_error` | error | 5xx — `rid`, `ip`, `status`, `reason`, `error`. Reasons include `rpc_access_key`, `rpc_relayers_key`, `balance_low`, `broadcast_failed`, `config_key_missing`, `internal`. |
| `limiter_backend_error` | warn | RATE_LIMITER binding returned garbage/unavailable — local window enforced instead. |
| `volume_anomaly` | **alert** | ≥ **120** `/submit` requests in **60 s** (once per window) — `rid`, `count`, `window_s`. |
| `error_burst` | **alert** | **5** 5xx responses in **5 minutes** (once per window) — `rid`, `count`, `window_s`, `last_status`, `last_reason`. |

Health: `GET /` returns a **fixed key allowlist** —
`{ok, service, contract, account, build, stats}` where `stats` is the
per-isolate counter set `{started, submit, ok, rejected, rate_limited, errors}`.
No `rid`, no IP, no key material ever appears in the health body.

### Keeper — `svc: paylink-keeper`

| Event | Level | Meaning / key fields |
|-------|-------|----------------------|
| `cron_heartbeat` | info (`error` on failure) | Exactly **one per scheduled run** — `run_id`, `ok`, `claimed`, `failed`, `ms`, `error` when failed. **Missed runs are detected by the absence of this line.** |
| `sweep_summary` | info | Every healthy run's final line — `run_id`, `scanned`, `paid`, `claimed`, `failed`, `already_claimed`, `over_cap`, `pages`, `partial`, `ms` (`pages` = view_state calls used by discovery, `partial` = some state unreadable, M-06). |
| `unsettled_paid` | warn | Links still in PAID when the run ended — `run_id`, `count`, `link_ids` (≤ 10). One link settling next minute is normal ⇒ warn, never alert; **the count is the graphable signal**. |
| `scan_partial` | warn | Discovery read only **part** of contract state (M-06: sub-prefix fallback, some pages unreadable) — `run_id`, `pages`, `failed_pages`, `scanned`. What was read is still claimed; the next sweep re-covers the gap from scratch. |
| `scan_degraded` | **alert** | **3rd consecutive** partial scan (exactly at the threshold, once per streak; a full-coverage scan resets it) — `run_id`, `consecutive`, `pages`, `failed_pages`. One bad minute is normal; a persistent hole in discovery is not. |
| `sweep_failed` | error | Contract scan could not run — `run_id`, `error` (scrubbed). The sweep still rethrows, so `/tick` 500s and the heartbeat reads `ok:false`. |
| `sweep_outage` | **alert** | **3rd consecutive** failed scan (exactly at the threshold, once per streak; a healthy scan resets it) — `run_id`, `consecutive`, `error`. |
| `tick_failed` | error | `/tick` failed outside the scan path (e.g. bad `KEEPER_KEY`) — `run_id`, `error`. |
| `invoice_discovered` | info | PAID link found — `link_id`, `run_id`. |
| `claim_submitted` | info | Claim broadcast — `link_id`, `run_id`. |
| `claim_successful` | info | Claim landed — `link_id`, `hash`, `run_id`. |
| `invoice_already_claimed` | info | Released elsewhere between scan and broadcast — `link_id`, `hash`. Not a failure. |
| `claim_failed` | info | Claim reverted / broadcast error — `link_id`, `status` or `error`, `run_id`. |
| `retry_scheduled` | info | Will retry next sweep (or sweep cap / missing key). |
| `repeated_claim_failure` | **alert** | **3rd consecutive** failed claim for the *same* link (per-isolate streak; success/already-claimed clears it) — `link_id`, `consecutive`, `reason`. |

Health: `GET /` returns `{ok, service, contract, account, build}` — fixed
allowlist, no run detail.

### Parse — `svc: paylink-parse`

| Event | Level | Meaning / key fields |
|-------|-------|----------------------|
| `parse_ok` | info | Successful reading — `rid`, `ip`, `source` (`text`\|`file`), `chars`, `model`, `ms`. **Parsed field values are never logged** (amount/payee/description are payment details and there is no safe identifier at parse time). |
| `parse_rejected` | info (`error` for `key_missing`) | Admission reject — `rid`, `ip`, `status`, `reason`, `error`. Reasons: `origin_not_allowed`, `rate_limited` path separate, `body_too_large`, `bad_content_type`, `key_missing`, `bad_body`, `bad_json`, `bad_object`, `text_too_long`, `unsupported_file`, `file_too_large`, `bad_base64`, `no_content`. Response bodies/statuses are byte-identical to M-02. |
| `rate_limited` | warn | 429 — `rid`, `ip`, `retry_after: 60`. |
| `upstream_error` | error | Gemini failure — `rid`, `kind` ∈ `http_status`, `unreachable`, `timeout`, `unreadable`, `no_reading`, `bad_payload`, plus `status` and ≤ 240-char **scrubbed** `detail`. |
| `upstream_degraded` | **alert** | **5** upstream failures in **5 minutes** (once per window) — `rid`, `count`, `window_s`. |
| `service_error` | error | Unexpected exception — `method`, `error`; client gets a generic 500, stack stays server-side. |

### Tidepool — `svc: paylink-tidepool`

Same envelope as every worker above (`ts`, `svc`, `build`, `level`, `event`,
plus `rid` on every request-scoped line). **Deployed** as
`paylink-tidepool` (workers.dev, version `98f6e7ab`, Durable Object
migration `v1` / SQLite-backed `PaymentIntent`); these rows describe the
code running in `workers/tidepool/`. Routes are `GET /networks`,
`POST /quote`, `GET /status` (there is no health route in this scope).
`GET /status` has two forms: `?id=<intentId>&linkId=<linkId>` — the full
capability read — and `?linkId=<linkId>` alone — the public **settlement
summary** `{ok, settlement:{intentId, status, depositSeenAt, verifiedAt,
payoutTx[]}, onChainStatus, onChainStatusCheckedAt}` (404
`settlement_not_found` when the invoice has no record or no intents).
The summary exists because a cross-chain payout pays `link.creator`
directly and leaves the invoice `OPEN` by design (only `ft_on_transfer`
writes it): it is a record read with **zero upstream calls**, keyed by
the public invoice id, silent on success, and never carries deposit
address, memo, refund, signature, correlation id, swapDetails or
history. `payoutTx` is served only once the intent is `VERIFIED` — each
entry re-validated as a 32-byte base58 NEAR hash — because before that
the captured candidates are not proof.

| Event | Level | Meaning / key fields |
|-------|-------|----------------------|
| `networks_ok` | info (`warn` when `dropped` > 0) | `GET /networks` served — `rid`, `ip`, `chains`, `tokens`, `dropped`, `cached`, `ms`. `cached:true` means the isolate cache answered. |
| `networks_rejected` | info | 403 origin gate on `/networks` — `rid`, `ip`, `status`, `reason: origin_not_allowed`. |
| `upstream_error` | error | `/v0/tokens` or `/v0/health` failed during discovery — `rid`, `target` (`tokens`\|`health`), `kind`, `status`, `detail` (≤ 400 chars, scrubbed; never in the response body). |
| `quote_ok` | info | Quote issued (201) or the invoice's active intent reused (200) — `rid`, `ip`, `linkId`, `intentId`, `reused`, `state`, `ms`. |
| `quote_rejected` | info | Client-visible rejection — `rid`, `ip`, `linkId`, `status`, `code`, `reason`. Codes: `origin_not_allowed`, `invalid_link`, `invalid_token_meta`, `invalid_refund_to`, `invalid_idempotency_key`, `same_asset_source`, `network_token_mismatch`, `invoice_settled`, `invoice_cancelled`, `invoice_expired`, `invoice_not_open`, `invoice_token_unsupported`, `invoice_expiry_too_soon`, `payment_verified`, `payment_settled`, `intent_history_full`, `payload_too_large`. |
| `quote_deposit_mode_retry` | info | The ONE data-driven retry: a 400 naming `depositMode` re-sent once with `depositMode:"MEMO"` — `reason: deposit_mode_memo_required`. A 400 created no quote, so the retry cannot duplicate one. |
| `quote_upstream_error` | error (`warn` for `unmapped_status`) | A read failed on the quote path — `rid`, `linkId`, `target` (`contract`\|`tokens`\|`quote`\|`status`), `kind`, `status`, `detail` (scrubbed, bounded). `status` here is the reconcile path (POST /quote re-reading `/v0/status`), not GET /status. |
| `intent_transition` | info | State machine moved — `rid`, `linkId`, `intentId`, `from`, `to`, `reason` (e.g. `creation_started`, `quote_verified`, `awaiting_deposit`, `tidepool_SUCCESS`, `no_deposit_past_deadline`, `status_resolved`). One line per accepted transition; duplicates are refused silently. |
| `status_ok` | info | A `GET /status` poll that **changed** something — `rid`, `ip`, `linkId`, `intentId`, `status`, `tidepoolStatus`, `conflict`, `ms`. Unchanged polls are silent by design: a 2-second watcher can never burn the log budget (the transition itself already logged `intent_transition`). |
| `status_rejected` | info | `GET /status` request rejected — `rid`, `ip`, `status`, `linkId`, `code`, `reason`. Fires only for 400/403/404 (`invalid_link_id`, `invalid_intent_id`, `origin_not_allowed`, `intent_not_found`, `settlement_not_found`); cooldown 503s never log here (their cause already logged `status_upstream_error`). Settlement-summary reads (linkId-only, no `id`) that succeed are silent, same log-budget rule as `status_ok`. |
| `status_upstream_error` | error (`warn` for the contract leg, `unmapped_status`, `transition_refused`) | A read failed inside a status cycle — `rid`, `linkId`, `intentId`, `target` (`status`\|`contract`), `kind`, `status`. The contract leg failing never fails the response (last known state kept, `onChainCheckedAt` not advanced); the status leg failing parks the intent in RECONCILE with a persisted cooldown. Never logs a raw upstream body on this path. |
| `invoice_conflict` | **alert** | Cross-provider double-pay risk detected: the NEAR invoice went `PAID`/`CLAIMED` while a Tidepool intent was still in flight — `rid`, `linkId`, `intentId`, `previous`, `onChainStatus`. Logged **once** per record; the `conflict` flag then rides on every `/status` response and polling continues (only observation reveals whether the double pay actually happened). During Phase 5 verification the same line fires from the fresh pre-transition contract read (same shape, same once-per-record rule). Alert delivery: see the note below the table. |
| `payout_verify_ok` | info | Phase 5: `SETTLED → VERIFIED` — authoritative NEAR tx evidence proved exactly one successful `ft_transfer` of the invoice amount to the merchant on the configured USDC token, and the fresh `get_link` immediately before the move still authorized it — `rid`, `linkId`, `intentId`, `attempts` (prior held attempts). One line per verification; `intent_transition` also fires for the move itself. |
| `payout_verify_hold` | warn | Phase 5: a verification attempt (or a candidate-less SETTLED hold) did not — or could not — prove the payout, so the intent stays `SETTLED` — `rid`, `linkId`, `intentId`, `reason`. **Logged once per distinct reason** per intent (repeats are silent; the reason changes ⇒ one new line). Reason codes only, never a hash, amount or address: `no_payout_hash`, `evidence_pending`, `no_transfer_evidence`, `transfer_failed`, `evidence_malformed`, `evidence_mismatch`, `rpc_inconclusive`, `contract_inconclusive`, `invoice_mismatch`, `invoice_paid`, `double_payout`, `payout_reversed`, `transition_refused`. Every hold is retryable with backoff (`TIDEPOOL_VERIFY_BACKOFF_MS`, doubling to 1 h) or — for conflicts — a manual-reconciliation hold. |
| `payout_conflict` | **alert** | Phase 5: the payout evidence itself proved a money conflict — `rid`, `linkId`, `intentId`, `kind` (`double_payout`\|`payout_reversed`). The conflict is persisted on the record (rides on every `/status` response), the intent is **never** auto-verified, and all further cycles are zero-read holds until an operator reconciles. Alert delivery: see the note below the table. |
| `record_invalid` | **alert** | Phase 6: a persisted payment record failed type/shape validation — `rid`, `linkId`, `intentId` (`null` for record/pointer-level findings), `reason` (machine code only; **the corrupt value itself is never logged**). **Logged once per distinct reason per record** — repeats answer identically with no second line and no re-write. Reasons: `status_invalid` (quarantined to `RECONCILE` with an `intent_transition` of `record_malformed`), `deposit_address_invalid`, `deposit_memo_invalid`, `quote_deadline_invalid`, `merchant_invalid`, `amount_invalid`, `meta_invalid`, `correlation_invalid`, `tidepool_status_invalid`, `reason_invalid`, `link_invalid`, `intent_invalid` (intent held in place, 503 `record_invalid`), `history_invalid`, `conflict_invalid` (stamped, non-blocking — but a malformed conflict still blocks verification), `intents_invalid`, `active_intent_unresolvable`, `active_intent_missing`. Operator procedure: §10. Alert delivery: see the note below the table. |
| `service_error` | error | Unexpected exception or intent-store failure — `method`, `error` (scrubbed), or `rid` + `error: intent store failed` / `INTENT_DO binding missing`. Client gets a generic 500; stack stays server-side. |

This worker emits **three alert-level events** — `invoice_conflict`,
`payout_conflict` and `record_invalid` — delivered through the same
`ALERT_WEBHOOK_URL` mechanism as the other Workers (§4 Tier 1). Order and
failure handling are pinned by tests: the conflict/quarantine is
**persisted before** the delivery is awaited (persist-before-notify), the
console line is **always written first** (Tier 0 log-only never depends on
the webhook), delivery is best-effort with a 3 s timeout, and any failure
is swallowed — a dead webhook cannot affect payment state, the response,
or the repeat behaviour. **The secret is not configured yet** (account-side
setup: §5 step 2), so today these events are log-only. Two limitations:
the destination must be **private** — the payload carries `linkId` +
`intentId`, which together are the `GET /status` read capability for that
payment (fields are the log line itself: machine reason codes only, no
amounts, addresses or hashes) — and delivery is **single-shot** (each
event fires once per record/distinct reason; nothing re-emits it if the
POST fails). Until the secret is set, §3b's saved queries are the
visibility mechanism, on 3-day free retention.

---

## 3. Alert conditions — implemented vs. recommended

### 3a. Implemented in code (fire automatically once deployed; log always,
webhook only if `ALERT_WEBHOOK_URL` is set)

| Worker | Alert | Threshold | State model |
|--------|-------|-----------|-------------|
| relayer | `volume_anomaly` | ≥ 120 `/submit` per 60 s | per-isolate sliding window, once per window |
| relayer | `error_burst` | 5 × 5xx per 5 min | per-isolate sliding window, once per window |
| keeper | `sweep_outage` | 3rd consecutive failed scan | streak, resets on one healthy scan |
| keeper | `scan_degraded` | 3rd consecutive **partial** scan | streak, resets on one full-coverage scan |
| keeper | `repeated_claim_failure` | 3rd consecutive failure per link | per-link streak, resets on success |
| parse | `upstream_degraded` | 5 upstream failures per 5 min | per-isolate sliding window, once per window |
| tidepool | `invoice_conflict` | on first detection — once per record | NEAR invoice settled while a Tidepool intent was in flight (Phase 4 poll or Phase 5 fresh read); conflict persisted **before** delivery, intent never auto-verified |
| tidepool | `payout_conflict` | on first detection — once per record | payout evidence proved `double_payout` / `payout_reversed`; conflict persisted, zero-read hold until reconciled |
| tidepool | `record_invalid` | on first distinct reason per record | corrupt persisted record stamped; intent held or quarantined to `RECONCILE` (503), persist-before-notify |

Threshold rationale: single failures are normal (chain hiccups, one bad
request); every implemented alert requires **repetition** — three strikes or
five-in-window — so the channel only hears about systemic trouble. The three
Tidepool events are the deliberate exception: they need **no repetition
gate** because each fires at most once per record (or per distinct reason)
and therefore cannot flood a channel — and they mark single money-safety
events that must never be missed.

**State caveat (documented, by design):** counters and streaks are
*per-isolate*. An isolate restart clears them, so a streak may need to rebuild
after a redeploy or eviction. This trades a rare missed alert for zero state
infrastructure (no KV/D1 dependency for the alerting path).

### 3b. Recommended queries — **requires Cloudflare dashboard setup, not
implemented in code** (a Worker cannot alert on an event that never happened)

| Signal | Query / check | Suggested threshold |
|--------|---------------|---------------------|
| **Missed keeper cron** | absence of `event:cron_heartbeat` for > 2 min | alert after 2 consecutive missing minutes |
| `cron_heartbeat` ok:false | `event:cron_heartbeat AND ok:false` | alert on any (usually already covered by `sweep_outage`) |
| Unsettled backlog | `event:unsettled_paid` — graph `count` | warn when `count` grows for > 10 min |
| Partial keeper scans | `event:scan_partial` — graph `failed_pages` | dashboard trend (in-code alert already covers 3 consecutive) |
| Relayer balance | `event:service_error AND reason:balance_low` | alert on first — account needs funding before payments resume |
| Relayer key problems | `reason:config_key_missing` OR `rpc_relayers_key` | alert on first |
| Abuse signal | `event:rate_limited` volume per IP | dashboard trend; the limiter already enforces |
| Parse abuse / Origin probing | `event:parse_rejected AND reason:origin_not_allowed` rate | dashboard trend |
| **Tidepool double-pay risk** | `event:invoice_conflict` | **alert on first** — a NEAR invoice was paid while a Tidepool payment was in flight; Phase 5 holds the intent (`reason:invoice_paid`) and never auto-verifies it — manual reconciliation |
| **Payout evidence conflict** | `event:payout_conflict` | **alert on first** — two payouts of the invoice amount (`double_payout`) or a transfer out of the merchant (`payout_reversed`) was proven from NEAR tx evidence; the intent is held for manual reconciliation, never verified |
| **Corrupt payment record** | `event:record_invalid` | **alert on first** — a persisted record cannot be read safely; the Worker holds or quarantines it (503 `record_invalid`, never a silent repair). Follow the §10 procedure: the log line carries `linkId` + `intentId` + a machine `reason`, the record itself lives in Durable Object storage |
| Stuck Phase 5 verification | `event:payout_verify_hold` — graph `count` by `reason` (excluding one-off `invoice_paid`/`no_payout_hash`) | warn when one intent's reason persists > 30 min (backoff caps at 1 h; a permanent `evidence_malformed` / `contract_inconclusive` needs a human) |
| Business volume | count of `event:submit_ok` per hour | dashboard only |
| Log budget | total events/day vs. 200k/day free cap | warn at 80 % |

Each is a saved query in Workers → Logs with an alert on top. The three
Tidepool money-safety rows now also **deliver in code** (§3a, §4 Tier 1);
their dashboard queries are a redundant Tier-2 backstop — still worth
having, because webhook delivery is single-shot and free log retention is
3 days. As of the
Cloudflare pricing page, **queries, dashboards and alerts are included at no
extra charge** (Workers Logs free tier: **200 000 events/day**, **3-day
retention**; verify current limits — retention/pricing changes were announced
for 1 Dec 2026).

---

## 4. Alert delivery — tiers and cost

**No paid external service is introduced by M-01.** Delivery options, cheapest
first:

| Tier | Mechanism | Status | Cost |
|------|-----------|--------|------|
| 0 | **Log-only** — read `level:"alert"` lines in Workers → Logs / `wrangler tail` | **Implemented, zero config** (default) | free |
| 1 | **Webhook** — `ALERT_WEBHOOK_URL` secret; each `alert` record POSTed as JSON, best-effort, URL never logged | **Implemented in code (all four Workers)**; needs a destination URL you choose | free (Slack/Discord/ntfy/PagerDuty webhooks, or any endpoint you host) |
| 2 | **Cloudflare Logs alerts** on saved queries (incl. the 3b absence check) | Requires account setup | free per pricing page ("queries, dashboards, alerts" included) |
| 3 | **Logpush** (long retention, external bucket) | Requires account setup; **Workers Trace Events Logpush requires Workers Paid** | 25 GB/mo internal destination included, then $0.03/GB; external destinations $0.10/GB (rates as researched 2026 — re-verify) |
| 4 | **Tail Worker / OpenTelemetry export** to your own pipeline | Not implemented (would add code + a destination) | destination-dependent |

Tier 1 is the recommended default: one secret per worker, any JSON-webhook
endpoint, no vendor lock-in, no cost.

**Destination requirements and delivery limits:**

* Use a **private** destination (DM, private channel, tokened ntfy topic) —
  the Tidepool alert payload includes `linkId` + `intentId`, which together
  are the `GET /status` **read capability** for that payment. The response
  is read-only and response-minimised (no address or amount; hashes only
  in the linkId-only settlement summary, and only post-`VERIFIED`), but it
  exposes the payment's conflict/hold state to anyone holding the ids.
  `linkId` alone — what any invoice viewer may hold — yields only the
  settlement summary (deposit date, intent id, on-chain status), never
  the full status body.
* Nothing else sensitive travels: the payload is the scrubbed log line
  itself (machine reason codes only), and the webhook URL — which may embed
  the destination's token — is a secret value that is never logged.
* Delivery is **single-shot** per event (each fires once per record or
  distinct reason). If the POST fails, nothing re-emits — the console line
  is the fallback, so pair Tier 1 with a Tier-2 saved query (§3b) if that
  matters to you.

---

## 5. Required configuration (credentials identified, **values not invented**)

Account/dashboard side — not performed by this milestone:

1. **Workers Logs enabled**: `observability.enabled = true` in each worker's
   wrangler config (default for Workers created recently; requires
   wrangler ≥ 3.78.6). Without it, the log lines still exist in
   `wrangler tail` but dashboard queries/alerts have nothing to read.
2. **Alert destination**: choose a webhook (e.g. a private Discord/Slack
   channel webhook or an ntfy topic URL), then per worker:
   `npx wrangler secret put ALERT_WEBHOOK_URL` — run once in **each**
   worker directory (`workers/relayer`, `workers/keeper`,
   `workers/parse`, `workers/tidepool`) and paste the URL at the prompt;
   the secret is per-worker. Choose a **private** destination (§4: the
   Tidepool payload carries the `GET /status` read capability, `linkId` +
   `intentId`). The secret is optional; without it all alerts still log
   (log-only mode).
3. **Dashboard alerts** for the 3b table: create saved queries + alert
   thresholds in Workers → Logs. Credentials required: your Cloudflare
   account (already implied by deploying these workers); no new service.
4. **Optional Logpush / retention**: only if 3-day free retention is
   insufficient; requires Workers Paid for Trace Events Logpush — a paid
   upgrade, documented here as a cost, not enabled.

None of the above has been configured yet: no destination chosen, no
`ALERT_WEBHOOK_URL` secret put, no saved query or alert created, no
retention change (verified 13 Nov 2026 — `wrangler secret list` on
`paylink-tidepool` returns none; the Workers themselves are live, §8.1).
The gap is purely account-side.

---

## 6. Security posture (what is never logged)

* **Never**: private keys / `RELAYER_KEY` / `KEEPER_KEY`, `GEMINI_API_KEY`
  (redacted by value in parse), API keys, auth tokens, `TICK_SECRET`,
  full signed delegates, request bodies, parsed payment values, system prompt.
* **Logged identifiers** are public-by-chain or operational: `link_id`, tx
  `hash`, `sender_id`/`account_id`, client IP (already visible to the edge),
  `rid`/`run_id` (random, contain no user data).
* **Backstop** (`scrub`/`scrubDeep` in all four files): shape redaction + 240-char cap
  applied to *every* string that reaches a line or webhook — so a future
  careless call site still cannot leak a key-sized secret.
* **No public log exposure**: health endpoints return fixed allowlists of
  aggregate counters only; parse `GET /` stays `405 Allow: POST`; no endpoint
  returns log contents.

---

## 7. Tests (all run locally, none skipped)

| Suite | Result | M-01 coverage |
|-------|--------|---------------|
| `node workers/relayer/test/parse.test.mjs` | **173 passed, 0 failed** | envelope + svc/build/level, `X-Request-Id` echo ↔ log `rid` match, `submit_rejected` reason codes, `submit_ok` happy path through an in-process RPC mock (no delegate/key bytes in any line), `rate_limited` layer+retry_after, `volume_anomaly` (fires at threshold, once per window), `error_burst` ×5 with webhook payload assertions, webhook on/off/dead-URL-never-logged plumbing, scrub probe, `GET /` allowlist + stats shape; **L-08**: reads fail over primary → `RPC_URLS` in order (the flow reaches the broadcast only because the fallback answered), the broadcast goes only to the primary exactly once — with a dead primary *and* with a healthy fallback configured — no pointless failover while the primary is healthy, and without `RPC_URLS` a query still retries the same endpoint while the fallback is never contacted |
| `node workers/keeper/test/sweep.test.mjs` | **178 passed, 0 failed** | `GET /` allowlist + build, `/tick` run_id correlation, tick 500 → `sweep_failed`+`tick_failed`, `cron_heartbeat` ok true/false (exactly one per run), `unsettled_paid` warn, `repeated_claim_failure` 3-strike + webhook + streak reset, `sweep_outage` 3-strike + scrubbed error + recovery reset, sweep_summary shape, scrub probe; **M-06**: live key/value layout fixture, 61-bucket fallback walk (boundaries 4/7/64), transient page retry, unreadable region fail-soft + `scan_partial`/`scan_degraded` streaks + recovery, duplicate key across pages claims once, query ceiling and zero-budget guards, one access-key read per sweep with sequential nonces, nonce re-read after unknown broadcast outcome and `InvalidNonce`; **L-02**: u128 both-limb decode (zero → u128::MAX, the 2^64 boundary, optional paid_amount path), lo-then-hi byte order incl. the live view_state record, settlement unchanged for a >2^64 amount (still 1 yocto), `formatYoctoNEAR` (0/1 yocto/1 NEAR/1.5/10^30/2^64/u128::MAX + malformed strings/Numbers/out-of-range rejected), truncated and garbage records skipped without failing the sweep; **L-03**: status byte 3 decodes `CANCELLED` (never `EXPIRED`), a cancelled record carries no payment fields, and a cancelled link is scanned but never a claim candidate; **L-05**: `/tick` fails closed — wrong secret, missing header and unset `TICK_SECRET` each answer 403 with zero broadcasts; the comparison itself is constant-time (SHA-256 digests, XOR accumulator, no plain-string fallback); **L-08**: reads fail over primary → `RPC_URLS` in order (primary first, the nonce read completes on the fallback), the broadcast is attempted exactly once on the primary and never fails over (dead-primary and healthy-fallback cases), the fallback never receives a broadcast, and without `RPC_URLS` a query still retries the same endpoint |
| `node workers/parse/test/parse.test.mjs` | **136 passed, 0 failed** | `parse_ok` envelope/no-values/rid, 405 untouched (no rid header), `parse_rejected` reason codes, `rate_limited` (11th request), `upstream_error` kinds + key redacted by value + 240 cap, `upstream_degraded` 5-in-window + webhook delivery, `service_error` generic 500 with no stack, leak sweep over 86 captured bodies; **L-06**: slow-in-budget response still parses (timer cleared — no late abort), stalled success body → 504 `kind=timeout`, stalled **error** body → 504 `kind=timeout` (was 502 `http_status`), upstream 429/400 → 502 status-only with no key/detail leak, network failure → 502 `kind=unreachable`, invalid JSON → 502 `kind=unreadable` (never a timeout) |
| `node --test 'workers/tidepool/test/*.test.mjs'` | **984 passed, 0 failed** (5 files) | M-01 alerting: the three money-safety events (`invoice_conflict`, `payout_conflict`, `record_invalid`) at `level:"alert"` from all five call sites with `env` threaded, webhook plumbing — missing secret → zero fetches (and the old two-argument `logEvent` shape stays safe), success → exactly one JSON POST whose payload is byte-identical to the logged line with the URL never logged, warn/info never POSTed, failure → swallowed `false` with the console line intact — **persist-before-notify** proven by observing the Durable Object store *at delivery time* (quarantine already on disk), and a dead webhook leaving response, persisted state, re-log and upstream-read behaviour identical to the no-webhook run; the eight severity assertions updated `error` → `alert` |

---

## 8. Remaining operational gaps

1. **Nothing is pushed and the frontend is not redeployed.** The M-01
   code sat uncommitted at report time and has since been committed (see
   `git log`), but `origin/staging` and `origin/master` are both behind
   local. The four Workers are live — relayer `20261110d`, keeper
   `20261110f`, parse `405`-signal, Tidepool `98f6e7ab` (deployed
   2026-11-13) — but the **frontend** still serves its previous build
   (`app.js?v=20261110a`, `styles.css?v=20261109a`): the checkout-card
   redesign, the receipt, and the `tidepoolWorker` endpoint config are
   committed on `staging` only and reach users only after the Vercel
   redeploy.
2. **Account setup outstanding** (§5): `observability.enabled`,
   `ALERT_WEBHOOK_URL` values, saved queries/alerts — identified, not done.
3. **Missed-cron detection is query-based** (absence of `cron_heartbeat`);
   no in-code fix is possible for a run that never executes. Tier-2 alert
   recommended for exactly this case.
4. **Per-isolate alert state** resets on isolate restart (§3a caveat);
   streaks rebuild, they are not persisted.
5. **Free retention is 3 days** — anything older needs Logpush (paid for
   trace events) or an external forwarder.
6. **`stats` counters are per-isolate** — dashboard sums across them or uses
   `submit_ok` counts for true totals.
7. **Frontend and contract are out of M-01 scope** (browser console has no
   structured pipeline; contract emits events on chain, readable via RPC).
8. **Other audit findings untouched by design**: when M-01 was written,
   M-03 – M-06 and L-01 – L-08 all remained open; M-01 changed no
   contract economics, payment flow, or H-01. (Status has since moved —
   H-01, M-01 – M-07 and L-01 – L-08 are all fixed on `staging` as of
   11 Nov 2026; the only two items still deferred are P4 external
   monitoring — §8.2 above — and broadcast failover — §9 below.)

---

## 9. Service quotas & assumptions (L-08 P3 — verified 10 Nov 2026)

Every external service the project runs on, its published free-tier limit,
and our headroom. Each number is quoted from the source linked beneath the
table — none assumed — and re-verified on the date above. Free tiers change
without notice: re-check before relying on any of these for mainnet.

| Service | Free-tier limit (verified) | Our usage / headroom | If it runs out |
| --- | --- | --- | --- |
| **NEAR RPC** `test.rpc.fastnear.com` — frontend, keeper, relayer | **No published numeric quota.** Key-free public endpoint; NEAR's provider table lists "Not published" for FastNEAR's free tier. Paid plans from $69/mo (10M req/mo). Archival listed paid-only | Keeper: ~1 whole-state read (+1 retry) per minute ≈ 1.5–3k req/day plus per-claim broadcasts; frontend/relayer only on demand. No ceiling exists to budget against | 429/network error → frontend: one automatic read retry, then *Could not read the chain* + Try again; workers: query retried once, `sweep_outage` alert after 3 consecutive minutes, automatic recovery |
| **Cloudflare Workers** (keeper, relayer, parse) + **Cron** | **100,000 requests/day** across all Workers (reset midnight UTC; over-limit → Error 1027, per-route fail-open/fail-closed). **10 ms CPU/invocation** (network waits don't count). **5 cron triggers/account**, finest interval **1 minute** (we use 1 trigger at exactly that), cron CPU 10 ms, wall 15 min. Subrequests 50/invocation | Keeper ≈ 1,440 scheduled runs/day + ≤10 claims/sweep + health pings; relayer/parse on demand ⇒ realistically **<10 % of the daily cap**. The binding risk is a runaway code loop, not traffic | Over cap: cron stops until UTC midnight (settlement stalls; manual Release + funds-in-contract keep money safe). CPU over: invocation aborted → next minute's sweep retries |
| **Workers Logs** | **200,000 events/day, 3-day retention** (free). **Pricing changes 1 Dec 2026** to Cloudflare Observability pricing — re-verify after that date | Keeper ≈ 2 lines/run (`sweep_summary` + `cron_heartbeat`) + per-claim events + warns ⇒ ~5–10k/day, ≪ 200k | Over cap: lines stop being stored (alerts already sent are unaffected); detection degrades to dashboard-only |
| **Gemini** `gemini-3.5-flash-lite` (parse Worker) | **15 RPM / 250K TPM / 500 RPD per project per model** (observed values; Google publishes no per-model table — the project's live numbers are in AI Studio; the `…FreeTier` daily quota = 500 confirmed in Google's forum for this model, 2026-11-02). RPD resets **midnight Pacific** (reset can lag a few minutes). Free tier also serves 503 "high demand" spikes | Parse's own limiter is **10 req/min per IP** (enforced before Gemini is called) — a per-minute, *not* per-day, bound, so one aggressive client could in theory exhaust the project-wide 500 RPD for everyone. Demo usage is tens/day | 429/503 → Worker answers 429/502 with a JSON error, key never leaked; paste block shows the error. **Payment flow unaffected** (parsing is optional) |
| **Vercel** (frontend static host) | Hobby: **100 GB** Fast Data Transfer/mo, **1M** CDN requests/mo, **100 deployments/day**. Exceeding usage → **503 `DEPLOYMENT_PAUSED`, typically up to 30 days wait** | A static page (no functions, few hundred KB) — demo traffic is a tiny fraction of 100 GB | Site down; **on-chain state and keeper unaffected**. Recovery: redeploy (drag-drop, no build step) or host the same folder elsewhere |
| **Tidepool sandbox** (faucet + 1Click swap) | Keyless, free community testnet sandbox; no published quota (per repo docs) | Only used to *acquire* test USDC; in-flight swaps have a timeout + refund path | Faucet/swap unavailable → message points at the other path; **payers who already hold USDC are unaffected** |
| **open.er-api.com** (NGN display line) | Keyless public reference; no documented quota | Display-only, one fetch per quote | Line silently hidden by design; flow never notices |
| **`ALERT_WEBHOOK_URL`** (optional) | Whatever the target webhook allows | One POST per `level=alert` event, 3 s best-effort budget | Failure swallowed; alerts degrade to log-only (§4) |

**Assumptions of record:** all limits are per-plan/per-project and may change
without notice; nothing above requires a paid plan at demo scale, and no
credential beyond the ones already listed in §5 is needed for any row; the
frontend uses a **single** RPC endpoint (browser-side failover is limited by
CORS and was not part of the approved P1 — P2's one automatic read retry is
its mitigation), while the keeper and relayer now fail **reads** over through
the optional `RPC_URLS` list (L-08 P1) with broadcasts still pinned to
`RPC_URL`, exactly once — broadcast failover remains explicitly *not*
approved (deferred), while the direct-payment fallback (L-08 P5) *is*
approved and implemented behind its consent dialog and post-consent chain
re-check; Gemini's daily quota is
project-wide, so parse traffic from any client spends one shared budget.

**Sources (all read 10 Nov 2026):** NEAR RPC provider table
`docs.near.org/api/rpc/providers` · FastNEAR docs `docs.fastnear.com` ·
Cloudflare pricing & limits `developers.cloudflare.com/workers/platform/`
(updated 2–29 Oct 2026) · Gemini rate limits & pricing
`ai.google.dev/gemini-api/docs/` + Google AI forum quota confirmation
(2026-11-02) · Vercel Hobby plan & limits docs `vercel.com/docs/plans/hobby`.

---

## 10. Tidepool record integrity & reconciliation — operator procedures (Phase 6)

Phase 6 hardened `workers/tidepool/` around one rule: **the persisted
Durable Object record is the only thing the Worker acts on, and a record
it cannot read is held — never guessed, never silently repaired.** This
section is the operator side of that rule. Everything marked *implemented*
below is in code and proven by `node workers/tidepool/test/records.test.mjs`
(210 assertions) alongside the existing networks/quote/status/payout suites;
items marked *recommended* need Cloudflare dashboard setup and say so.
There is deliberately **no admin endpoint**: hold reasons, integrity stamps
and history are never exposed on a public route — visibility is log lines
plus Durable Object storage only.

### 10.1 What the Worker does by itself (implemented)

| Situation | Response | State effect |
|-----------|----------|--------------|
| Intent status unreadable (`status_invalid`) | 503 `record_invalid` + `Retry-After` | force-quarantined to `RECONCILE`, `lastReason: record_malformed`, cooldown persisted **with** the state, `intent_transition` records the raw value → `RECONCILE` |
| Corrupt intent field (address, memo, deadline, amounts, merchant, correlation, …) | 503 `record_invalid` + `Retry-After` | intent **held in place** — no transition, no upstream call, no repair |
| Broken `intents` list or `activeIntentId` pointer (`POST /quote`) | 503 `record_invalid` | held — a second deposit address is never minted over an uncertain record (the old silent null-repair is gone) |
| Corrupt `history` / `conflict` (record level) | stamped + logged, request continues | non-blocking by design; a **malformed conflict still blocks verification** (the truthy-conflict hold fails closed) |
| Interrupted write (`persistence_failed`) | 500; record keeps the last complete state | retry after the poll floor — idempotent, no duplicate transitions, recovery never assumes the interrupted outcome |
| Upstream 429/5xx/404 on a status read | 503 `reconcile_cooldown` | `RECONCILE` + cooldown = **max(own, upstream `Retry-After`)**, clamped to 1 h — honoured on both the status and the reconcile path |
| Unrecognised Tidepool status | 503 `status_unknown` | `UNKNOWN` + cooldown; the raw value is stored, surfaced as `null`, never interpreted |
| Invoice turns PAID/CLAIMED mid-flight | `invoice_paid` conflict recorded **immediately** (persist-before-complete, before the cycle's final write) | surfaced as `conflict` on every response, **never cleared**, intent never auto-verified |
| Two payouts / a reversal proven from tx evidence | `double_payout` / `payout_reversed` conflict persisted | zero-read hold until an operator reconciles |
| Any unresolved ambiguous record | — | **never auto-`FAILED`**; `SUCCESS`/`SETTLED` never becomes `VERIFIED` without the full Phase 5 evidence chain |

`record_invalid` is logged **once per distinct `reason` per record** at
level `error` (reason codes only — never the corrupt value); repeats
answer identically with no second line and no re-write, and the
`record.invalid = {reason, at}` stamp persists for forensics even after
the record later resolves.

### 10.2 Retry / backoff matrix (implemented)

| Path | Backoff | What the client sees |
|------|---------|----------------------|
| `record_invalid` hold | fixed = ambiguous cooldown (default 60 s) | 503 + `Retry-After` header + `retryAfterSec`; does **not** self-heal — the next window re-answers identically until an operator acts |
| Quarantine (`RECONCILE`) | cooldown persisted with the state | 503 `record_invalid`; after it expires the next request reconciles against upstream truth (never a guess, never a forced success) |
| Status read failed / unmapped | `max(default 60 s, upstream Retry-After)` ≤ 1 h | 503 `reconcile_cooldown` / `status_unknown` + `retryAfterSec` |
| Poll floor | ≥ 2 s between status cycles (`TIDEPOOL_STATUS_MIN_INTERVAL_MS`, clamped 1–60 s) | repeat polls inside the floor are answered from the record with **zero** upstream reads |
| Verification hold | `TIDEPOOL_VERIFY_BACKOFF_MS` (default 5 s) doubling per attempt, cap 1 h | 200 from the record; attempts counted in `verifyAttempts`, hold reason logged once per distinct reason |
| Held-SETTLED contract watch | ≥ 60 s between contract reads (`HOLD_CONTRACT_REFRESH_MS`) | zero reads when fresh; when stale exactly one `get_link` — never a Tidepool re-read, never a tx read; a failed read does **not** advance `onChainCheckedAt`, so staleness stays honest |

### 10.3 Reconciliation scenario matrix (Phase 6 spec §5)

| # | Scenario | Deciding (authoritative) evidence | Transition / response | Retryable? | Manual investigation? |
|---|----------|-----------------------------------|----------------------|------------|------------------------|
| 1 | Well-formed record, invoice OPEN, Tidepool `PENDING_DEPOSIT` | NEAR contract + Tidepool status | stays `AWAITING_DEPOSIT` (or `EXPIRED` past our real deadline with no deposit) | client-driven polls | no |
| 2 | Status read fails (5xx / timeout / 404) | our last stored state | `RECONCILE` + persisted cooldown | yes — after `Retry-After` | no (a good read resolves it) |
| 3 | Unrecognised Tidepool status string | the raw value (stored, surfaced as `null`) | `UNKNOWN` + cooldown, 503 `status_unknown` | yes | no — but watch `status_unknown` volume |
| 4 | Invoice goes PAID/CLAIMED while an intent is in flight | NEAR contract `get_link` | `invoice_paid` conflict persisted immediately, intent held, never `VERIFIED` | polling continues (observation only) | **yes — conflict never auto-clears** |
| 5 | Two payout transfers of the invoice amount proven | NEAR tx receipts | `double_payout` conflict, zero-read hold | no | **yes** |
| 6 | Transfer out of the merchant / reversal proven | NEAR tx receipts | `payout_reversed` conflict, zero-read hold | no | **yes** |
| 7 | Payout tx not yet visible (`UNKNOWN_TRANSACTION`) | the node's answer | `evidence_pending` hold, state stays `SETTLED` | yes (verify backoff) | no |
| 8 | Inconclusive RPC / contract read during verification | the node's answer | `rpc_inconclusive` / `contract_inconclusive` hold | yes (verify backoff) | only if one reason persists > 30 min |
| 9 | `SUCCESS` with no settlement-hash candidates | Tidepool `SUCCESS` | held `SETTLED`, bounded contract-only watch | watch continues | only if a conflict appears |
| 10 | Persisted intent status unreadable | the record itself | quarantine → `RECONCILE` + cooldown, 503 `record_invalid` | after cooldown, reconciles upstream | **yes — inspect the record (§10.4)** |
| 11 | Persisted field / pointer / intents list corrupt | the record itself | held in place, 503 `record_invalid`, no self-heal | no (identical answer each time) | **yes — inspect the record (§10.4)** |
| 12 | Write interrupted mid-cycle | storage | last complete state kept, 500 `persistence_failed` | yes — idempotent retry, no duplicate transitions | no |

No row can reach `VERIFIED` through uncertainty: `VERIFIED` requires the
complete Phase 5 evidence (exactly one clean payout tx + a fresh contract
read authorizing it), and any recorded conflict blocks that path entirely.

### 10.4 Investigating a record (recommended procedure — manual, no endpoint)

1. **Find the log line** (Workers → Logs): `event:record_invalid` gives
   `linkId` + `intentId` + machine `reason`; conflicts appear as
   `event:invoice_conflict` / `event:payout_conflict`; quarantines as
   `event:intent_transition AND reason:record_malformed`. Saved-query
   alerts are listed in §3b — **recommended, not yet configured**.
2. **Read the record**: one JSON value per invoice in the INTENT_DO
   storage (key `record`, addressed by `linkId`). Field dictionary:

   | Field | Meaning |
   |-------|---------|
   | `linkId`, `merchant` | invoice identity (contract-sourced, never client-writable) |
   | `onChainStatus`, `onChainCheckedAt` | last authoritative NEAR invoice state + when it was read (deliberately **not** advanced on a failed read) |
   | `conflict` | `{kind: invoice_paid\|double_payout\|payout_reversed, onChainStatus, detectedAt}` — written by code, **never cleared by code** |
   | `invalid` | `{reason, at}` — Phase 6 integrity stamp, **never cleared by code** |
   | `activeIntentId` | which intent is live; must resolve into `intents` or the record holds |
   | `intents[]` | one object per attempt: `status`, `lastReason`, `reconcileUntil`, `lastStatusPollAt`, `payoutHashes` (server-captured, never served), `payoutHoldReason`, `verifyUntil`, `verifyAttempts`, `depositObserved`, `signature` (server-side proof, never served) |
   | `history[]` | audit trail `{ts, intentId, from, to, reason}` — capped at 256 entries, oldest dropped |

3. **Decide**: a conflict (row 4–6) needs a human reconciliation decision
   against the chain — nothing in this Worker can or will clear it. A
   corrupt record (row 10–11) needs the field fixed or the record
   re-derived from the contract/Tidepool truth by an operator; the code
   path itself will never rewrite it.

### 10.5 Deliberately not here

* No admin or status endpoint exposing hold reasons, stamps or history —
  the public response allowlist is unchanged from Phases 4–5.
* No automatic conflict clearing, no automatic refunds, no invented
  cancellation, no auto-`FAILED` for unresolved records.
* No claim that detecting a conflict eliminates anything at contract
  level — detection is observation and holding only.
* No new storage infrastructure: everything lives in the existing
  one-record-per-invoice Durable Object.
