# Release keeper — Cloudflare Worker

Releases paid links. The contract's `claim` is callable by anyone — the money
can only go to the link's payee and the fee account, never to the caller — so
this Worker only ever pays gas. It is the **default settlement path**: after
the payer's one wallet approval the frontend only watches the link move
`PAID → CLAIMED`; this Worker makes that happen within a minute. The pay
card's Release button stays as manual recovery for the rare failed sweep, a
closed tab on a slow chain, or a keeper outage.

No registry, no state of its own: one `view_state` call with prefix `l` lists
every link the contract stores, each value borsh-decodes to the link, and
anything sitting in `PAID` gets claimed — up to 10 per sweep. Idempotent by
construction: `claim` panics unless the link is still `PAID`, so a link
released elsewhere in the meantime simply fails its own transaction and is
reported.

If that whole-state read fails after its retry (a timeout, or a response the
node won't serve), discovery falls back to querying disjoint sub-prefixes —
the 61 `link_id` length buckets first, then next-byte children — so one
oversized or flaky page can never lose the rest of the state. Pages already
read are kept and claimed anyway (fail-soft, `scan_partial` in the log);
unvisited prefixes are re-covered from scratch by the next minute's sweep,
which is what keeps a failed run from missing a settlement. Guards
`KEEPER_MAX_PAGE_QUERIES` (default 512) and `KEEPER_SCAN_BUDGET_MS`
(default 45 s) bound the fallback.

```
GET  https://<worker>/
       -> { "ok": true, "service": "paylink-keeper", ... }

POST https://<worker>/tick
     header: x-tick-secret: <TICK_SECRET>
       -> { "scanned": 9, "paid": [], "claimed": [], "failed": [] }
```

The cron (`* * * * *`) runs the same sweep and logs to Workers → Logs: one
structured JSON line per event — `invoice_discovered`, `claim_submitted`,
`claim_successful`, `claim_failed`, `invoice_already_claimed`,
`retry_scheduled` — plus the per-run report. No key material is ever logged.
The whole behaviour (discovery, the exact claim tx, retry, already-claimed,
outage and log events) is covered by `test/sweep.test.mjs` — run it with
`node workers/keeper/test/sweep.test.mjs`; the RPC is mocked, so no network
or key is needed.

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

## Monitoring (M-01)

Every event is one structured JSON line (`{ts, svc, build, level, event,
...}`, build `20261110d`) on stdout — Workers → Logs or `wrangler tail`.
All lines of one sweep share a `run_id` (also returned by `/tick`), so
"did the 14:03 run settle it?" is one query.

- **Events**: one `cron_heartbeat` per scheduled run (**missed runs show as
  its absence**; failures as `ok:false`), a `sweep_summary` per healthy run,
  `unsettled_paid` warn with the backlog count, per-claim outcomes
  (`invoice_discovered`, `claim_submitted`, `claim_successful`,
  `invoice_already_claimed`, `claim_failed`, `retry_scheduled`), and
  `sweep_failed` / `tick_failed` errors.
- **Alerts**: `sweep_outage` (3rd consecutive failed scan),
  `repeated_claim_failure` (3rd consecutive failure for one link) — both
  fire exactly once per streak; a healthy run resets the streak.
- **Never logged**: the keeper key (scrub backstop: `ed25519:` shapes +
  240-char cap); everything else — link ids, tx hashes — is public on chain.
  `GET /` is a fixed allowlist with the build stamp.
- **Alert delivery**: log-only by default; the optional
  `ALERT_WEBHOOK_URL` secret POSTs each `level:"alert"` record to any JSON
  webhook (free, best-effort; the sweep awaits delivery before it returns).
- Catalog, thresholds, required Cloudflare configuration and gaps:
  [`workers/OPERATIONS.md`](../OPERATIONS.md).

## What it signs with

WebCrypto Ed25519 — the runtime's own `crypto.subtle`, pkcs8 import of the
32-byte seed, signature over `sha256(borsh(tx))` exactly as nearcore verifies
it. No signing library is bundled, which is why the deploy above is a single
paste. The key is the `paylink-keeper.testnet` access key; the account holds
testnet NEAR purely for gas (about 0.0008 NEAR per claim).
