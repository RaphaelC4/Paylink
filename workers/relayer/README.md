# Relayer — Cloudflare Worker (NEP-366 meta-transactions)

Makes creating a link free for the payee. The wallet signs a `DelegateAction`
for `create_link` off-chain — a signature costs nothing — and POSTs it here.
The Worker validates it before spending a yocto (receiver, method, stake,
arguments, nonce, expiry, and the NEP-461 signature itself), then wraps the raw
delegate bytes in a transaction signed by `paylink-relay.testnet`, which pays
the gas **and** the 0.01 NEAR storage stake. On chain the inner call runs with
the payee as `predecessor`, so the link's creator is the payee exactly as with
a direct transaction — no contract change.

```
GET  https://<worker>/
       -> { "ok": true, "service": "paylink-relayer", ... }

POST https://<worker>/submit
     body: { "signedDelegateAction": "<base64 SignedDelegateAction>" }
       -> { "ok": true, "hash": "<transaction hash>" }
       -> { "error": "..." } with 400 (bad input / bad signature),
          413 (body over 64 KB, rejected before parsing),
          429 (10 per IP per hour + a durable 10-per-60s burst cap when the
          RATE_LIMITER binding is provisioned — carries Retry-After),
          503 (balance floor or RPC trouble), 502 (broadcast rejected)
```

Measured on testnet: the payee's balance does not move by one yocto per
creation; the relayer pays ~0.0105 NEAR (stake + gas) per link. The evidence
— fixtures, tx hashes and the exact signature preimage — is in
[NOTES.md](./NOTES.md); the parser/validator/builder has 45 assertions in
`test/parse.test.mjs` (`node test/parse.test.mjs`).

## Deploy without installing anything

1. Sign in at <https://dash.cloudflare.com> and open **Workers & Pages →
   Create → Worker**. Name it `paylink-relayer`, create it.
2. **Edit code**, delete the sample, paste `src/index.js` — the whole Worker
   is one file with no dependencies — and **Deploy**.
3. **Settings → Variables and Secrets**:
   - `RELAYER_KEY` — type **Secret**, the `private_key` value from
     `~/.near-credentials/testnet/paylink-relay.testnet.json`. Never print it,
     never commit it. The whole JSON line pasted as-is also works — the Worker
     extracts the 64-byte ed25519 key from it.
   - All type **Text**:
     - `RPC_URL` = `https://test.rpc.fastnear.com`
     - `CONTRACT_ID` = `paylink-v2.testnet`
     - `TOKEN_ID` = `usdc.tidepool-sandbox.testnet`
     - `RELAYER_ACCOUNT` = `paylink-relay.testnet`
     - `ALLOWED_ORIGIN` = `https://paylink-near.vercel.app` (the deployed
       frontend's origin; `*` also works — CORS only constrains browsers, and
       the per-IP rate limit is the real bound)
      - Optional: `RPC_URLS` — comma-separated read fallbacks (e.g.
        `https://near-testnet.drpc.org, https://testnet-rpc.intea.rs`).
        Reads try `RPC_URL` first, then each entry in order, stopping at
        the first that answers; the broadcast always goes to `RPC_URL`
        alone, exactly once — never retried, never failed over. Unset =
        the original behaviour.
4. **Fund check**: the account must hold more than 1 NEAR (the Worker refuses
   below that floor). It currently holds ~9.98 testnet NEAR from the faucet —
   roughly 950 creations.

## Point the frontend at it

Set `relayer.endpoint` in `frontend/config.js` to
`https://<worker>.<your-subdomain>.workers.dev/submit`, bump the `?v=` cache
bust in `frontend/index.html` and the `frontend/app.js` config import, and
deploy the frontend. Empty endpoint = the create form sends the direct wallet
transaction (payee pays) — the gate is intentional, so nothing breaks if the
Worker is ever down: the frontend falls back only when no endpoint is
configured, and surfaces relayer errors rather than silently going direct.

## Check it

```bash
curl https://<worker>/
# {"ok": true, "service": "paylink-relayer", "contract": "paylink-v2.testnet", ...}
```

A signed delegate comes from the app itself (Create a link with the relayer
configured), or from the CLI:

```bash
near transaction construct-meta-transaction paylink-payee.testnet paylink-v2.testnet \
  add-action function-call create_link base64-args <b64> prepaid-gas '50 Tgas' \
  attached-deposit '0.01 NEAR' skip network-config testnet sign-with-legacy-keychain display
# then POST the printed base64 to /submit
```

