# Demo recording script

Target: **2 min 30 s**, one take, no cuts except between browser profiles.
Everything below is already deployed on testnet — nothing to build.

---

## Before you hit record (10 min, do once)

The two accounts used by the demo must exist **in the wallets you will use on
camera**, because only the wallet can sign. Create them in Meteor Wallet, then
fund them from the CLI.

1. Install Meteor Wallet (or use any wallet the app offers).
2. Create **two** accounts, one per browser profile:
   - profile A → payee, e.g. `alice-demo.testnet`
   - profile B → payer, e.g. `bob-demo.testnet`
   - Meteor gives new testnet accounts 10 NEAR automatically.
3. Fund the payer with test USDC. Two ways — the app faucet is the one to
   show on camera, the API call is for setting up ahead of time:

   ```bash
   # 100 test USDC + 100 USDT + 40 wNEAR + dust, free, no sign-up
   curl -X POST https://www.usetidepool.tech/v0/faucet \
     -H "Content-Type: application/json" \
     -d '{"accountId":"bob-demo.testnet","mode":"wallet"}'
   ```

   The same drip is one click inside the app: on any open pay link, expand
   **No test USDC?** and press **Get test tokens**. That is the beat to record
   if you want the faucet on camera — use a payer account that has not been
   dripped yet so the balance starts at zero.
4. Confirm the payer balance (skip if you dripped on camera):

   ```bash
   near contract call-function as-read-only usdc.tidepool-sandbox.testnet \
     ft_balance_of json-args '{"account_id":"bob-demo.testnet"}' \
     network-config testnet now
   # -> "100000000"   (100 USDC, 6 decimals)
   ```

5. Open `https://paylink-near.vercel.app/` in profile A. Connect the payee wallet.
6. Keep profile B open at the same URL, wallet not yet connected.
7. Confirm the relayer and keeper each hold **more than 1 NEAR** — below that
   the relayer refuses new links with a 503:

   ```bash
   for a in paylink-relay.testnet paylink-keeper.testnet; do
     curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
       -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$a\"}}" \
       | grep -o '"amount":"[0-9]*"'
   done
   # each "amount" must be > 1000000000000000000000000 (1 NEAR)
   # last check 8 Nov 2026: relay 9.936919, keeper 9.973031 NEAR
   # (the old rpc.testnet.near.org is deprecated — see README — and may 429)
   ```

8. Set the browser zoom to 100% and the window to roughly 1280×800. The layout
   is responsive, but the pay card reads best at that size.

**Check before recording:** the header chip reads `testnet`, the footer reads
`NEAR testnet · test tokens only · not audited · do not send real funds`, the
token pill on the create form reads `USDC · usdc.tidepool-sandbox.testnet`,
and the pay page's Technical details show `paylink-v2.testnet`. If you
plan to say the keeper line in 1:35–2:00, also confirm the keeper Worker is
up: `curl https://<keeper-url>/` returns `"ok": true`.

---

## Shot list

### 0:00–0:15 — The problem, over the landing page

> "Getting paid across borders costs 3 to 5 days and up to 45 dollars. And if
> you ask a client to 'just send crypto', you're asking them to learn your
> chain. Paylink removes that: you send a link, they pay with what they already
> hold, you get paid on NEAR."

Scroll slowly past the hero and the three steps. Do not rush.

### 0:15–0:45 — Create a link (profile A, payee)

