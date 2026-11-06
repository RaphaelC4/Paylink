# Release keeper — Cloudflare Worker

Releases paid links. The contract's `claim` is callable by anyone — the money
can only go to the link's payee and the fee account, never to the caller — so
this Worker only ever pays gas. The frontend already releases a link right
after payment; this is the backstop for a rejected second approval, a closed
tab, or a dropped connection.

No registry, no state of its own: one `view_state` call with prefix `l` lists
every link the contract stores, each value borsh-decodes to the link, and
anything sitting in `PAID` gets claimed — up to 10 per sweep. Idempotent by
construction: `claim` panics unless the link is still `PAID`, so a link
released elsewhere in the meantime simply fails its own transaction and is
reported.

```
GET  https://<worker>/
       -> { "ok": true, "service": "paylink-keeper", ... }

POST https://<worker>/tick
     header: x-tick-secret: <TICK_SECRET>
       -> { "scanned": 9, "paid": [], "claimed": [], "failed": [] }
```

The cron (`* * * * *`) runs the same sweep and logs the report to
Workers → Logs.

How it all actually works — transaction format, RPC quirks, the nonce race,
key custody, the end-to-end proof log and the full debug trail — is written
down in [NOTES.md](./NOTES.md).

## Deploy without installing anything

1. Sign in at <https://dash.cloudflare.com> and open **Workers & Pages →
   Create → Worker**. Name it `paylink-keeper`, create it.
2. **Edit code**, delete the sample, paste `src/index.js` — the whole Worker
   is one file with no dependencies — and **Deploy**.
3. **Settings → Variables and Secrets**:
   - `KEEPER_KEY` — type **Secret**, the `private_key` value from
     `~/.near-credentials/testnet/paylink-keeper.testnet.json`. Never print
     it, never commit it. Quoted or pasted as the whole JSON line is fine —
     the Worker picks the 64-byte key out; a public key (32 bytes) is
     rejected with a message saying so.
   - `TICK_SECRET` — type **Secret**, any long random string you make up.
     It gates `POST /tick`.
   - All type **Text**: `RPC_URL` = `https://test.rpc.fastnear.com`,
     `CONTRACT_ID` = `paylink-v2.testnet`,
     `KEEPER_ACCOUNT` = `paylink-keeper.testnet`, `ALLOWED_ORIGIN` = `*`.
4. **Settings → Triggers → Cron**, add `* * * * *`, then deploy again.

## Check it

```bash
curl https://<worker>/
# {"ok": true, "service": "paylink-keeper", ...}

curl -X POST https://<worker>/tick -H "x-tick-secret: <your TICK_SECRET>"
# {"scanned": 9, "paid": [], "claimed": [], "failed": []}
```

A sweep with nothing to do returns `"paid": []` in a few seconds. To watch it
release something: pay a link, tick again, and `claimed` carries the link id
and the transaction hash.

## Deploy with wrangler (optional)

```bash
cd workers/keeper
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put KEEPER_KEY     # paste from the keychain file
npx wrangler secret put TICK_SECRET
```

For a local run, put `KEEPER_KEY=...` and `TICK_SECRET=...` in `.dev.vars`
(gitignored, never committed) and use `npx wrangler dev`.

## What it signs with

WebCrypto Ed25519 — the runtime's own `crypto.subtle`, pkcs8 import of the
32-byte seed, signature over `sha256(borsh(tx))` exactly as nearcore verifies
it. No signing library is bundled, which is why the deploy above is a single
paste. The key is the `paylink-keeper.testnet` access key; the account holds
testnet NEAR purely for gas (about 0.0008 NEAR per claim).
