# Paylink E2E layer

Browser end-to-end tests for the committed `frontend/` — two deliberately
separate halves:

| Layer | Project | Trigger | Network |
|---|---|---|---|
| **PR smoke** | `smoke` | every PR to `master`/`staging`, every push to `staging` (`.github/workflows/e2e-smoke.yml`) | **fully mocked in-process** — no egress beyond `127.0.0.1` |
| **Testnet** | `testnet` | **only** by a human dispatching `.github/workflows/e2e-testnet.yml` (never automatic) | live, **read-only** NEAR testnet view calls |

The existing suites (`frontend/test/*.mjs`, `workers/*/test`, contract tests)
are untouched and still run exactly as before in `ci.yml`.

## Run locally

```powershell
cd e2e
npm install --no-audit --no-fund      # pinned @playwright/test only
npx playwright install chromium        # one-time browser download
npx playwright test --project=smoke    # the deterministic PR layer
```

Useful variations:

```powershell
npx playwright test --project=smoke --grep "receipt"   # one area
npx playwright test --project=smoke --headed           # watch it
npx playwright test --project=smoke --debug            # step through
```

The config starts a tiny dependency-free static server (`serve.mjs`) for
`frontend/` on `127.0.0.1:4173` — no bundler, no build step, same files the
site ships.

## What the smoke suite covers (six areas)

1. **`specs/homepage.spec.mjs`** — app boots from static files, hero/tabs/
   footer render, the mocked chain health check lights the net-dots green,
   tab navigation drives the hash. Asserts **zero console errors** and
   **zero off-allowlist requests**.
2. **`specs/create.spec.mjs`** — the creation form: token pill, expiry
   defaults, note limit, and validation (empty amount, zero amount, and
   "Connect a wallet first" for a valid amount with no wallet — with the
   wallet-registry fetch left unanswered so no signing step can exist).
3. **`specs/pay.spec.mjs`** — invoice rendering for **OPEN / PAID /
   CLAIMED / EXPIRED** (expiry derived from the device clock, like the app
   does it), the itemised line-item note, FX line, timeline, fee copy and
   the absence of a receipt for payments this session never watched land.
4. **`specs/errors.spec.mjs`** — *No such link*, *Could not read the chain*
   (dead endpoint, then the page's own **Try again** recovering), a
   chain-answered JSON-RPC error proving **exactly one** read request (no
   retry storm), and *Unsupported token*.
5. **`specs/receipt.spec.mjs`** — the NEAR receipt appearing only after an
   in-session OPEN→CLAIMED landing (Playwright's fake clock advances the
   app's own 30 s status interval — nothing is signed to get there), and
   the Tidepool cross-chain receipt **only at VERIFIED**; a resumed
   `SETTLED` journey must show *awaiting verification*, no receipt, no
   success sentence, and gated pay buttons. Both PDFs are downloaded and
   byte-checked (`%PDF` header, receipt sentence, ids, fixture hashes).
6. **`specs/mobile.spec.mjs`** — 390×844 and 360×740: floating tab bar
   replaces the header nav, tap-driven panel switching, and no horizontal
   overflow on home, create or the pay card.

## How the mocks work (`fixtures/mocks.mjs`)

One catch-all `page.route` per test dispatches by host:

- `127.0.0.1` → continue (the app under test);
- chain RPC (`test.rpc.fastnear.com`), FX (`open.er-api.com`), the wallet
  registry (`raw.githubusercontent.com`, `cdn.jsdelivr.net`), all four
  Workers (parse / relayer / tidepool) and the faucet origin → canned
  fixtures from `fixtures/links.mjs`, fulfilled in-process;
- **anything else** → recorded in `scenario.unexpected` **and aborted**;
  specs assert that list stays empty.

Failure modes are scenario flags (`rpcDown`, `getLinkError`,
`hangWalletManifest`) so error-state tests flip mid-flight and recover —
deterministically, still with no egress.

## Safety rules encoded here (plan items 4–7)

- **Wallet security is never bypassed.** No spec connects a wallet or
  reaches a signing prompt; the one test that would open a connect flow
  leaves the registry fetch unanswered so it *cannot* resolve. Real wallet
  approvals are human steps in `TESTNET.md`.
- **Tidepool success = VERIFIED only.** Asserted in both directions
  (receipt at VERIFIED, no receipt + gated buttons at SETTLED).
- **No cross-provider double-payment or reverse-order race tests** —
  nothing here issues a second funding path; those logic paths are covered
  by mocked Worker suites (`workers/tidepool/test/`).
- **No secrets exist to leak.** The suite reads no repository secrets,
  prints none, and every request it records is a fixture URL it wrote
  itself. Artifacts (report/traces/screenshots under `e2e/test-results/`,
  already gitignored) contain only that mocked traffic.

## Manual setup needed

- **Nothing for the smoke layer** — `npm install` + `npx playwright
  install chromium` is all (CI does the same).
- **For the live testnet layer**: a dedicated testnet-only wallet, faucet
  funds, and the dispatch acknowledgement — full runbook in
  [`TESTNET.md`](./TESTNET.md).

## Known limitations (honest list)

- **No on-chain creation, payment or claim is automated** — by design.
  Those are human, one-approval-at-a-time steps in `TESTNET.md`; faking
  them here would fake a payment.
- The create test stops at the wallet boundary (validation + connect
  guard); the byte-limit note check and the ledger/export/ready-share
  flows are covered by the existing plain-Node suites, not by the browser.
- One config, Chromium only; no cross-browser matrix.
- The testnet project's live checks depend on public testnet RPC
  availability — a rate-limit or outage fails that dispatch honestly
  rather than being mocked away.
