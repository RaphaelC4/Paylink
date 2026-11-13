/* Spec area 4 — validation and error states.
 *
 * The three ways the pay page can fail to show an invoice, all rendered
 * against fixtures: an id that does not exist, an endpoint that will not
 * answer (with the UI's own Try again recovering it), and an invoice
 * denominated in a token this deployment refuses. Plus the read-retry
 * contract: a JSON-RPC error means the chain ANSWERED, so exactly one
 * request is allowed — never a retry storm. */

import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";

test.describe("validation and error states", () => {
  test("an unknown invoice id renders the No such link state", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-missing-000");

    await expect(page.locator("#payCard h2")).toHaveText("No such link");
    await expect(page.locator("#payCard .sub")).toHaveText("Nothing on chain with id e2e-missing-000.");
    /* Retrying cannot conjure an id that never existed: the app offers no
       Try again here (it does for a read failure — asserted below). */
    await expect(page.locator("[data-retry-pay]")).toHaveCount(0);
    await expect(page.locator(".pay-amount")).toHaveCount(0);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a dead endpoint renders Could not read the chain, and Try again recovers", async ({ page }) => {
    const scenario = makeScenario({ rpcDown: true });
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-open-1");

    await expect(page.locator("#payCard h2")).toHaveText("Could not read the chain");
    await expect(page.locator("[data-retry-pay]")).toBeVisible();
    /* loadNetwork()'s health check failed the same way: red dot. */
    await expect(page.locator(".js-netdot.err").first()).toBeVisible();

    /* Endpoint comes back — the page's own retry affordance must work. */
    scenario.rpcDown = false;
    await page.locator("[data-retry-pay]").click();
    await expect(page.locator("#payCard .pill.open")).toContainText("OPEN");
    await expect(page.locator("#payCard h2")).toHaveCount(0);

    /* The deliberate 500s above are browser "Failed to load resource"
       console noise from the mock itself — expected, not page bugs. */
    expect(scenario.unexpected).toEqual([]);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });

  test("a chain-answered error surfaces as a read failure with exactly one request", async ({ page }) => {
    const scenario = makeScenario({
      getLinkError: "view get_link failed: ERR_BAD_STATE (fixture)",
    });
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-open-1");

    await expect(page.locator("#payCard h2")).toHaveText("Could not read the chain");
    /* friendly() passes the chain's own words through untouched. */
    await expect(page.locator("#payCard .sub")).toContainText("view get_link failed: ERR_BAD_STATE (fixture)");

    /* The chain answered: rpc() must not retry a JSON-RPC error — one
       get_link request, full stop (read-only retry applies to 5xx/dead
       transport only; asserted in frontend/test/rpc-retry.test.mjs too). */
    const getCalls = scenario.rpcLog.filter((e) => e.method === "query" && e.name === "get_link");
    expect(getCalls).toHaveLength(1);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("an invoice in a token this deployment refuses renders Unsupported token", async ({ page }) => {
    const scenario = makeScenario();
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-wrong-token-1");

    await expect(page.locator("#payCard h2")).toHaveText("Unsupported token");
    await expect(page.locator("#payCard .sub")).toContainText("usdt.tether.testnet");
    await expect(page.locator("#payCard .sub")).toContainText("this deployment does not accept");
    /* Refused before anything renders: no amount, no actions. */
    await expect(page.locator(".pay-amount")).toHaveCount(0);
    await expect(page.locator("#payActions")).toHaveCount(0);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});
