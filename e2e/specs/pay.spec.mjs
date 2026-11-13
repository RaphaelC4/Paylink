/* Spec area 3 — invoice / payment page rendering.
 *
 * Every status the contract can be in renders from a fixture get_link:
 * OPEN, PAID, CLAIMED and the device-clock-derived EXPIRED. The card must
 * show the invoice's own facts (payer-facing copy, timeline, fees) and must
 * NOT show a receipt for a payment this session never watched land — that
 * gate (celebrated && landed) is receipt.spec.mjs's territory. */

import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";

async function openPay(page, scenario, id) {
  await installMocks(page, scenario);
  await page.goto(`/?flat=1#pay/${id}`);
}

test.describe("invoice / payment page rendering", () => {
  test("OPEN: amount, timeline, connect-to-pay action and the funding rail", async ({ page }) => {
    const scenario = makeScenario();
    await openPay(page, scenario, "e2e-open-1");

    await expect(page.locator("#payCard .pill.open")).toContainText("OPEN");
    await expect(page.locator(".pay-who strong")).toHaveText("e2e-payee.testnet");
    await expect(page.locator(".pay-who")).toContainText("requests 5 USDC");
    await expect(page.locator(".pay-token")).toContainText("5 USDC");
    await expect(page.locator(".pay-token")).toContainText("on NEAR testnet");

    /* Indicative naira line: the FX fixture answers the fetch. */
    await expect(page.locator("#payNgn")).toBeVisible();
    await expect(page.locator("#payNgn")).toContainText("indicative FX");
    await expect(page.locator("#payNgn")).toContainText("₦");

    await expect(page.locator(".timeline .tl-step.now .tl-label")).toHaveText("Open");
    await expect(page.locator(".timeline .tl-step.done")).toHaveCount(0);

    /* No wallet → the payer action is the connect button, never a Pay. */
    await expect(page.locator("#payActions [data-wallet='connect']")).toContainText("Connect a wallet to pay");
    await expect(page.locator("#payActions [data-pay]")).toHaveCount(0);

    /* Funding rail (faucet + swap tools) and the cross-chain toggle. */
    await expect(page.locator("#fundRail summary")).toContainText("free faucet");
    await expect(page.locator("#fundRail [data-fund-bal]")).toHaveText("connect a wallet");
    await expect(page.locator("[data-tp-toggle]")).toContainText("Pay from another chain");

    /* Technical details carry the invoice id (opened so it is asserted). */
    await page.locator("#payCard > details.tech:not(#fundRail) summary").click();
    await expect(page.locator("#payCard > details.tech:not(#fundRail)")).toContainText("e2e-open-1");
    await expect(page.locator("#payCard > details.tech:not(#fundRail)")).toContainText("paylink-v2.testnet");

    /* Not celebrated → no receipt block. */
    await expect(page.locator(".pay-receipt")).toHaveCount(0);

    expect(scenario.unexpected).toEqual([]);
  });

  test("PAID: claimed-pending state, Release fallback, and no receipt yet", async ({ page }) => {
    const scenario = makeScenario();
    await openPay(page, scenario, "e2e-paid-1");

    await expect(page.locator("#payCard .pill.paid")).toContainText("PAID");
    await expect(page.locator(".timeline .tl-step.now .tl-label")).toHaveText("Paid");
    await expect(page.locator(".timeline .tl-step.done")).toHaveCount(1);

    /* The keeper owns settlement; the button is the manual fallback and the
       copy says so. 0.5% fee: 5 USDC → 4.975 USDC released. */
    await expect(page.locator("#payActions [data-claim]")).toContainText("Release 4.975 USDC");
    await expect(page.locator("#payActions")).toContainText("released automatically by the keeper");

    /* Payer-side funding tools disappear once the invoice is paid. */
    await expect(page.locator("#fundRail")).toHaveCount(0);

    /* Landed but never watched landing by this session: no receipt. */
    await expect(page.locator(".pay-receipt")).toHaveCount(0);
    await expect(page.locator("[data-receipt-pdf]")).toHaveCount(0);
  });

  test("CLAIMED: settled copy and full timeline, still without a receipt", async ({ page }) => {
    const scenario = makeScenario();
    await openPay(page, scenario, "e2e-claimed-1");

    await expect(page.locator("#payCard .pill.claimed")).toContainText("CLAIMED");
    await expect(page.locator(".timeline .tl-step.now .tl-label")).toHaveText("Claimed");
    await expect(page.locator(".timeline .tl-step.done")).toHaveCount(2);

    await expect(page.locator("#payActions")).toContainText("Settled in full.");
    await expect(page.locator("#payActions")).toContainText("released to the payee");

    /* No in-session payment event → no receipt block. */
    await expect(page.locator(".pay-receipt")).toHaveCount(0);
  });

  test("EXPIRED is derived from the device clock: warm timeline, no pay action", async ({ page }) => {
    const scenario = makeScenario();
    await openPay(page, scenario, "e2e-expired-1");

    await expect(page.locator("#payCard .pill.expired")).toContainText("EXPIRED");
    await expect(page.locator(".timeline .tl-step.now.warm .tl-label")).toContainText("Expired");

    await expect(page.locator("#payActions")).toContainText("This link expired. The contract refuses payment on an expired link.");
    await expect(page.locator("#payActions [data-pay]")).toHaveCount(0);
    await expect(page.locator("#payActions [data-claim]")).toHaveCount(0);
    await expect(page.locator("#payActions [data-wallet='connect']")).toHaveCount(0);
    await expect(page.locator("#fundRail")).toHaveCount(0);
  });

  test("an itemised note renders as priced line items", async ({ page }) => {
    const scenario = makeScenario();
    await openPay(page, scenario, "e2e-items-1");

    await expect(page.locator("#payCard .pi-row")).toHaveCount(2);
    await expect(page.locator("#payCard .pi-l").nth(0)).toHaveText("Logo");
    await expect(page.locator("#payCard .pi-p").nth(0)).toHaveText("3 USDC");
    await expect(page.locator("#payCard .pi-l").nth(1)).toHaveText("Banner");
    await expect(page.locator("#payCard .pi-p").nth(1)).toHaveText("2 USDC");
    /* The itemised list replaces the plain "for …" line. */
    await expect(page.locator("#payCard .pay-desc")).toHaveCount(0);
  });
});
