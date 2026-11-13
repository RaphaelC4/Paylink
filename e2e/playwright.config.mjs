/* Paylink Playwright configuration — the browser E2E layer (audit plan item:
   a deterministic PR smoke workflow plus a manually dispatched testnet layer).
 *
 * Design rules, all enforced below:
 *   - two projects: `smoke` (every external dependency mocked in-process —
 *     runs on PRs with no secrets) and `testnet` (read-only, live chain,
 *     matched ONLY from specs/testnet/, i.e. only via workflow_dispatch);
 *   - one static server for frontend/ (serve.mjs) — the repo has no bundler
 *     and none is invented here;
 *   - no retries: a flaky smoke test is a defect to fix, not to mask;
 *   - artifacts live under test-results/ (already gitignored) — videos are
 *     off by design so nothing recorded can ever carry more than the mocked
 *     traffic the tests themselves define.
 */

import { defineConfig } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/* Browser selection, so no contributor has to download a 200 MB browser
 * they already have:
 *   - PW_CHANNEL set           → honoured verbatim (e.g. "chromium");
 *   - Windows (local runs)     → the pre-installed Microsoft Edge — same
 *     Blink engine as Chromium, zero download, and this machine's data plan
 *     stays intact;
 *   - everything else (CI)     → Playwright's own Chromium, installed by
 *     e2e-smoke.yml via `playwright install --with-deps chromium`.
 * Set PW_CHANNEL=chromium to force Playwright's build on Windows too. */
const channel =
  process.env.PW_CHANNEL || (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
  testDir: "./specs",
  outputDir: "test-results/artifacts",

  /* One worker: the suite is seconds long and serial execution keeps the
     deterministic fixture timeline (status flips, clock fast-forward)
     trivial to reason about. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,

  timeout: 45_000,
  expect: { timeout: 8_000 },

  reporter: process.env.CI
    ? [
        ["list"],
        /* HTML report goes inside test-results/ so the existing .gitignore
           (test-results/) covers it — no ignore-file edits needed. */
        ["html", { outputFolder: "test-results/html", open: "never" }],
      ]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    ...(channel ? { channel } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      /* The PR smoke suite: mocked RPC, FX, wallet-registry manifest and
         every Worker endpoint. specs/testnet/ is excluded — it needs the
         live chain and is dispatched by hand. */
      name: "smoke",
      testIgnore: /testnet[\\/]/,
    },
    {
      /* Read-only live-testnet checks. Never triggered by CI events; the
         e2e-testnet workflow dispatches it with an explicit acknowledgement
         (see .github/workflows/e2e-testnet.yml and e2e/TESTNET.md). Real
         public JSON-RPC can be slow, hence the longer budgets. */
      name: "testnet",
      testMatch: /testnet[\\/]/,
      timeout: 180_000,
      use: {
        navigationTimeout: 60_000,
        actionTimeout: 30_000,
      },
    },
  ],

  webServer: {
    command: "node serve.mjs",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
    timeout: 15_000,
  },
});
