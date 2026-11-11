# Paylink Workers — Operations (M-01)

Monitoring and alerting for the three Paylink Cloudflare Workers: **relayer**
(meta-transactions), **keeper** (claim sweep), **parse** (invoice reader).
This file is the M-01 report: what is implemented in code and tested, versus
what still requires Cloudflare account configuration. Nothing here has been
deployed, merged or pushed; every recommendation that needs account setup says
so explicitly and invents no credential values.

---

## 1. The log line (identical in all three Workers)

Every operational event is **one JSON line on stdout**:

```json
{"ts":"2026-11-10T03:27:55.810Z","svc":"paylink-parse","build":"20261110b","level":"error","event":"upstream_error","rid":"7910c9fa","kind":"http_status","status":500,"detail":"…"}
```

| Field   | Meaning |
|---------|---------|
| `ts`    | ISO-8601 UTC timestamp |
| `svc`   | `paylink-relayer` \| `paylink-keeper` \| `paylink-parse` |
| `build` | build stamp — relayer `20261110d`, keeper `20261110f`, parse `20261110b` (in log lines only) |
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
  webhook can never break a submission, sweep or parse.

Correlation ids:

| Worker  | Id | Propagation |
|---------|----|-------------|
| relayer | `rid` (8 hex) | `X-Request-Id` response header + every log line of that request |
| parse   | `rid` (8 hex) | `X-Request-Id` on `POST /` responses + that request's lines |
| keeper  | `run_id` (8 hex) | every line of one sweep + returned in the `/tick` response report |

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

Threshold rationale: single failures are normal (chain hiccups, one bad
request); every implemented alert requires **repetition** — three strikes or
five-in-window — so the channel only hears about systemic trouble.

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
| Business volume | count of `event:submit_ok` per hour | dashboard only |
| Log budget | total events/day vs. 200k/day free cap | warn at 80 % |

Each is a saved query in Workers → Logs with an alert on top. As of the
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
| 1 | **Webhook** — `ALERT_WEBHOOK_URL` secret; each `alert` record POSTed as JSON, best-effort, URL never logged | **Implemented in code**; needs a destination URL you choose | free (Slack/Discord/ntfy/PagerDuty webhooks, or any endpoint you host) |
| 2 | **Cloudflare Logs alerts** on saved queries (incl. the 3b absence check) | Requires account setup | free per pricing page ("queries, dashboards, alerts" included) |
| 3 | **Logpush** (long retention, external bucket) | Requires account setup; **Workers Trace Events Logpush requires Workers Paid** | 25 GB/mo internal destination included, then $0.03/GB; external destinations $0.10/GB (rates as researched 2026 — re-verify) |
| 4 | **Tail Worker / OpenTelemetry export** to your own pipeline | Not implemented (would add code + a destination) | destination-dependent |

Tier 1 is the recommended default: one secret per worker, any JSON-webhook
endpoint, no vendor lock-in, no cost.

---

## 5. Required configuration (credentials identified, **values not invented**)

Account/dashboard side — not performed by this milestone:

1. **Workers Logs enabled**: `observability.enabled = true` in each worker's
   wrangler config (default for Workers created recently; requires
   wrangler ≥ 3.78.6). Without it, the log lines still exist in
   `wrangler tail` but dashboard queries/alerts have nothing to read.
2. **Alert destination**: choose a webhook (e.g. a private Discord/Slack
   channel webhook or an ntfy topic URL), then per worker:
   `wrangler secret put ALERT_WEBHOOK_URL` — paste the URL at the prompt.
   The secret is optional; without it all alerts still log (log-only mode).
3. **Dashboard alerts** for the 3b table: create saved queries + alert
   thresholds in Workers → Logs. Credentials required: your Cloudflare
   account (already implied by deploying these workers); no new service.
4. **Optional Logpush / retention**: only if 3-day free retention is
   insufficient; requires Workers Paid for Trace Events Logpush — a paid
   upgrade, documented here as a cost, not enabled.

Nothing above was done for M-01 (no deploy, no push, no account changes).

---

## 6. Security posture (what is never logged)

* **Never**: private keys / `RELAYER_KEY` / `KEEPER_KEY`, `GEMINI_API_KEY`
  (redacted by value in parse), API keys, auth tokens, `TICK_SECRET`,
  full signed delegates, request bodies, parsed payment values, system prompt.
* **Logged identifiers** are public-by-chain or operational: `link_id`, tx
  `hash`, `sender_id`/`account_id`, client IP (already visible to the edge),
  `rid`/`run_id` (random, contain no user data).
* **Backstop** (`scrub` in all three files): shape redaction + 240-char cap
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

---

## 8. Remaining operational gaps

1. **Nothing is deployed.** At the time of the M-01 report its code sat
   uncommitted on local `staging`; it has since been committed (see
   `git log`), but nothing has been pushed and no worker or frontend has
   been redeployed — live services still run their previous builds.
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
