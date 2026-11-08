# Relayer notes — spike evidence, signature preimage, tx format

Everything here was measured on NEAR testnet on 7 Nov 2026 against the
deployed `paylink-v2.testnet`. The contract was not changed for any of it.

## Why no contract change: `predecessor_account_id` survives delegation

NEP-366 executes the inner actions with `delegate_action.sender_id` as the
predecessor and `receiver_id` as the receiver; the relayer is only the outer
transaction's signer. `create_link` reads `env::predecessor_account_id()` for
the creator, so a delegated call produces a link whose `creator` is the payee —
identical to a direct call. Verified on chain four times (below).

## The spike: who pays the 0.01 NEAR stake?

NEP-366's spec is ambiguous on the deposit's refund path, and docs vs. source
disagreed. Settled empirically: **the relayer pays.** Gas and attached deposit
both come from the outer signer; the delegate's nonce/key checks run against
the *sender's* access key, but the funds are the relayer's.

| Test | Question | Result |
| --- | --- | --- |
| A | Does the payee's balance move when a relayer submits their `create_link`? | **No — 0 yocto across three transactions.** Payee read 19.7890472296385996 NEAR before and after every run. The relayer (stand-in `paylink-keeper.testnet`) dropped 0.0105122511475856 = exactly 0.01 stake + 0.000512 gas. |
| B | Can a browser wallet sign a delegate? | **Yes.** Meteor Wallet has a native `sign_delegate_actions` endpoint: unlock + one Sign prompt → base64 `SignedDelegateAction`, the same format near-cli-rs prints. |

End-to-end runs (all `creator: paylink-payee.testnet`, status `OPEN`):

| Link | Signed by | Submitted by | Transaction |
| --- | --- | --- | --- |
| `spikea01` | near-cli-rs | near-cli-rs `send-meta-transaction`, signer `paylink-keeper.testnet` | [`HJML2cY2AfWb5Tcows4C3BmyEAGV3FigtQ8xXGrtLwTz`](https://testnet.nearblocks.io/transactions/HJML2cY2AfWb5Tcows4C3BmyEAGV3FigtQ8xXGrtLwTz) |
| `spikea02` | Meteor Wallet | near-cli-rs, signer `paylink-keeper.testnet` | [`B37vJV8ZfGK3yo8KAQDoqjkPdi3yipVBsNX3GhijTWNf`](https://testnet.nearblocks.io/transactions/B37vJV8ZfGK3yo8KAQDoqjkPdi3yipVBsNX3GhijTWNf) |
| `spikea03` | near-cli-rs | **this Worker's `submit()`** (Node harness), signer `paylink-relay.testnet` | [`26asviviWDe7EFprdWH6fgDhrJUoUjRhJwZYLkKzJQcm`](https://testnet.nearblocks.io/transactions/26asviviWDe7EFprdWH6fgDhrJUoUjRhJwZYLkKzJQcm) |
| `lnk-jhfmt56d` (3.25 USDC, 72 h) | Meteor Wallet | **the frontend → this Worker**, full browser flow | [`pYBw2vTh8B3ZDK7qwbDqre8x5c7iHqEzTLFVD68USYU`](https://testnet.nearblocks.io/transactions/pYBw2vTh8B3ZDK7qwbDqre8x5c7iHqEzTLFVD68USYU) |

Relayer account: `paylink-relay.testnet` (faucet-created, tx
[`3h4Q6j4kihHvXXvD5esEnAQdaEszGFnBu1A5Cmhhtz6Y`](https://testnet.nearblocks.io/transactions/3h4Q6j4kihHvXXvD5esEnAQdaEszGFnBu1A5Cmhhtz6Y),
10 NEAR, key `ed25519:9cUEYo57dCRy5UfNwKAFMZnHJkkFDYvUMizLniAxki7r`).
`paylink-relayer.testnet` is dead — created keyless by an interrupted run,
never usable, ignore it.

## The signature preimage (this was the hard part)

`sha256(borsh(DelegateAction))` — the obvious guess — **fails**; the chain
rejected verification of both fixtures against it. nearcore actually verifies
`SignedDelegateAction::verify()` over:

```
sha256( borsh(u32 discriminant) ++ borsh(DelegateAction) )
discriminant = 2^30 + 366 = 1073742190        # NEP-461, on-chain range + NEP number
```

Source: `core/primitives/src/signable_message.rs` (`MessageDiscriminant`,
`SignableMessage`) and `get_nep461_hash()` in
`core/primitives/src/action/delegate.rs`. The 4-byte prefix is little-endian
u32, then the `DelegateAction` bytes verbatim — no length prefix between them.
Proven: the preimage verifies both fixtures (near-cli-rs **and** Meteor), and
`test/parse.test.mjs` asserts it, so `submit()` rejects forged delegates
before spending relayer gas.

## Outer transaction layout (what the Worker builds)

- `Transaction` has **no gas field** — prepaid gas is derived from the actions
  (`Action::prepaid_gas`), so the Worker never sets one.
- `receiver_id` **must equal** `delegate_action.sender_id` (NEP-366 validation
  rule 3) — not the contract. The receipt routes to the payee first, then on
  to the contract with predecessor preserved.
- The single action is `Action::Delegate` = tag `8` followed by the raw
  `SignedDelegateAction` bytes, embedded **verbatim** (never re-encoded).
- Borsh `DelegateAction` = `sender_id, receiver_id, actions, nonce,
  max_block_height, public_key(0x00||32)`; `SignedDelegateAction` appends
  `signature(0x00||64)`; `Action::FunctionCall` = tag `2` +
  `method_name, args(Vec<u8>), gas(u64), deposit(u128)`.

## Failure modes seen and how they are handled

- **Transient RPC during `view_access_key`** was first mislabeled as
  `400 "…does not own …"` (the catch was too broad). A genuinely missing key
  answers `result.error = "access key … does not exist while viewing"`; that
  alone is a 400. Anything else (timeout, 429) is now a **503** so the client
  retries instead of blaming the signature. Observed live on the first frontend
  e2e attempt; the second attempt passed.
- **Balance floor**: below 1 NEAR the Worker answers 503 rather than spending
  its last NEAR on a link nobody can fund twice.
- **Rate limit**: 10 submissions per IP per hour, 429 beyond it.
- **Expired delegate** (`max_block_height` behind chain): 400 — caught
  pre-broadcast because a doomed delegate still burns relayer gas.
- The CLI's default testnet RPC (`rpc.testnet.near.org`) no longer resolves in
  DNS; `~/.near-credentials`-era config points at
  `archival-rpc.testnet.fastnear.com`, both fine. The Worker uses
  `https://test.rpc.fastnear.com`.

## What is deliberately NOT verified Worker-side

The relayer does not re-check on-chain state (link id unused, payee
registration) beyond the access-key/nonce/expiry checks — those two checks
exist because they fail *before* execution and still cost gas; a duplicate
link id fails *inside* `create_link` at the same gas cost as any other panic,
and the 400/429/503 bounds are best-effort rather than a hard cap: the
per-IP count is held in one isolate's memory (a second instance allows the
full quota, a restart clears it) and `ALLOWED_ORIGIN` does not bind
non-browser clients, so the balance floor — not the rate limit — is what
actually bounds worst-case drain.
