/* Spec area 1 — homepage / app loading.
 *
 * The committed static page must boot from files alone, with every external
 * dependency answered by the mock layer: no wallet, no chain, no third
 * party. Zero console errors and zero off-allowlist requests are part of
 * the assertion, not an accident. */

import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";

test.describe("homepage / app loading", () => {
  test("boots, paints the hero, and reports a healthy chain from the mocked RPC", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);

    await page.goto("/?flat=1");

    await expect(page).toHaveTitle("Paylink — Send a link. Get paid.");
    const h1 = page.locator("#panel-home h1");
    await expect(h1).toContainText("Send a link.");
    await expect(h1).toContainText("Get paid.");
    await expect(page.locator("#panel-home .lede")).toContainText("pay with the tokens already in their wallet");
    await expect(page.locator("#panel-home .hero-steps li")).toHaveCount(3);

    /* The three section tabs are present and Home is current. */
    await expect(page.locator("#tab-home")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#tab-create")).toBeVisible();
    await expect(page.locator("#tab-ledger")).toBeVisible();

    /* Network chip + loadNetwork()'s health check: the mocked `status`
       call answers, so both net-dots must light up green. */
    await expect(page.locator(".net-chip")).toContainText("testnet");
    await expect(page.locator(".js-netdot.ok").first()).toBeVisible();

    /* No wallet connected: the header says so, exactly. */
    await expect(page.locator("#walletLabel")).toHaveText("No wallet");

    await expect(page.locator(".site-footer")).toContainText("test tokens only");

    expect(scenario.unexpected, "the page must not reach beyond the mocked allowlist").toEqual([]);
    expect(errors, "boot must produce no console errors").toEqual([]);
  });

  test("section tabs swap panels and drive the hash", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1");

    await page.locator("#tab-create").click();
    await expect(page.locator("#panel-create")).toBeVisible();
    await expect(page.locator("#panel-home")).toBeHidden();
    await expect(page).toHaveURL(/#create$/);

    await page.locator("#tab-ledger").click();
    await expect(page.locator("#panel-ledger")).toBeVisible();
    await expect(page.locator("#panel-create")).toBeHidden();
    await expect(page).toHaveURL(/#ledger$/);

    await page.locator("#tab-home").click();
    await expect(page.locator("#panel-home")).toBeVisible();

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});
