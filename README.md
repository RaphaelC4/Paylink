# Paylink

**First, the honest part: creating a link needs no NEAR from the payee** —
the wallet signs a delegate action off-chain (a signature is free), Paylink's
relayer pays the gas and the 0.01 NEAR storage stake, and the link still
belongs to the payee. A wallet that cannot sign a delegate falls back to the
direct transaction and covers that one creation itself (0.01 NEAR stake plus
gas). After that the payer signs once to send the money, and the payee signs
nothing.

**Send someone a link. Get paid from whatever they already hold.**

Paylink turns an invoice into a URL. A freelancer in Lagos sends a client in
Berlin a link. The client pays with the tokens already in their wallet. The
freelancer receives them on NEAR and never had to walk a client through a seed
phrase. The payer signs once to send the money — from then on the freelancer
signs nothing.

**On gas:** the track hints at meta transactions; Paylink uses them — a
NEP-366 delegate action carries `create_link` to chain with the relayer
paying the gas and the stake, while `claim` is callable by anyone and can
only pay the invoice's payee, so the release is signed by whoever is holding
the app (or by the keeper Worker) and the payee never holds gas
([how the relayer works](#references)).

Built for **NEAR HACKATHON**, track **`realworld` — Real-World Money**.

**Live demo:** <https://paylink-near.vercel.app/> ·
**Demo video:** [`docs/Paylink-demo-full.mp4`](docs/Paylink-demo-full.mp4) ·
**Launch post:** <https://x.com/agu_raphael_/status/2119552525439492372> ·
**Contract:** [`paylink-v2.testnet`](https://testnet.nearblocks.io/address/paylink-v2.testnet)
on NEAR testnet explorer

---

## The problem

Getting paid across borders still costs money and time.

| Route | What it costs |
| --- | --- |
| Bank wire | $25–45 in fees, 3–5 days, bank details shared with a stranger |
| PayPal / Wise | Poor support from many countries, freeze risk, still not instant |
| "Just send me crypto" | Both sides must pick the same chain, avoid a wrong-network send, and understand gas |

Every route asks one side to learn the other side's world.

Paylink removes that requirement — even for creating the link. The payee's
wallet signs a delegate action off-chain and the relayer covers the 0.01 NEAR
stake and the gas for that first transaction (a wallet that cannot sign a
delegate pays it itself, once). After that, the payer uses what they have, and
the payee does not have to claim, sweep, or hold gas: the frontend releases a
paid invoice to them the moment it is settled, and a keeper Worker repeats
that release every minute so nothing waits on a browser staying open.

---

## What's proven

[Security](#security) below states the threat model. This is the other side:
what the build actually demonstrates, and the test that demonstrates it. All 38
tests are pure host tests — `cargo test --lib`. On-chain evidence for the
cross-contract steps that host tests cannot reach is
[in its own section](#one-full-run-on-chain) below.

| Behaviour | Proof |
| --- | --- |
| **Micro-invoices pay out.** A 100-unit link has a fee that rounds to zero, so `claim` skips the fee leg instead of failing on a zero-amount NEP-141 transfer, and the split never overflows or loses a unit. | `a_tiny_invoice_skips_the_fee_leg_instead_of_failing`, `split_fee_never_overflows_or_loses_a_unit` |
| **Nobody needs gas to get paid — not even for the link itself.** Creating the link goes through a NEP-366 delegate action: the payee signs off-chain and the relayer Worker attaches the 0.01 NEAR stake and pays the gas, measured on testnet with the payee's balance unchanged to the yocto across four creations. After that `claim` is callable by anyone, so the keeper releases every paid invoice within a minute from its own gas account — after the payer's single approval the frontend only watches the link move `PAID → CLAIMED` — and the payee holds no NEAR and signs nothing after payment. | `a_stranger_can_trigger_claim_but_only_the_payee_is_paid`, `claim_pays_the_payee_less_the_fee_in_one_batch`, `workers/keeper/test/sweep.test.mjs` (38 assertions over mocked RPC) |
| **Overpayment is never lost.** What arrived is what's credited, and the fee applies to the credited amount rather than the invoiced one. | `an_overpayment_is_credited_in_full`, `claim_applies_the_fee_to_an_overpayment` |
| **Paying twice never double-credits.** A link leaves `OPEN` once; a second payment is returned. | `paying_twice_does_not_double_credit` |
| **Expiry needs no background job.** `Expired` is derived on read from `expires_at`, never stored, so an aged link reports itself honestly and refuses payment. The same timestamp is also the due date: after it, payment is refused and the tokens return to the payer in the same transaction — a hard cutoff, rather than a late payment accepted and marked late. | `an_expired_invoice_cannot_be_paid`, `an_expired_invoice_is_reported_as_expired_even_unpaid` |
| **Sharing survives a dead RPC.** The QR code and Copy button are built from the link id alone — a vendored MIT encoder, no image request, no chain round trip. | `frontend/vendor/qrcode.js`, `qrMarkup()` in `frontend/app.js` |
| **The keeper needs no registry.** One `view_state` call with prefix `l` lists every link — and if that response ever gets too large or times out, it re-reads the same state as disjoint sub-prefix pages, keeps what it could read and claims it, so discovery scales without an indexer; it signs with the runtime's Ed25519 WebCrypto, so it is a single file with no dependencies. | `workers/keeper/src/index.js` |
| **Storage is funded up front.** `create_link` requires a 0.01 NEAR stake that covers its own storage and registers the payee on the token — on a delegated creation the relayer attaches it. | `create_link_requires_a_storage_stake`, `the_stake_really_is_ten_millinear` |
| **Settings are public getters.** The allowlist and both fee settings are readable by anyone, not admin-only views. | `the_allowlist_is_visible_to_callers`, `the_fee_settings_are_visible_to_callers` |

### One full run, on-chain

Host tests cannot execute the cross-contract steps, so here is a real run on
`paylink-v2.testnet` instead: link `keeper-005`, created, paid and released on
**5 Nov 2026** — the release signed by the keeper's cron, no human in the
loop.

| Step | Transaction |
| --- | --- |
| **Create** — payee calls `create_link` with a 0.01 NEAR stake, 12:14:24 UTC | [`4jLDBWkuAHRyPiZmGJmfN2uNdSsbJktvHhegH7rDCHaE`](https://testnet.nearblocks.io/txns/4jLDBWkuAHRyPiZmGJmfN2uNdSsbJktvHhegH7rDCHaE) — Success |
| **Pay** — payer calls `ft_transfer_call` for 3 USDC, **8 seconds later** | [`7LiwE8BvSoUdoHZJmBA85App2TVWkVugvWyE57LTocLn`](https://testnet.nearblocks.io/txns/7LiwE8BvSoUdoHZJmBA85App2TVWkVugvWyE57LTocLn) — Success |
| **Claim** — keeper cron calls `claim` 2 min 39 s later: 2.985 USDC to the payee, 0.015 to fees | [`HrrNqKHZoQu7QFZMENzsYT9eBxLqujRQrK8YuXvdocD1`](https://testnet.nearblocks.io/txns/HrrNqKHZoQu7QFZMENzsYT9eBxLqujRQrK8YuXvdocD1) — Success |

That is one link's full lifecycle in three transactions, all visible in the
explorer. This was not a one-off: the keeper's cron has released links on
testnet repeatedly — [`paylink-keeper.testnet`](https://testnet.nearblocks.io/address/paylink-keeper.testnet)
lists every `claim` it has sent, and each released link reads `CLAIMED` with a
`claimed_at` timestamp when queried on chain.

**After the payee-registration fix**, the same three-step cycle was run again
live against the deployed code on **6 Nov 2026**, link `review-fix-001`
(1 USDC): create
[`Frh8z8mdXTTwKBwtyi33k9paYJQ6K6AE3LMKkFp6FPGv`](https://testnet.nearblocks.io/txns/Frh8z8mdXTTwKBwtyi33k9paYJQ6K6AE3LMKkFp6FPGv) →
pay
[`4dVD9fRSwd5Hmq9dimJNxoUECbPwBM3p39dfFeykyGXb`](https://testnet.nearblocks.io/txns/4dVD9fRSwd5Hmq9dimJNxoUECbPwBM3p39dfFeykyGXb) →
claim
[`8WmbLm4E92XE9cgoGZHhvwCuBNS6rbqDeVtJw8Fp1jw6`](https://testnet.nearblocks.io/txns/8WmbLm4E92XE9cgoGZHhvwCuBNS6rbqDeVtJw8Fp1jw6) —
the claim's logs show the registration receipt executing before the payout
batch, which is the fix working end to end.

**With the relayer in front of `create_link`**, the creation step no longer
touches the payee's wallet at all. Link `lnk-jhfmt56d` (3.25 USDC, 72-hour
expiry) was created on **7 Nov 2026** through the full browser flow — Meteor
Wallet signed a delegate action, the frontend POSTed it to the relayer
Worker, the Worker wrapped and signed the transaction as
`paylink-relay.testnet`:
[`pYBw2vTh8B3ZDK7qwbDqre8x5c7iHqEzTLFVD68USYU`](https://testnet.nearblocks.io/transactions/pYBw2vTh8B3ZDK7qwbDqre8x5c7iHqEzTLFVD68USYU) —
Success. The payee's balance read 19.7890472296385996 NEAR before and after;
the relayer's dropped by 0.010514 (stake plus gas). Three earlier creations
proved the same path from other angles: `spikea01`
([`HJML2cY2AfWb5Tcows4C3BmyEAGV3FigtQ8xXGrtLwTz`](https://testnet.nearblocks.io/transactions/HJML2cY2AfWb5Tcows4C3BmyEAGV3FigtQ8xXGrtLwTz),
signed by near-cli-rs), `spikea02`
([`B37vJV8ZfGK3yo8KAQDoqjkPdi3yipVBsNX3GhijTWNf`](https://testnet.nearblocks.io/transactions/B37vJV8ZfGK3yo8KAQDoqjkPdi3yipVBsNX3GhijTWNf),
signed by Meteor Wallet) and `spikea03`
([`26asviviWDe7EFprdWH6fgDhrJUoUjRhJwZYLkKzJQcm`](https://testnet.nearblocks.io/transactions/26asviviWDe7EFprdWH6fgDhrJUoUjRhJwZYLkKzJQcm),
submitted through the Worker's `POST /submit` exactly as the frontend does).
All four links read `creator: paylink-payee.testnet` on chain.

---

## How it works

### The contract

`contracts/` holds a NEAR contract with exactly three jobs:

1. **Record a request.** `create_link` stores who is owed, how much, in which
   token, by when.
2. **Recognise payment.** The contract implements NEP-141 `ft_on_transfer`.
   When tokens arrive, the token contract itself calls the contract and passes
   the link id in `msg`. The contract checks it and marks the link paid.
3. **Release the money.** `claim` first makes sure the payee is registered on
   the token — a deposit from the contract's own balance, refunded in full if
   they already are — then sends the credited amount to the payee, minus a
   fixed 0.5% fee. **Anyone can call it** — the money can only go to the
   invoice's payee and the fee account, never to the caller — so the frontend
   releases a paid invoice for the payee instead of asking them to come back
   and sign something, and `workers/keeper/` repeats the release from a cron
   every minute as the backstop.

**There is no `mark_paid` function.** Nothing in the public interface lets
anyone assert that a link was paid. The only code path that marks a link paid
is `ft_on_transfer`, and it is invoked by the token contract, not by a user.
A caller cannot forge it without actually sending the tokens.

**The payee cannot pay their own link.** `ft_on_transfer` compares `sender_id`
with `link.creator` and returns the full amount when they match, so a creator's
payment is refunded and the link stays unpaid until somebody else pays it. The
pay page shows the creator a waiting state with the share tools instead of a
Pay button.

**The contract holds funds only between payment and claim, and `claim` is the
only way out.** It can pay exactly two destinations: the invoice's payee and
the fee account. Nothing else in the interface can move a balance. See
[Security](#security) for why the transfer is a separate call rather than
happening inline.

### The token

The contract is **token-agnostic but not token-blind**. It keeps an allowlist
of accepted token contracts and rejects anything else by returning the full
amount, which the token contract refunds to the sender automatically.

The allowlist is set once in `new()` and has no setter, so **widening it
requires a code upgrade signed by the deployer's key** rather than a quiet
call. That is the point: even the deployer cannot add an acceptance path
without the deploy showing up in the transaction history.

### The payer's path

- **Already on NEAR (the path the demo exercises):** send `ft_transfer_call`
  with `msg = <link id>`.
- **Arriving empty, or holding something else:** the pay page carries a
  Tidepool rail under **No test USDC?**. *Get test tokens* drips 100 test
  USDC (plus USDT, wNEAR and dust) into the connected wallet in one keyless
  call; the swap row quotes a deposit of wNEAR, USDT or ETH that settles into
  exactly this link's amount (native NEAR is not a source — it pays gas and
  nothing else). Both are free, both are testnet-only, and if Tidepool is
  unreachable the rail shows the error while the normal pay flow is
  untouched. The faucet itself is site-wide: the Account panel carries the
  same *Get test tokens* card at every size, and on phones a **Faucet** chip
  beside the floating bar opens it as a bottom sheet.

The on-chain path ends in `ft_on_transfer` called by the token contract, and
that call — not any user call — is what marks an invoice paid.

### Reading the chain

The one thing the share page exists to hand over is the link, so it never
waits on the chain. The QR code and the Copy button are built from the link id
alone: the QR comes from a vendored MIT encoder (`frontend/vendor/qrcode.js`)
that renders in the browser with no image request and no third-party service,
and the copy field needs only the URL. Only the WhatsApp / Telegram row reads
the chain, because those messages embed the amount.

Every other read has a 12 s timeout and a retry, so a slow or rate-limited
public endpoint surfaces as *Could not read the chain* with a **Try again**
button rather than a spinner that never resolves. The endpoint itself is
`test.rpc.fastnear.com`, set in `frontend/config.js`. The previously used
`rpc.testnet.near.org` is deprecated: it answers `429` with **no CORS
headers**, so a browser only ever sees `Failed to fetch` and cannot tell a
rate limit from an outage.

### Invoice parsing (optional)

Pasting an invoice is a convenience, not a trust boundary. `workers/parse/` is a
~150-line Cloudflare Worker that sends pasted text or one PDF/image to Gemini
and returns exactly five fields. The API key is a Worker secret; the browser
never sees it. The model's answer is treated as a proposal:

- amount must be a plain decimal, finite, positive, and at most 1,000,000 in
  base units — no exponent, no separators, no rounding surprises;
- the token must pass `is_token_allowed` **read from the chain**, or match the
  one token this deployment accepts by contract id or known alias;
- the payee is compared with the connected wallet and surfaced, never used —
  `create_link` issues to `predecessor_account_id` and ignores any payee field;
- the description is stripped of control characters and cut to 200 characters;
- the expiry is clamped to an integer number of hours between now and 365 days.

If any check fails the form is left untouched and the reason is shown. Nothing
the model returns can reach the contract without the user pressing **Create
link**. Leave `parseEndpoint` empty in `frontend/config.js` and the block does
not render at all.

### The release keeper

`workers/keeper/` is a small Cloudflare Worker, with no dependencies, that
releases paid links from a cron every minute. It exists because the frontend's
release can fail: the wallet prompt can be rejected, the tab can close, the
network can drop. Discovery needs no registry — one `view_state` call with
prefix `l` lists every link the contract stores, and anything sitting in `PAID`
gets claimed, up to 10 per sweep. That single call is only the fast path: if
it fails after its retry, the same coverage is fetched as disjoint sub-prefix
pages, whatever was read is still claimed, and the next sweep re-covers the
rest from scratch.

It signs with the runtime's own Ed25519 WebCrypto, so the Worker is a single
file deployable from the dashboard. It pays gas from its own testnet account
(`paylink-keeper.testnet`); the payout still lands only on the link's payee
and the fee account, because that is all `claim` can pay. `POST /tick` runs the
same sweep on demand behind a secret, for tests and demos.
`workers/keeper/README.md` has the deploy steps.

### The relayer

`workers/relayer/` is the second Cloudflare Worker, also a single dependency-free
file. It makes creation free for the payee: the wallet signs a NEP-366
`DelegateAction` for `create_link` off-chain — a signature costs nothing — and
POSTs it to `POST /submit`. The Worker borsh-parses the delegate and validates
it before spending a yocto: outer receiver must be the delegate's sender
(NEP-366 rule 3), inner receiver must be the contract, the single action must be
`create_link` with at least the 0.01 NEAR stake, sane link id / amount / token /
description / future expiry, a nonce that beats the sender's access key, a
`max_block_height` still ahead of the chain, and — proven against two fixtures
the chain accepted — the signature itself under NEP-461's preimage (the NEP-366
discriminant prefixed to the delegate bytes, hashed). Rate-limited to 10
submissions per IP per hour, and it refuses to spend below a 1 NEAR balance
floor. Only then does it wrap the raw delegate bytes in a transaction signed by
`paylink-relay.testnet` and broadcast it.

On chain the inner call executes with the payee as `predecessor`, so the link's
creator is the payee exactly as with a direct transaction — no contract change.
Measured on testnet: the payee's balance does not move by one yocto; the relayer
pays the stake and gas. The frontend takes this path whenever
`CONFIG.relayer.endpoint` is set and the wallet offers `signDelegateActions`
(Meteor Wallet does); otherwise it falls back to the direct transaction, and a
failed relayer POST surfaces as an error rather than silently making the payee
pay. `workers/relayer/test/parse.test.mjs` (45 assertions) runs the parser,
validator and tx builder against the two real signed fixtures.

---

## Where the money moves

This is the part a bookkeeper cares about.

```
Payer's wallet
      │  ft_transfer_call(msg = link id)
      ▼
Paylink contract            ← credits the link, returns 0 (all tokens used)
      │  storage_deposit(payee)   register the payee first — refunded in full
      │                           if already registered
      │  ft_transfer(99.5% → payee)  ┐ one batch, so they
      │  ft_transfer(0.5%  → fee)    ┘ succeed or fail together
      ▼
Payee's wallet
```

At no point does a company, an operator, or a server hold the money. The
contract has **no owner, no admin function, and no withdrawal path in its
code**: the fee account is fixed in `new()` with no setter, and the 0.5% rate
is a constant. Changing either requires a code upgrade signed by the
deployer's key — and that key is real. Whoever holds it can redeploy
`paylink-v2.testnet` with different code, which is the one power retained
outside the contract. That is how NEAR deployments work rather than a
backdoor in this code, and it is stated here rather than left for a reviewer
to discover.

If any check fails — unknown link, expired, underpayment, token not
allowlisted — the contract returns the full amount and the token contract
refunds the payer automatically. **A failed payment costs the payer nothing.**
Overpayment is not a failure: what arrived is credited in full, so the payee
keeps the excess and the fee is taken from the credited amount rather than the
invoiced one.

---

## How to use

> These steps are the acceptance criteria for this build. They are written as
> `do X, see Y` so a reviewer can follow them without asking anyone.

**Network:** NEAR testnet · **Cost:** free (faucet-funded)

1. **Get two funded accounts.** Create a payee and a payer in a wallet the app
   lists (Meteor gives each new testnet account 10 NEAR). Then give the payer
   test USDC — either in the app (open any link, expand **No test USDC?**,
   press **Get test tokens**) or ahead of time with one call:

   ```bash
   curl -X POST https://www.usetidepool.tech/v0/faucet \
     -H "Content-Type: application/json" \
     -d '{"accountId":"<payer>.testnet","mode":"wallet"}'
   ```

   See `ft_balance_of(<payer>)` return `"100000000"` (100 USDC, 6 decimals).
   The wallet must hold the key for these accounts, because only the wallet can
   sign the app's transactions. If you created them with
   `near account create-account sponsor-by-faucet-service`, import the generated
   key into the wallet first.
2. **Create a link.** Open the app, connect a wallet, enter an amount and an
   optional note, press *Create link*. The button reads *Creating link…* while
   the wallet prompt is open; the app then lands on the share page with a
   copy field, a QR code, WhatsApp / Telegram / Email buttons and the status
   pill *UNPAID*.
3. **Copy the link.** Press *Copy* — the button flips to *Link copied!* — and
   open it in a second browser profile or a second wallet.
   See the link rendered with *Pay* available — the amount in dollars with an
   indicative naira line beneath it (fetched once from a public FX reference,
   hidden on its own if that reference is unreachable) — and *Expired* or *Paid*
   correctly reflected once the state changes.
4. **Pay it.** Switch the wallet to a payer account, press *Pay*, approve the
   transaction. See the timeline move `Open → Paid` and the payer's token
   balance decrease by exactly the link amount. If the payer holds no USDC,
   expand **No test USDC?** first: *Get test tokens* funds them for free, and
   the swap row covers the exact amount from wNEAR, USDT or ETH instead.
5. **Watch it release.** There is no second approval. The status line moves
   from *Your payment is being confirmed.* to *Payment confirmed! Your funds
   are being released automatically.*, and the keeper Worker — a Cloudflare
   cron sweeping every minute from its own gas account — calls `claim`. See
   the timeline move `Paid → Claimed`, the status line read *Payment completed
   successfully. The recipient has received the funds.*, the payee's token
   balance increase by 99.5% of the invoice, and the fee account increase by
   0.5%. `claim` is callable by anyone but can only pay the link's creator, so
   the payee never signs anything either. The *Release* button stays on the
   `PAID` card as manual fallback — anyone can press it if the keeper is ever
   down — and a second release attempt fails with `link is not paid`.
6. **Check My links.** Enter the creator account in *My links* and press *Load*.
   See the link listed with its id, amount, status and the payer that
   settled it — read straight from `get_links_by_creator`, unsigned. The stats
   row shows total received and awaiting payment; the filters narrow the list
   to All / Unpaid / Paid / Expired. The **Activity** panel works the other
   way round: a payee sees their created links from the chain, while a payer
   sees only the links this browser paid for — those ids are written to
   `localStorage` at payment time, because the contract indexes by creator,
   not by payer. Clearing site data clears that local history and nothing
   else.
7. **Export it.** Press *Export CSV*. See a file an accountant can open that
   contains the same rows with no jargon columns — no gas, no contract
   addresses, no yoctoNEAR.
8. **See a payment rejected.** Call `ft_transfer_call` on the token with an
   `amount` below the invoice and `msg` set to the link id. See the call
   succeed, the token contract refund the payer in full, and the link still
   `OPEN`.
9. **See a forgery rejected.** Call any method you can find that would mark a
   link paid without paying. See that no such method exists, and that
   `ft_on_transfer` from a token contract that is not on the allowlist returns
   the amount instead of crediting anything.

---

## Security

The design choices here are the product. They are listed because a reviewer
will look for them.

| Risk | Handling |
| --- | --- |
| Forging a "paid" status | No such method exists. Payment status is written only by `ft_on_transfer`, called by the token contract. |
| Payee pays their own link | `ft_on_transfer` returns the full amount when `sender_id == link.creator`, so a self-payment is refunded and the link stays `OPEN`. The UI shows the payee a waiting state instead of a Pay button. |
| Fake tokens | `predecessor_account_id` is checked against an allowlist. Unexpected token contracts get the full amount returned, per [NEAR's `ft_on_transfer` guidance](https://docs.near.org/smart-contracts/security/cross-contract-calls/ft-transfer-call). |
| Underpayment | The credited amount must be at least the invoiced amount, otherwise the full amount is returned. |
| Replaying one payment across links | Each `msg` names one link, and a link can only leave `OPEN` once. |
| Payee never receives the funds | `claim` pays only `link.creator` and the fee account, never the caller. A failed transfer reverts the link to `PAID` so anyone can retry. |
| Payee not registered with the token | `create_link` registers the payee but does not wait for the result, so `claim` now registers them again before every payout — a `storage_deposit` paid from the contract's own balance, refunded in full when the payee is already registered. If that registration fails, the payout batch fails too, `on_claimed` returns the link to `PAID`, and the next attempt — frontend or keeper, every minute — starts over. A slow registration can delay a payout; it can no longer strand one. Fixed in this build and deployed: test `claim_re_registers_the_payee_before_paying_out`, live in tx [`AZES8yzvj3nBxWeAe4HmgYfQMbqBPBYwGzdBXGUkDvYy`](https://testnet.nearblocks.io/txns/AZES8yzvj3nBxWeAe4HmgYfQMbqBPBYwGzdBXGUkDvYy). |
| Stuck links crowd out others | The keeper claims at most 10 links per sweep — a per-tick gas bound, not a queue with a tail. Every sweep re-reads contract state and takes the first 10 links still sitting in `PAID`, in contract key order, so a link one tick settled leaves the set and the next one in key order moves up. A link whose claim fails does not move to the back — it keeps its place in that order and is retried on every later sweep, holding one of the ten slots until a claim lands. That is precisely why the one failure which could make a claim fail forever (an unregistered payee) is now retried inside `claim` itself: the retry has to succeed rather than occupy a slot indefinitely. The in-app release and the manual *Release* button call the contract directly and bypass the keeper entirely. |
| Someone claims on the payee's behalf | `claim` is deliberately callable by anyone, but the payout address comes from the invoice, not from the caller. A stranger can only cause the payee to be paid. |
| Payer loses money on a bad payment | Every rejection returns the full amount; the token contract refunds the sender. |
| Deployer holds power | No admin function, no owner and no withdrawal path in the contract's code. The fee account and the 0.5% rate are fixed at deploy; changing either needs a code upgrade signed by the deployer's key — and that key can redeploy the contract, so the deployer retains that one power outside the code. |

**Not audited.** This is a hackathon build. Do not send real funds to
it.

---

## Honest limitations

Stated plainly, because saying otherwise would be worse than saying it.

- **Testnet only.** The demo runs on NEAR testnet with
  `usdc.tidepool-sandbox.testnet` (6 decimals) — Tidepool's sandbox test USDC —
  so no real money is involved. The contract is written to run on mainnet USDC
  unchanged — only an allowlist entry and a frontend config value would differ —
  but it has not been deployed there or tested against a mainnet token. The
  accepted token is also fixed at deploy (`#[init]` runs once), so moving this
  build to a different token took a fresh contract account — exactly how it
  went from `paylink.testnet` to `paylink-v2.testnet`, as described in
  [Development](#development).
- **Not production ready.** No audit, no indexer. Payment detection relies on
  the frontend polling contract state; the relayer caps submissions per IP and
  keeps a balance floor, but nothing here is hardened for mainnet traffic.
  Both of those guards are best-effort rather than a hard bound: the per-IP
  count lives in a single Worker instance's memory (a second instance allows
  the full quota again, and a restart clears it), and `ALLOWED_ORIGIN` only
  constrains browsers, which a script is free to ignore — so the real limit
  is the relayer's 1 NEAR balance floor, several hundred links away at the
  current balance. Testnet NEAR only, so nothing of value is at stake.

---

## Reused code and AI assistance

Disclosed under [HACKATHON.md](https://nearhackathon.com/HACKATHON.md) **Q-002**
(existing product on another chain) and **Q-005** (list reused code and AI code).

**Reused from my earlier [Polaris](https://github.com/RaphaelC4/Polaris) project**
(GenLayer StudioNet, committed 23-26 Oct 2026 — a different chain, not part of
this submission):

- The static, build-step-free frontend structure: hash routing, the tabbed
  shell, and the `?flat=1` screenshot flag.
- The CSS conventions that came with it: `.tiny`, `.mono`, `.pill`, `.net-k`
  and `html.flat`.

**Written new for this hackathon:** the NEAR contract, the keeper and parser
Workers, the NEAR wallet layer, the pay / release / My links flow, and the
design system — its palette, layout and components.

**Not used:** no GenLayer code, calldata codec or dependency appears anywhere in
this build.

**Third-party libraries**, listed per Q-005:

- [`@hot-labs/near-connect`](https://github.com/azbang/near-connect) (HOT
  Labs, MIT) — the wallet layer, vendored as `frontend/vendor/near-connect.js`
  so the page needs no bundler, no npm install and no CDN. At runtime it
  fetches its wallet-selector manifest from
  `raw.githubusercontent.com/hot-dao/near-selector` — the wallet's own
  registry; no application data leaves the browser. Documented in
  `frontend/vendor/README.md`.
- QR Code Generator by Kazuhiko Arase (MIT, per the file header) — vendored as
  `frontend/vendor/qrcode.js`; renders the QR in the browser with no image
  request.
- Satoshi by Indian Type Foundry — self-hosted `.woff2`, free under the
  [Fontshare licence](https://www.fontshare.com/licenses/itf-ffl); documented
  in `frontend/fonts/README.md`.
- Gemini — called only by `workers/parse/` behind a Worker secret, described in
  [Invoice parsing](#invoice-parsing-optional); the browser never holds the key.

**AI assistance:** this build was written with AI assistance (Claude) — the
contract, the frontend and the Workers. Q-005 explicitly allows it, so it is
listed here rather than left for a reviewer to infer.

---

## Hackathon diff

Everything in this repository was committed inside the NEAR HACKATHON window
(19 Oct – 14 Nov 2026); there is no earlier code to exclude. Two tags mark the
window for review:

- `pre-hackathon` — empty baseline (the repository did not exist before the window)
- `hackathon-submission` — the state submitted for judging

Full diff between them:
<https://github.com/RaphaelC4/Paylink/compare/pre-hackathon...hackathon-submission>

---

## Development

```bash
# prerequisites: rustup with the wasm32-unknown-unknown target, cargo-near,
# near-cli-rs, and nasm (near-sdk's aws-lc-sys needs it for host builds)
cargo near new contracts/paylink-contract   # generated project; never hand-rolled

cargo test --lib                            # 38 unit tests, all pure host tests

# the three JS suites — no dependencies, plain node:
node workers/relayer/test/parse.test.mjs    # 45 assertions: delegate parse + signing
node workers/keeper/test/sweep.test.mjs     # 38 assertions: settlement, retry, logs
node frontend/test/one-approval.test.mjs    # 26 assertions: one payer approval only
node frontend/test/parse-errors.test.mjs    # 48 assertions: parse errors + L-06 timeout

# build the wasm with its NEP-330 ABI embedded
cargo near build non-reproducible-wasm --abi-features near-sdk/unit-testing
#   -> contracts/paylink-contract/target/near/paylink_contract.wasm   (156 KB)

# testnet accounts (keys saved to ~/.near-credentials)
near account create-account sponsor-by-faucet-service paylink-v2.testnet \
  autogenerate-new-keypair save-to-legacy-keychain
near account create-account sponsor-by-faucet-service paylink-fees.testnet \
  autogenerate-new-keypair save-to-legacy-keychain

# deploy + init in one transaction. `new` registers the contract and the fee
# account with the token, so it needs 0.02 NEAR per allowlisted token.
near contract deploy paylink-v2.testnet \
  use-file target/near/paylink_contract.wasm \
  with-init-call new json-args \
  '{"allowed_tokens":["usdc.tidepool-sandbox.testnet"],"fee_account":"paylink-fees.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0.02 NEAR' \
  network-config testnet sign-with-keychain send

# frontend (static, no build step)
cd frontend && python -m http.server 8000
```

The live deployment is **`paylink-v2.testnet`**. The first account,
`paylink.testnet`, was initialised with the previous allowlist, and `#[init]`
runs once — switching the accepted token therefore took a fresh account with
the same wasm rather than a re-init.

The invoice parser is optional and is not built here. Deploy it by pasting
`workers/parse/src/index.js` into a Cloudflare Worker (dashboard → Workers &
Pages → Create → Worker), then add `GEMINI_API_KEY` as a **secret** and set
`ALLOWED_ORIGIN` to the demo's origin. Copy the Worker URL into
`frontend/config.js` as `parseEndpoint`. `workers/parse/README.md` has the
step-by-step and a `curl` check. Without it the "paste a payment request"
block simply does not render.

The release keeper deploys the same way: paste `workers/keeper/src/index.js`
into a second Worker (one file, no dependencies), add the `KEEPER_KEY` and
`TICK_SECRET` secrets plus four text variables, and set a `* * * * *` cron
trigger. `workers/keeper/README.md` has the steps and a `curl` check. Without
it the frontend still releases links itself — the keeper is the backstop.

The relayer is a third Worker of the same shape: paste
`workers/relayer/src/index.js`, add the `RELAYER_KEY` secret plus five text
variables, and put its `/submit` URL into `frontend/config.js` as
`relayer.endpoint` (then bump the `?v=` cache bust). `workers/relayer/README.md`
has the steps and the fund check. With the endpoint empty the create form
sends the direct wallet transaction — the payee covers that one stake and gas —
so the demo works with or without it.

`--abi-features near-sdk/unit-testing` is not optional on a host build:
near-sdk's ABI step links a host `cdylib`, and `unit-testing` is what
supplies NEAR's host-side stubs. Without it the link fails on
`storage_has_key`, `promise_batch_create` and friends.

Keys belong in `.env`. Never in the repository.

---

## Deploy the demo

The frontend is static: no build step, no server, no GitHub. Any host that
serves a folder works. Two that need no install and no repository connection:

- **Vercel** — open <https://vercel.com/new/drop> and drag the `frontend/`
  folder onto the page. It returns an HTTPS URL in a few seconds. (The CLI
  works too: `npx vercel` inside `frontend/` after `npx vercel login`.)
- **Cloudflare Pages** — Workers & Pages → Create → Pages → *Upload assets*,
  then upload `frontend/`.

Both keep the hash routing intact (`/#pay/<id>`), so payment links work as
soon as the folder is uploaded. If you deploy the parser too, set its
`ALLOWED_ORIGIN` to the new origin and put the Worker URL in
`frontend/config.js` before uploading.

---

## References

- [NEAR HACKATHON](https://nearhackathon.com/) · [HACKATHON.md](https://nearhackathon.com/HACKATHON.md)
- Track prompt: `tracks/08-realworld.md`
- [NEP-141 Fungible Token Standard](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)
- [NEP-366 Meta Transactions](https://docs.near.org/protocol/transactions/meta-tx.md)
  · [NEP-461 signing scheme](https://github.com/near/NEPs/pull/461): used for
  `create_link`. The payee's wallet signs a `DelegateAction` off-chain, the
  relayer Worker validates it (receiver, method, stake, nonce, expiry, and the
  NEP-461 signature) and submits it signed by `paylink-relay.testnet`, which
  pays the gas and the 0.01 NEAR stake — while the inner call still runs with
  the payee as predecessor, so the link belongs to the payee exactly as with a
  direct transaction ([how the relayer works](#the-relayer)). The payer's
  wallet signs their own payment, and `claim` can be called by anyone but can
  only pay the invoice's payee and the fee account: the release is signed by
  whoever is holding the app (or by the keeper Worker). Between the two, the
  payee never holds gas at any point in the lifecycle.
- [1Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart) · [Tidepool testnet sandbox](https://www.usetidepool.tech/docs/quickstart)
- [NEAR docs index](https://docs.near.org/llms.txt) · [NEAR Intents docs index](https://docs.near-intents.org/llms.txt)
