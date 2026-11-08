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
          429 (10 per IP per hour), 503 (balance floor or RPC trouble),
          502 (broadcast rejected)
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

## What it signs with

WebCrypto Ed25519 — the runtime's own `crypto.subtle`, same as the keeper.
The outer transaction has no gas field: prepaid gas is derived from the
actions, and `Action::Delegate` (tag 8) carries the payee's signed bytes
verbatim. The key is the `paylink-relay.testnet` access key; the account holds
testnet NEAR purely to fund other people's creations.