1. Click **Create a link** (or the **Create** tab).
2. Amount: `25`
3. Note: `Brand identity — logo + type`
4. Expiry: leave at **in 3 days**.
5. Click **Create link**, approve the sign prompt in the wallet (the relayer
   pays the stake and gas — the payee's balance does not move).

> "One transaction writes the link. The contract takes a 0.01 NEAR storage
> stake — no company, no server, no account on our side."

> *([drift] In the recorded video this line predates the relayer: the payee's
> wallet paid the stake directly. Since the relayer landed the stake comes from
> `paylink-relay.testnet` — the contract still takes 0.01 NEAR, just not from
> the payee. The on-screen flow is unchanged; no re-record needed.)*

> "People sign with their wallet — Meteor and others. The connector also
> lists a NEAR CLI option, which lets a terminal or an agent sign the same
> transactions."

> *(On camera at 0:32 is that NEAR CLI option: the connector prints the
> exact near-cli command, a terminal or an agent runs it, and the hash comes
> back to the app — same chain, same link. It's reachable on the live site
> today: disconnect, open the wallet list, and pick **NEAR CLI**
> (`near.cli.rs`) — enter an account, choose **Keychain**.)*

**On screen:** the button reads *Creating link…* while the wallet prompt is
open, then the app lands on the share page: the link in a copy field, a QR
code, WhatsApp / Telegram / Email buttons, and the status pill **UNPAID**.

Point at the QR code.

> "The whole product is this screen. Copy it, scan it, or send it — the payer
> needs no account on our side."

Optional, if the parser is configured: paste
`Chidi owes me 25 USDC for the brand identity work, due in 3 days` into
**Paste a payment request**, press **Fill the form**, and show the amount and
description appear. Say: "The model only proposes fields; the browser checks
every one of them, including the token, against the chain." Skip this beat if
`parseEndpoint` is empty — it is 10 seconds, not worth a deploy on camera.

### 0:45–1:05 — The link is the product

On the share page, click **Copy** — the button flips to *Link copied!* — then
open the link in profile B. Alternatively, hold the QR up to a phone camera
for two seconds.

> "This is what the client receives. No signup, no seed phrase explanation —
> just a payment request with a Pay button."

**On screen:** the pay page in profile B: the dollar amount, the token amount,
the description, and the Open → Paid → Claimed timeline.

Point at the fee line: "payee receives 24.875 USDC after the 0.5% fee".

### 1:05–1:35 — Pay it (profile B, payer)

1. Connect the payer: click **Connect a wallet to pay** on the pay page (the
   header reads **No wallet** while disconnected), pick the payer wallet.
2. If the payer is starting empty: expand **No test USDC? — free faucet &
   swap**, click **Get test tokens**, and watch the balance row fill.

   > "A payer who arrives holding nothing doesn't need me to mint anything —
   > one faucet call drops test tokens into their wallet, free."

   (On a phone the same button sits behind the **Faucet** chip beside the
   bottom bar, or as a card in **Account**.)
3. Click **Pay 25 USDC**, approve. One approval is the whole payment.

> "The wallet sends one `ft_transfer_call` with the link id in `msg`. The token
> contract calls Paylink, and that call — not any user call — is what marks the
> link paid. There is no function anyone can call to fake it."

**On screen:** the timeline moves to **Paid**, the payer balance drops by
exactly 25, and the status line reads *Payment confirmed! Your funds are being
released automatically.* Nobody is asked to sign anything again.

### 1:35–2:00 — Release, without anyone signing

Wait for the status line to read *Payment completed successfully. The
recipient has received the funds.* and the timeline to move to **Claimed** —
the keeper sweeps every minute.

> "Nobody signs the release. The payer's one approval was the payment; a
> keeper Worker scans the contract for paid links and calls `claim` from its
> own gas account. Anyone can call it — the money can only go to the link's
> payee and the fee account, never to whoever clicks. So the payee never has
> to come back, sign, or hold gas. 99.5% goes to them, 0.5% is the fee."

(Confirm the keeper beforehand: `curl https://<keeper-url>/` must return
`"ok": true`. If it is ever down, the app shows *Your payment is confirmed.
Automatic settlement is in progress.* and the **Release** button on the paid
card is the manual fallback — anyone can press it.)

**On screen:** the timeline moves to **Claimed**. Switch to profile A: the payee
balance has increased by 24.875 USDC.

### 2:00–2:20 — My links and the Tidepool rail

1. Profile A → **My links** → the creator field is prefilled with the connected
   wallet → **Load**.
2. Point at the stats row: total received, awaiting payment, link count.
3. Click through the filters: **All / Unpaid / Paid / Expired** — the counts
   update, and an empty filter offers *Show all*.
4. Click **Export CSV**.

> "Every link is readable straight from the chain, unsigned, and exports to
> a CSV an accountant can open."

Optional, 15 s: open any open link, expand **No test USDC? — free faucet &
swap**, and point at the swap row — pick **wNEAR**, press
**Swap wNEAR and pay**, and show the quote.

> "If the payer holds something else instead, Tidepool quotes a swap into
> exactly enough USDC for this link — free, testnet-only, and the app says
> so instead of pretending."

### 2:20–2:30 — Close

> "Contract, 56 tests, and deployment steps are in the repo. Testnet only —
> the tokens come free from Tidepool's faucet."

---

## Numbers to quote correctly

| Thing | Value |
| --- | --- |
| Fee | 0.5% (50 bps), constant in the contract |
| 25 USDC link | payee receives **24.875**, fee **0.125** |
| Create cost | 0.01 NEAR storage stake + ~0.0005 gas — paid by the relayer (`paylink-relay.testnet`); the payee's wallet signs off-chain only |
| Claim deposit | 1 yoctoNEAR |
| Release keeper | `paylink-keeper.testnet`, sweeps every minute, ~0.0008 NEAR gas per claim |
| Contract | `paylink-v2.testnet` |
| Token | `usdc.tidepool-sandbox.testnet` (6 decimals) |
| Faucet | 100 USDC + 100 USDT + 40 wNEAR per call, Tidepool |
| Chain | `testnet` |

## If something goes wrong on camera

- **Wallet won't connect** — reload the page; the modal lists Meteor, Intear,
  Ledger, Nightly, EVM wallets and NEAR CLI (`near.cli.rs`, terminal signing).
- **`link id already used`** — the id is random per click; press Create again.
- **Pay button says the balance is short** — expand **No test USDC?** on the
  pay card and click **Get test tokens**.
- **Release fails** — the link is already `CLAIMED`, quite possibly because
  the keeper released it first, which is the intended result. Open a fresh
  link. (A failed release reverts to `PAID`, so it can always be retried.)
- **The pay page sits on "Reading the chain…"** — the app reads the chain
  unsigned, so it waits on the RPC (`test.rpc.fastnear.com`, ~0.9 s normally).
  It times out after 12 seconds and shows a **Try again** button; the QR code
  and share buttons stay on screen the whole time, because neither needs the
  chain. Wait, or reload.
