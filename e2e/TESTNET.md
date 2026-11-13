# Paylink testnet E2E — the manual runbook

This is the half of the E2E plan that **must stay human**. Wallet approvals
are the security boundary of the whole product: automating them would mean
bypassing wallet security, which this repository never does. Nothing here is
faked — a step that has not happened has not happened, and the page says so.

CI's part is small and read-only: the `E2E testnet (manual)` workflow
(`.github/workflows/e2e-testnet.yml`) runs `--project=testnet` — the
committed frontend served locally, reading live NEAR testnet over public
JSON-RPC **view** calls. It never connects a wallet, never signs, never
POSTs a transaction, and has no secret to leak. Everything below is you.

## Before you start (one-time)

1. **Dedicated testnet wallet(s).** Create accounts used only for this —
   e.g. `e2e-payee.testnet` and `e2e-payer.testnet`. Never an account that
   has held (or will hold) real funds. Testnet keys are worthless, which is
   the point: treat them as disposable but still never paste a seed phrase
   or private key into a terminal, issue, log, screenshot or CI artifact.
2. **Fund them.** Use the app's faucet rail (or the Tidepool faucet) for
   test USDC + a little testnet NEAR for gas. Amounts here are test tokens
   only — the footer says so on every screen.
3. **Serve the committed frontend** (the site you deploy may be behind
   this code — test what is in the repo):

   ```powershell
   cd e2e
   node serve.mjs        # http://127.0.0.1:4173
   ```

4. **Optional read-only CI check:** dispatch `E2E testnet (manual)` with
   `acknowledge = testnet-only` and, if you have a link, `link_id = <id>`.
   It only renders/reads; it cannot sign anything.

## Journey A — NEAR payment, keeper settlement, receipt

Performed entirely by hand in two browser windows (two wallets).

1. **Create (payee).** Open `http://127.0.0.1:4173/#create` connected as
   the payee wallet → fill amount/note → **Create link** → **approve the
   one wallet prompt** (delegate action, free; the relayer pays gas). The
   link lands on `#ready/<id>` with QR + share buttons.
2. **Pay (payer).** Open the link in the second wallet's browser → the pay
   card shows **OPEN**, amount, expiry, `Connect a wallet to pay` →
   connect the payer wallet → **Pay** → **approve the ONE payment
   signature**. From here the payer signs nothing again — ever.
3. **Watch PAID.** The card flips to **PAID** when the token callback marks
   it (a few seconds). Copy: *"released automatically by the keeper"* —
   the **Release** button on the card is a manual fallback, not a second
   step.
4. **Watch CLAIMED (PAID → CLAIMED).** The keeper Worker sweeps every
   minute from its own gas account; settlement normally completes within
   ~1–2 minutes with **no human action**. Success = the timeline shows
   **Claimed** and *"Settled in full."*
5. **Receipt.** Because this session watched the money land, the pay card
   renders the receipt: **"Payment delivered and verified on NEAR"**,
   amount, time, the wallet-returned transaction hashes (explorer links),
   the invoice id — plus **Download PDF receipt**. Open the PDF and check
   the sentence, the invoice id and the hashes are in it.

If the keeper is ever down: the Release button settles it manually (anyone
can press it; the money can only go to the payee). That is recovery, not a
test step — do not race it against the keeper.

## Journey B — Tidepool (cross-chain) → VERIFIED

Run on a fresh invoice (or the same OPEN one). One invoice, one live
payment path at a time — never two.

1. On an **OPEN** pay card, use **Pay from another chain** → the rail
   opens with network/token selects and a refund address (prefilled with
   the payer's own account — verify it).
2. **Quote.** One press creates **one** attempt (idempotency key: retries
   reuse it, so a second deposit address can never be minted). You get a
   deposit address, amount and deadline.
3. **Deposit, by hand.** Send exactly the quoted amount from your wallet
   to the deposit address **before the quote deadline**. This is a real
   wallet signature in your hand — never scripted, never injected.
4. **Polling.** The page polls the Worker on its own cadence through
   `DEPOSIT_SEEN → SETTLING → SETTLED`. **Do not pay again** at any
   point; the pay buttons stay gated for exactly this reason.
5. **Success is VERIFIED — only VERIFIED.**
   - `SETTLED` ("Converted — awaiting verification") is a *provider claim*,
     not proof: Paylink is independently verifying the payout on NEAR. The
     receipt does **not** render, the shared sentence does **not** appear.
   - `VERIFIED` renders the cross-chain receipt with
     **"Payment delivered and verified on NEAR"** and the PDF button.
   - Any **conflict** notice (`already marked paid`, `double_payout`, …)
     → **do not send another payment**; it is a reconciliation item for an
     operator, and the UI blocks both payment paths.

## Hard rules (apply to every manual run)

- **Never bypass wallet security** — no scripted approvals, no injected
  keys, no "test mode" that skips a signature. Approvals happen in the
  wallet app, in your hand.
- **Testnet-only config** — `frontend/config.js` points at
  `paylink-v2.testnet`; do not repoint anything at mainnet for testing,
  and never commit `.env`, keys or webhook URLs (`.gitignore` already
  covers them).
- **No cross-provider double-payment or reverse-order race testing** —
  never deliberately pay one invoice via two providers or in two orders to
  "see what happens". The race logic is covered by mocks in
  `workers/tidepool/test/` (persist-before-verify, conflict recording,
  no-evidence-never-VERIFIED).
- **Never expose secrets** — no seeds, keys, tokens or webhook URLs in
  logs, terminal scrollback, issues, screenshots or uploaded artifacts.
  The workflows read no repository secrets at all.
- **Only VERIFIED counts** as a completed Tidepool payment — in test
  results, in the UI, in any report you write from this run.
- **Don't fake it** — if a journey cannot be completed safely, record what
  stopped it and stop. A green checkmark for a payment that did not happen
  is worse than no checkmark.

## What CI covers vs. what stays manual

| Step | Where |
|---|---|
| UI states, validation, errors, receipts, mobile layout | automated, mocked — `e2e-smoke.yml` on every PR |
| Live chain reachable, a real invoice renders read-only | `e2e-testnet.yml`, manual dispatch |
| Creating a link (wallet approval) | **manual — Journey A.1** |
| Paying (one wallet approval) | **manual — Journey A.2** |
| PAID → CLAIMED keeper settlement + receipt | **manual — Journey A.3–5** (keeper itself: `workers/keeper` tests) |
| Tidepool quote → deposit → polling → VERIFIED | **manual — Journey B** (Worker logic: `workers/tidepool/test/`) |
