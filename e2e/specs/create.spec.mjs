/* Spec area 2 — payment-link creation interface.
 *
 * What this can honestly cover without a wallet: the form itself, its
 * client-side validation, and the fact that an unconnected submit refuses
 * BEFORE any signing prompt. What it deliberately does NOT do: sign or
 * send anything. The wallet-registry fetches are left unanswered in the
 * "connect first" test, so the connect prompt can never resolve and no
 * transaction can exist — wallet security is never bypassed, only
 * rendered around. On-chain creation itself stays a manual testnet
 * procedure (e2e/TESTNET.md). */

import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";

test.describe("create interface", () => {
  test("the form renders with the allowlisted token and its validation copy", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#create");

    await expect(page.locator("#panel-create")).toBeVisible();
    await expect(page.locator("#createForm")).toBeVisible();

    /* paid-in: the fixed allowlisted token, named exactly. */
    await expect(page.locator(".token-pill")).toContainText("USDC");
    await expect(page.locator(".token-pill .addr")).toHaveText("usdc.tidepool-sandbox.testnet");
    await expect(page.locator(".token-pill")).toContainText("allowlisted");

    /* paid-to: display-only, and empty until a wallet connects. */
    await expect(page.locator("#payToAddr")).toHaveText("connect a wallet");

    /* amount + expiry + note + submit, all present with their defaults. */
    await expect(page.locator("#amount")).toBeVisible();
    await expect(page.locator("#expires option")).toHaveCount(4);
    await expect(page.locator("#expires")).toHaveValue("72");
    await expect(page.locator("#description")).toHaveAttribute("maxlength", "200");
    await expect(page.locator("#createBtn")).toContainText("Create link");
    await expect(page.locator("#createResult")).toBeHidden();

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("an empty amount is refused before anything else happens", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#create");

    await page.locator("#createBtn").click();
    await expect(page.locator("#toast")).toHaveText("Enter an amount greater than zero");
    await expect(page.locator("#toast")).toHaveClass(/show/);
    await expect(page.locator("#createResult")).toBeHidden();

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a zero amount is refused the same way", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#create");

    await page.locator("#amount").fill("0");
    await page.locator("#createBtn").click();
    await expect(page.locator("#toast")).toHaveText("Enter an amount greater than zero");

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a valid amount without a wallet asks for a connection — and nothing is signed", async ({ page }) => {
    const scenario = makeScenario();
    /* Leave the wallet-registry fetch unanswered: the connect prompt can
       never resolve, so this test cannot possibly reach a signing step. */
    scenario.hangWalletManifest = true;
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#create");

    await page.locator("#amount").fill("12.5");
    await page.locator("#description").fill("E2E smoke — no transaction");
    await page.locator("#createBtn").click();

    await expect(page.locator("#toast")).toHaveText("Connect a wallet first");
    /* The form never moved on: no result line, no tx status, no signing. */
    await expect(page.locator("#createResult")).toBeHidden();
    await expect(page.locator("#payToAddr")).toHaveText("connect a wallet");

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});