## Deploy with wrangler (optional)

```bash
cd workers/relayer
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put RELAYER_KEY    # paste from the keychain file
```

## Rate limiting (M-07) — composite, two layers

Every `POST /submit` must pass **both** layers, keyed on the same client IP:

1. **Local sliding window — 10 submissions per IP per hour.** Lives in the
   Worker's code, needs no service, and always runs: no binding outage or
   misconfiguration can switch it off (a failure logs and keeps enforcing).
   It is per isolate, so until layer 2 exists two isolates each allow the
   hour's quota.
2. **`RATE_LIMITER` binding — a durable 10-per-60-second burst cap** counted
   by Cloudflare across isolates (GA; docs call it eventually-consistent
   *within one location*, so a burst can slightly overshoot). This is the
   cross-isolate bound the local window cannot provide. It requires a
   **wrangler deploy** — a dashboard code paste cannot attach bindings, and
   rate-limit bindings are not visible in the dashboard.

Setup (when you want layer 2 — not required for the Worker to work):

```toml
# wrangler.toml next to src/index.js — wrangler >= 4.36
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "2002"   # must be unique per account policy:
                        # workers sharing a namespace share one counter.
                        # workers/parse uses 2001 — do NOT reuse it here.

  [ratelimits.simple]
  limit = 10
  period = 60           # Cloudflare allows only 10 or 60 seconds —
                        # a durable "10 per hour" is not expressible,
                        # which is why layer 1 owns the hourly policy.
```

Then `npx wrangler deploy` (it will prompt for the vars currently set in the
dashboard — mirror them exactly — and the `RELAYER_KEY` secret is re-set with
`npx wrangler secret put RELAYER_KEY`). Until then the paste deployment runs
layer 1 alone.

Client identity: the `cf-connecting-ip` header, which Cloudflare sets at the
edge (clients cannot forge it on `workers.dev`); `X-Forwarded-For` and
friends are ignored on purpose. A missing/blank header shares one `"unknown"`
bucket — every such request counts against the same 10/hour, so absence can
never mint a fresh bucket. 429 responses carry `Retry-After` in seconds
(time until the oldest hour-window hit expires; 60 for a binding refusal).

Verify after provisioning: POST `{}` to `/submit` 11 times in a row — the
first ten answer 400 (they pass the limiter and fail at body validation,
touching no RPC) and the 11th answers 429. `Retry-After` near 3600 means the
hourly local layer capped you; `60` means the durable binding refused a
cross-isolate burst (a single client hitting one isolate trips the local
layer first, so the 60-second signature normally appears only under load
spread across instances).

## Monitoring (M-01)

Every operational event is one structured JSON line
(`{ts, svc, build, level, event, ...}`, build `20261110d`) on stdout —
readable in Workers → Logs or `wrangler tail`. Each `/submit` response
carries an `X-Request-Id` echoed in that request's log lines, so a
"it failed" message maps onto exactly one trace.

- **Events**: `submit_ok`, `submit_rejected` (reason codes such as
  `bad_signature`, `expired_delegate`, `balance_low`), `rate_limited`,
  `service_error`, `limiter_backend_error`, plus two alerts:
  `volume_anomaly` (≥ 120 requests/60 s) and `error_burst` (5 × 5xx in
  5 min), each once per window.
- **Never logged**: the delegate bytes, request bodies, or the relayer key
  (the logger additionally scrubs `ed25519:`/API-key/bearer shapes and caps
  strings at 240 chars). `GET /` returns a fixed key allowlist —
  aggregate counters only.
- **Alert delivery**: log-only by default; set the optional
  `ALERT_WEBHOOK_URL` secret to have each `level:"alert"` record POSTed to
  any JSON webhook (free, best-effort, URL never logged).
- Full event catalog, thresholds, required Cloudflare configuration and
  open gaps: [`workers/OPERATIONS.md`](../OPERATIONS.md).

## What it signs with

WebCrypto Ed25519 — the runtime's own `crypto.subtle`, same as the keeper.
The outer transaction has no gas field: prepaid gas is derived from the
actions, and `Action::Delegate` (tag 8) carries the payee's signed bytes
verbatim. The key is the `paylink-relay.testnet` access key; the account holds
testnet NEAR purely to fund other people's creations.
