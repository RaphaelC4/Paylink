/* Spec area 6 — mobile viewport layout.
 *
 * Below 560px the page swaps its desktop chrome for the floating tab bar:
 * the header tablist hides, the pill bar appears, and every screen must fit
 * the viewport horizontally with no sideways scrolling. Two widths are
 * checked (a common phone and a small one), plus the pay card on a phone. */

import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";

async function noHorizontalOverflow(page) {
  const fits = await page.evaluate(() => {
    const de = document.documentElement;
    return {
      scrollW: de.scrollWidth,
      clientW: de.clientWidth,
      innerW: window.innerWidth,
    };
  });
  expect(fits.scrollW, `scrollWidth ${fits.scrollW} must fit the viewport`).toBeLessThanOrEqual(fits.innerW);
}

test.describe("mobile viewport 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test("header tabs give way to the floating tab bar; panels switch by tap", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1");

    await expect(page.locator(".tabbar")).toBeVisible();
    await expect(page.locator("#navLinks")).toBeHidden();
    await expect(page.locator("#tbFaucet")).toBeVisible();
    await noHorizontalOverflow(page);

    await page.locator("#btab-create").tap();
    await expect(page.locator("#panel-create")).toBeVisible();
    await expect(page.locator("#panel-home")).toBeHidden();
    await expect(page).toHaveURL(/#create$/);
    await noHorizontalOverflow(page);

    await page.locator("#btab-ledger").tap();
    await expect(page.locator("#panel-ledger")).toBeVisible();
    await noHorizontalOverflow(page);

    await page.locator("#btab-home").tap();
    await expect(page.locator("#panel-home")).toBeVisible();
    await noHorizontalOverflow(page);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the pay card fits the phone: actions reachable, nothing spills sideways", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-open-1");

    await expect(page.locator("#payCard .pill.open")).toContainText("OPEN");
    await expect(page.locator("#payActions [data-wallet='connect']")).toBeVisible();
    await expect(page.locator(".timeline .tl-step.now .tl-label")).toHaveText("Open");
    await noHorizontalOverflow(page);

    /* The card itself must not scroll horizontally either. */
    const card = await page.locator("#payCard").evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    expect(card.scrollW).toBeLessThanOrEqual(card.clientW + 1);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe("mobile viewport 360×740 (small phone)", () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test("home and create fit with no sideways scroll", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1");

    await expect(page.locator(".tabbar")).toBeVisible();
    await noHorizontalOverflow(page);

    await page.locator("#btab-create").tap();
    await expect(page.locator("#panel-create")).toBeVisible();
    await expect(page.locator("#amount")).toBeVisible();
    await noHorizontalOverflow(page);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});
