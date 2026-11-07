# Paylink contract

Payment links on NEAR. A payee records what they are owed; a payer settles it by
sending NEP-141 tokens with the link id in `msg`; anyone can then release the
money to the payee, minus a fixed 0.5% fee.

The proof of payment is `ft_on_transfer(sender_id, amount, msg)` — a call made
**by the token contract**, not by a user. There is no `mark_paid` method.

---

## Build

```bash
cargo near build non-reproducible-wasm --abi-features near-sdk/unit-testing
#   -> target/near/paylink_contract.wasm        (~156 KB, ABI embedded)
```

`--abi-features near-sdk/unit-testing` is required. cargo-near's ABI step links
a host `cdylib`, and near-sdk's `unit-testing` feature is what supplies NEAR's
host-side stubs (`storage_has_key`, `promise_batch_create`, …). Without it the
link fails on undefined references.

## Test

```bash
cargo test --lib
#   test result: ok. 38 passed; 0 failed; 0 ignored
```

## Deploy and initialise

Deploy and call `new` in one transaction. `new` is **payable** and `#[private]`:
it needs 0.02 NEAR per allowlisted token, because it registers both this
contract and the fee account as NEP-145 balance holders.

```bash
near contract deploy paylink-v2.testnet \
  use-file target/near/paylink_contract.wasm \
  with-init-call new json-args \
  '{"allowed_tokens":["usdc.tidepool-sandbox.testnet"],"fee_account":"paylink-fees.testnet"}' \
  prepaid-gas '100.0 Tgas' \
  attached-deposit '0.02 NEAR' \
  network-config testnet sign-with-keychain send
```

The live account is `paylink-v2.testnet`: the first deployment
(`paylink.testnet`) was initialised with an earlier allowlist, and `#[init]`
runs once, so the token switch took a fresh account with the same wasm.

Then confirm both registrations actually landed:

```bash
near contract call-function as-read-only usdc.tidepool-sandbox.testnet storage_balance_of \
  json-args '{"account_id":"paylink-v2.testnet"}' network-config testnet now

near contract call-function as-read-only usdc.tidepool-sandbox.testnet storage_balance_of \
  json-args '{"account_id":"paylink-fees.testnet"}' network-config testnet now
```

Each should return `{"total":"1250000000000000000000","available":"0"}` rather
than `null`. `null` means that account is **not** registered, and the matching
transfer leg will fail.

---

## Interface

### State-changing

| Method | Payable | Deposit | Called by |
| --- | --- | --- | --- |
| `new(allowed_tokens, fee_account)` | yes | ≥ 0.02 NEAR per token | the contract account, once |
| `create_link(link_id, amount, token, description, expires_at)` | yes | ≥ 0.01 NEAR | payee |
| `ft_on_transfer(sender_id, amount, msg)` | yes | 0 or 1 yocto | **the token contract** |
| `claim(link_id)` | yes | exactly 1 yocto | anyone |
| `on_claimed(link_id, result)` | no | — | this contract (private callback) |

### Read-only

| Method | Returns |
| --- | --- |
| `get_link(link_id)` | `Option<Link>` |
| `get_links_by_creator(creator)` | `Vec<Link>` |
| `link_count_by_creator(creator)` | `u64` |
| `is_token_allowed(token)` | `bool` |
| `fee_account()` | `AccountId` |
| `fee_bps()` | `u32` (50 = 0.5%) |

## Conventions worth knowing

- **Timestamps are milliseconds**, not NEAR's native nanoseconds. Nanoseconds
  (~1.8e18) overflow JavaScript's `Number` and would silently corrupt every
  browser-side expiry check. The contract converts once at
  `env::block_timestamp() / 1_000_000`.
- **The token allowlist is immutable.** It is set in `new()` and has no setter,
  so widening it requires a visible code upgrade rather than a quiet call.
- **The fee is a constant**, `FEE_BPS = 50`, and the fee account is fixed at
  init. Neither can be changed by a call. The payout and the fee are queued as
  one batch to the token contract, so they succeed or fail together.
- **`claim` is callable by anyone but can only pay the invoice's payee and the
  fee account.** The caller is never a payment destination. This is what lets
  the frontend release a paid invoice for a payee who is offline.
- **`create_link` registers the creator with the token** (fire-and-forget
  `storage_deposit`, 0.005 NEAR out of the 0.01 NEAR stake), so the later payout
  cannot fail because the payee was never registered. Already-registered payees
  get the deposit refunded.
- **`create_link` costs 0.01 NEAR** to stop free spam from draining the
  contract's storage balance.
- **`claim` marks `CLAIMED` before it transfers.** This blocks a second claim
  while the first is in flight; `on_claimed` reverts it to `PAID` if the
  transfer fails, so nothing is ever stranded and anyone can retry.
- **`ft_on_transfer` is `#[payable]`** so it accepts 0 or 1 yoctoNEAR from any
  token implementation.
- **Every rejection path in `ft_on_transfer` returns the full `amount`**, which
  the token contract refunds to the payer automatically. A failed payment costs
  the payer nothing.
- **The payee cannot pay their own link.** When `sender_id` is the link's
  creator, `ft_on_transfer` returns the full amount: the self-payment is
  refunded and the link stays `OPEN` until somebody else pays it.

## Useful Links

- [cargo-near](https://github.com/near/cargo-near) — build, test and deploy tooling
- [near CLI](https://near.cli.rs) — command line interface
- [NEAR Rust SDK](https://docs.near.org/sdk/rust/introduction)
- [NEP-141 Fungible Token](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)
- [NEP-145 Storage Management](https://github.com/near/NEPs/blob/master/neps/nep-0145.md)
