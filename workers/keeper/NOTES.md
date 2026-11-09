# Keeper — engineering notes

The boring summary is in [README.md](./README.md). This file is the "how and why it actually
works", written down so nobody (including us, in six months) has to re-derive it. It documents
the three genuinely hard pieces of this repo: the zero-registry claim keeper, the hand-rolled
NEAR transaction signing, and every RPC quirk and failure we hit along the way.

Contents:

1. [Design: why zero-registry](#1-design-why-zero-registry)
2. [Sweep: reading all links from contract state](#2-sweep-reading-all-links-from-contract-state)
3. [Signing: WebCrypto Ed25519, zero dependencies](#3-signing-webcrypto-ed25519-zero-dependencies)
4. [Transaction format ground truth](#4-transaction-format-ground-truth)
5. [RPC quirks (`rpc.testnet.near.org`)](#5-rpc-quirks-rpc-testnearnearorg)
6. [Timeouts, retries, and the abort that landed](#6-timeouts-retries-and-the-abort-that-landed)
7. [The nonce race (cron vs manual tick)](#7-the-nonce-race-cron-vs-manual-tick)
8. [Key custody](#8-key-custody)
9. [End-to-end proof log](#9-end-to-end-proof-log)
10. [Debug trail: symptom → root cause → fix](#10-debug-trail-symptom--root-cause--fix)

---

## 1. Design: why zero-registry

**Requirement:** every paid payment link on `paylink-v2.testnet` must end up `CLAIMED`
(payout moved to the payee + fee), without a human pressing anything, on $0 budget.

Alternatives considered:

| Option | Why rejected |
| --- | --- |
| Indexer / subgraph | Paid or self-hosted infra → violates $0. |
| KV registry of link ids | A second source of truth that can drift from chain state; needs a writer path in the frontend (a new failure mode and a frontend change we'd have to re-verify). |
| Contract-side auto-claim | Would mean redeploying `paylink-v2.testnet` and re-testing the whole payment flow late in the build. |

**Chosen: scan-and-claim, no memory at all.** The Worker cron runs every minute, does a
single `view_state` prefix read of key `"l"` on the contract account, borsh-decodes every
`Link`, and claims each one whose status is `PAID`. State on chain is the only registry.
Consequences we rely on:

- **The keeper can be wiped and redeployed from scratch with zero data migration.** There is
  nothing to restore.
- **Claiming is idempotent by contract:** `claim` panics unless the link is `PAID`. Re-scanning
  an already-`CLAIMED` link is a no-op (status filter), and a double-claim attempt is rejected
  on-chain. Worst case costs one failed call, never a double spend.
- A cron + a manual `POST /tick` can both run at once — see [§7](#7-the-nonce-race-cron-vs-manual-tick).

`GET /` is a liveness probe returning config booleans (never secret values) — it is how we
verify the wrangler vars took effect without opening the dashboard.

## 2. Sweep: reading all links from contract state

Contract stores links under the prefix `"l"` (borsh `String` key = `u32 len` + bytes, so the
scan range is `"l"` … `"m"`). One `view_state` call returns everything; the Worker decodes each
value in-process. No pagination, no retries beyond the policy in §6.

Caps and filters:

- **max 10 claims per sweep** — bounds per-tick gas/time; the next minute's cron picks up the
  rest. On testnet with a handful of links this has never been a bottleneck (10 links scanned
  per tick currently).
- Only `status === PAID` is actionable. `OPEN` (e.g. the deliberate fixture `demo-004`) and
  already-`CLAIMED` links are skipped.
- Decoding a malformed entry must never kill the sweep: a bad value is logged and skipped, the
  rest still process.

## 3. Signing: WebCrypto Ed25519, zero dependencies

The obvious implementation is `tweetnacl`, but the constraint "no dependencies" (single-file
Worker that can be **pasted into the Cloudflare dashboard** with no npm install, no build step)
meant we signed with the platform's own crypto instead.

- **Import the key once** via `crypto.subtle.importKey('pkcs8', ...)`. NEAR `ed25519:<b58>`
  secret keys are raw 32-byte seeds (a.k.a. RFC 8410 "raw private key"), which WebCrypto does
  **not** accept directly, so we wrap them in the fixed 16-byte PKCS#8/Ed25519 header
  (`302e020100300506032b657004220420`) + seed. The prefix is not magic: it encodes
  `SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING containing OCTET STRING }`
  — i.e. "Ed25519 private key" — and `22 04 20` is the inner OCTET STRING declaring 32 bytes.
- **Sign** over `SHA-256(borsh(tx))` using raw Ed25519 (`algorithm: {name:'Ed25519'}` +
  `hash: 'SHA-256'`). See [§4](#4-transaction-format-ground-truth) for why SHA-256 and not
  SHA-512 — this is the single biggest trap.
- **Verified bit-identical to tweetnacl** on a fixed message/signature vector before it ever
  touched the chain, then against six `parseSecretKey` paste shapes, then in `wrangler dev`
  (workerd) before deploy — because Cloudflare's runtime is not Node and we wanted the exact
  production environment proven first.
- `worker-crypto` (the usual workerd Ed25519 helper) was rejected as an unnecessary dependency;
  platform WebCrypto supports both `importKey` and `sign` for Ed25519 in workerd.

`parseSecretKey` is deliberately **tolerant** and exported for tests: it scans the raw pasted
value for the first `ed25519:<b58>` substring that decodes to exactly 64 bytes, so quoted
values, whole credential-JSON pastes, and `NEAR_WALLET_SECRET_KEY=...`-style labelled values
all work. Pasting a **public** key fails loudly:
`saw 32 … paste private_key, not public_key`.

## 4. Transaction format ground truth

Everything below is settled and production-proven (all 5 keeper txs landed):

- **Wire format is Transaction V0**: `str(signer_id)` + `[public_key_tag=0] + 32-byte pubkey`
  + `u64 nonce` + `str(receiver_id)` + `32-byte block hash (b58-decoded)` + `u32 action_count`
  + actions. Borsh: `str` = `u32 len + bytes`, `u64`/`u32`/`u128` little-endian.
- **Action is `FunctionCall` with discriminant `2`**, NOT 6 — 6 is a *KeyTag* / enum-position
  mistake that shows up as `unknown KeyTag: 5` (our bytes shifted by one) at the RPC.
  Then: `str(method)` + `u32(args_len) + args` + `u64 gas` + `u128 deposit`.
- **The signature is over `SHA-256(borsh(tx))`.** `nacl.sign` hashes with SHA-512 internally —
  if you feed it the SHA-256 digest *and* let it hash again you get a signature the network
  rejects. We hash once with SHA-256 and sign the digest raw.
- **Signed payload** = `[public_key_tag=0] + 32-byte pubkey + 64-byte signature` appended to the
  unsigned bytes; final tx is base64'd for `broadcast_tx_commit`.
- **`AccessKeyPermission` is FullAccess (`1`)** — the keeper uses a full-access key on its own
  account, so no access-key delegation plumbing.
- **Nonce** comes from `view_access_key` for (keeper account, pubkey) **+ 1** right before
  signing; a concurrently landed tx invalidates it (see §7).
- **Block hash** is the latest finality block from the RPC at sign time (never cached across
  sweeps — old hashes fail validation).

## 5. RPC quirks (`rpc.testnet.near.org`)

The dialect is standard nearcore `query`; these are the details that bite (row 1 re-verified
live 2026-11-05 when a plain top-level `view_state` probe answered `METHOD_NOT_FOUND` while
the keeper kept sweeping fine — the keeper always sent the standard shape):

| Call | Quirk | What works |
| --- | --- | --- |
| `view_state` / `view_access_key` | No top-level `view_state` method on this endpoint — it answers `METHOD_NOT_FOUND`. And `method: "query"` with the request fields **top-level** (not under `params`) is rejected HTTP 400 with `PARSE_ERROR: "JSON RPC Request format was expected"` — re-verified live 2026-11-05 | `method: "query"` with the fields nested under `params`: `{ request_type: "view_state", finality: "final", account_id, prefix_base64 }` |
| `view_state` result | Not a bare `values` array | `{ block_height, values: [{ key, value }] }` (array of **objects**) |
| `view_access_key` | Pubkey must NOT carry the `ed25519:` prefix | raw base58 pubkey string |
| `view_access_key` failures | No top-level `error` | embedded as `result.error` — must check or you read `nonce: undefined` |
| `broadcast_tx_commit` | Does not take an object | params is a **1-element array**: `[base64_tx]` |
| Errors generally | Can arrive HTTP 200 with an error payload | always inspect the body, never trust the status line |

## 6. Timeouts, retries, and the abort that landed

- **Views:** 12 s timeout + **one** retry (block-hash/nonce fetches). A second retry adds
  latency to a cron that runs every minute for little gain.
- **Broadcasts are never retried inside the tick.** A request that times out or aborts may
  still have reached the node — retrying could double-send. Instead we accept the ambiguity:
  **the next sweep settles it.** If the tx landed, the link is `CLAIMED` and is skipped; if it
  didn't, the link is still `PAID` and gets claimed next minute. `claim`'s PAID-check makes
  both outcomes safe.
- This is not theoretical — it is literally the `keeper-001` case (§9): the response aborted
  client-side but the tx had already landed, and the system self-healed on the next sweep.
- `BROADCAST_TIMEOUT_MS = 30000` for the same reason: long enough for a committed tx on
  testnet, and everything past it is the next sweep's job.

## 7. The nonce race (cron vs manual tick)

Cron fires every minute; a human can `POST /tick` at the same moment. Both read nonce *n*,
both sign *n+1*, one lands, the other gets **`InvalidNonce`**.

Why this is acceptable (and was proven live as `keeper-004`):

- The loser's tx is **rejected during validation — no gas is burned.** The observed gas drop
  after the race was exactly one claim's worth, not two.
- The failure is reported honestly in the tick response (not swallowed).
- The claim itself **cannot double-spend**: `claim` panics unless status is `PAID`, and the
  winner already flipped it to `CLAIMED`.
- On `InvalidNonce`, the loser does **not** loop-and-retry within the same tick; it just
  reports. The next sweep has a fresh nonce. (A retry loop here would re-create the race.)

## 8. Key custody

- Dedicated account **`paylink-keeper.testnet`** (created via the near-cli-rs faucet route:
  `account create-account sponsor-by-faucet-service … save-to-legacy-keychain`), funded with
  10 NEAR from the faucet. ~0.0008 NEAR gas per claim → thousands of claims of runway.
- The private key lives only as the Worker secret `KEEPER_KEY` (dashboard secret, never in
  git, never printed). Local test scripts read it from the legacy keychain at runtime.
- `.dev.vars` (wrangler dev's local secret file) is gitignored **and deleted after use** —
  it briefly held the key during workerd testing.
- `paylink.testnet`'s local key is stale — **never sign with it.** The keeper only ever signs
  as `paylink-keeper.testnet`.
- `TICK_SECRET` guards `POST /tick` (any other body → 403) so strangers can't drive manual
  sweeps; `GET /` is intentionally open as a liveness probe and returns no secrets.

## 9. End-to-end proof log

Every claim below moved real USDC (`payee +2.985`, `fees +0.015` per 3-USDC link; the
one-approval runs used 1-USDC links: `+0.995` / `+0.005`) plus a bit
of keeper gas. Newest first:

| Link | How | Result |
| --- | --- | --- |
| `rotchk02` | one-approval E2E after the auto-claim removal: payer signed **once**, no frontend claim, cron alone | PAID → CLAIMED ~60 s; payee `286565000 → 287560000` (+995000), fees `860000 → 865000` (+5000) — exact split |
| `rotchk01` | same run, pair of the above (payment tx `Fipq9K6N…`) | PAID → CLAIMED 38 s; +995000 / +5000 confirmed |
| `keeper-005` | **cron alone**, zero human intervention | PAID → CLAIMED ≤ 90 s |
| `keeper-004` | deployed worker, `POST /tick` with auth; cron raced it | claimed; loser reported `InvalidNonce`, burned no gas |
| `keeper-003` | local `wrangler dev` (workerd runtime) | tx `DwpshVcN…` |
| `keeper-002` | local Node harness (WebCrypto path) | tx `MAzNZw1s…` |
| `keeper-001` | first pipeline run; client aborted mid-broadcast | tx had landed anyway; next sweep confirmed CLAIMED |
| `demo-006` | earlier claim during tweetnacl era | tx `7c4NtfAm…` |

Endpoint checks: `GET /` → `"ok": true` with correct vars · wrong tick secret → `403` ·
`POST /tick` with the configured tick secret → claims reported. Balance spot-checks after the run: payee
`134825000` (134.825 USDC), fees `175000`, keeper `9.9960` NEAR.

## 10. Debug trail: symptom → root cause → fix

Ordered as we hit them. This is the section that saves the next person a day.

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `view_state` answers `METHOD_NOT_FOUND` (or `query` + top-level fields answers `PARSE_ERROR`) | non-standard RPC dialect — no top-level `view_state` method, and request fields must nest under `params` | standard `method: "query"` with `{ request_type: "view_state", finality: "final" }` **inside `params`** (production shape, re-verified 2026-11-05) |
| 2 | "account not found" | passed contract id where key/params didn't match | params `{ account_id: CONTRACT_ID, … }` |
| 3 | empty result | wrong prefix encoding | `prefix_base64` = base64 of `"l"` |
| 4 | decoded nothing | expected bare array | result is `{values: [{key, value}]}` |
| 5 | nonce read as `undefined` | errors embedded as `result.error` | check `result.error` explicitly; fail loud |
| 6 | key rejection on sign | `view_access_key` called with `ed25519:`-prefixed pubkey | strip prefix before the call |
| 7 | `unknown KeyTag: 5` | action enum written with discriminant 6 (off-by-position) | FunctionCall discriminant **2** |
| 8 | signature rejected (invalid tx) | signed the wrong digest / double-hashing via nacl internals | sign **SHA-256(borsh(tx))** once, raw Ed25519 |
| 9 | worker signs with wrong identity | stale `KEEPER_ACCOUNT` var | set `KEEPER_ACCOUNT=paylink-keeper.testnet`, redeploy |
| 10 | secret rejected / unparsable paste | key pasted as JSON / labelled / quoted | tolerant `parseSecretKey` (scan for `ed25519:` + 64-byte decode) |
| 11 | `InvalidNonce` under load | cron and manual tick both signed n+1 | accept: loser rejected at validation, no gas, next sweep settles (§7) |

---

Back to [README.md](../README.md) · track brief: [../tracks/08-realworld.md](../tracks/08-realworld.md)
