/* @testnet — READ-ONLY live-chain checks. This file is excluded from the
 * `smoke` project and matched only by the `testnet` project, which nothing
 * in CI triggers: .github/workflows/e2e-testnet.yml runs it solely through
 * workflow_dispatch with an explicit acknowledgement (see e2e/TESTNET.md).
 *
 * Rules this spec obeys, by construction:
 *   - NO mocks: the committed frontend talks to public NEAR testnet JSON-RPC
 *     view calls (`status`, `get_link`) — reads only, nothing is signed;
 *   - NO wallet is ever connected and no button that leads to a signing
 *     prompt is clicked; wallet approvals stay human, in a dedicated
 *     testnet-only wallet (e2e/TESTNET.md);
 *   - NO repository secrets are read; nothing here could print one;
 *   - success is asserted on UI state only. For Tidepool journeys the only
 *     success is VERIFIED — this file never claims a payment succeeded.
 */

import { test, expect } from "@playwright/test";

test.describe("testnet read-only", () => {
  test("the page's health check answers from the live testnet RPC", async ({ page }) => {
    await page.goto("/?flat=1");
    await expect(page.locator(".net-chip")).toContainText("testnet");
    /* loadNetwork()'s `status` call reached the real endpoint and answered:
       both net-dots turn green. A rate-limit or outage fails here honestly. */
    await expect(page.locator(".js-netdot.ok").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#panel-home h1")).toContainText("Send a link.");
  });

  test("a real invoice renders from live contract state", async ({ page }, testInfo) => {
    const linkId = process.env.TESTNET_LINK_ID || "";
    test.skip(
      !linkId,
      "no link_id supplied (workflow input) — set TESTNET_LINK_ID to render a real invoice read-only"
    );

    await page.goto(`/?flat=1#pay/${encodeURIComponent(linkId)}`);

    /* The card leaves its skeleton and shows the on-chain status pill —
       which only happens for an invoice the contract actually returned. */
    await expect(page.locator("#payCard .pill")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#payCard .pay-token")).toContainText("on NEAR testnet");
    await expect(page.locator("#payCard h2")).toHaveCount(0); // no error state

    /* The id is echoed back in Technical details — the rendered invoice is
       the one that was asked for, not a redirect or a fallback. */
    await page.locator("#payCard > details.tech:not(#fundRail) summary").click();
    await expect(page.locator("#payCard > details.tech:not(#fundRail)")).toContainText(linkId);
  });
});
