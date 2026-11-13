/* Spec area 5 — receipt rendering.
 *
 * Two honest receipt surfaces, each with its own gate:
 *
 *  1. NEAR receipt — only when THIS session watched the payment land
 *     (celebrated && landed). The test flips the fixture from OPEN to
 *     CLAIMED while the page watches and advances Playwright's clock past
 *     the app's own 30-second status interval, exactly like time passing.
 *     Nothing is signed to get here: the landing is a fixture transition.
 *
 *  2. Cross-chain (Tidepool) receipt — only at status VERIFIED. A resumed
 *     journey in SETTLED ("converted — awaiting verification", a provider
 *     claim) must NOT show a receipt, must NOT say the shared sentence and
 *     must keep the NEAR pay buttons gated. VERIFIED is the only success.
 *
 * Both PDFs are downloaded and byte-checked (the receipt module is ASCII
 * by design, so the sentence and ids appear literally in the file). */

import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { makeScenario, installMocks } from "../fixtures/mocks.mjs";
import {
  link,
  TP_JOURNEY,
  tpStatusBody,
  TX_PAYMENT_HASH,
  TX_RELEASE_HASH,
} from "../fixtures/links.mjs";

const RECEIPT_SENTENCE = "Payment delivered and verified on NEAR";

function seedTxs(page, id) {
  return page.addInitScript(
    ([key, row]) => localStorage.setItem(key, row),
    ["paylink:txReceipt:v1", JSON.stringify({ [id]: { payment: TX_PAYMENT_HASH, release: TX_RELEASE_HASH } })]
  );
}

function seedJourney(page) {
  return page.addInitScript((j) => sessionStorage.setItem("paylink:tp-journey:v1", JSON.stringify(j)), {
    ...TP_JOURNEY,
    at: Date.now(),
  });
}

async function downloadPdf(page, selector) {
  const got = page.waitForEvent("download");
  await page.locator(selector).click();
  const download = await got;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const file = await download.path();
  return readFileSync(file, "utf8"); // PDF is ASCII-only by construction
}

test.describe("receipt rendering", () => {
  test("NEAR: receipt appears only after the payment lands in-session, and the PDF downloads", async ({ page }) => {
    const id = "e2e-receipt-1";
    const scenario = makeScenario();
    await seedTxs(page, id);
    /* Frozen clock: the app's 30s status interval fires only when we say so. */
    await page.clock.install({ time: Date.now() });
    const { errors } = await installMocks(page, scenario);
    await page.goto(`/?flat=1#pay/${id}`);

    await expect(page.locator("#payCard .pill.open")).toContainText("OPEN");
    await expect(page.locator(".pay-receipt")).toHaveCount(0);

    /* The invoice moves OPEN → CLAIMED while the page watches: the interval
       (advanced past) flips it, sets celebrated, and re-renders. */
    scenario.links[id] = link({
      link_id: id,
      status: "CLAIMED",
      paid_by: "e2e-payer.testnet",
      paid_amount: "5000000",
      paid_at: Date.now() - 60_000,
      claimed_at: Date.now() - 1_000,
    });
    await page.clock.fastForward(31_000);

    /* The status pill (title marks it) — the receipt also carries a
       .pill.claimed of its own, so scope to the invoice status. */
    await expect(page.locator('#payCard .pill[title="invoice status on chain"]')).toContainText("CLAIMED");
    const receipt = page.locator(".pay-receipt");
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText(RECEIPT_SENTENCE);
    await expect(receipt).toContainText("Released to the payee");
    await expect(receipt).toContainText("5 USDC");
    await expect(receipt).toContainText(id);
    /* The wallet-returned hashes this device recorded: the card shows them
       truncated (title= carries the full value), the PDF prints them whole. */
    await expect(receipt.locator('a[title="' + TX_PAYMENT_HASH + '"]')).toHaveCount(1);
    await expect(receipt.locator('a[title="' + TX_RELEASE_HASH + '"]')).toHaveCount(1);

    const pdf = await downloadPdf(page, '[data-receipt-pdf="near"]');
    await expect(page.locator("#toast")).toHaveText("Receipt downloaded");
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect(pdf).toContain(RECEIPT_SENTENCE);
    expect(pdf).toContain(id);
    expect(pdf).toContain(TX_PAYMENT_HASH);
    expect(pdf).toContain(TX_RELEASE_HASH);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Tidepool: the cross-chain receipt renders at VERIFIED and the PDF downloads", async ({ page }) => {
    const scenario = makeScenario({ tpStatusBody: tpStatusBody("VERIFIED") });
    await seedJourney(page);
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-tp-1");

    /* onVerified fires once when the resumed journey answers VERIFIED. */
    await expect(page.locator("#toast")).toContainText("Cross-chain payment verified");

    const receipt = page.locator("#tpWrap .pay-receipt, #tpWrap [data-receipt-pdf='cross']").first();
    await expect(receipt).toBeVisible();
    await expect(page.locator("#tpWrap")).toContainText(RECEIPT_SENTENCE);
    await expect(page.locator("#tpWrap")).toContainText("e2e-tp-1");
    await expect(page.locator("#tpWrap [data-receipt-pdf='cross']")).toBeVisible();

    /* VERIFIED gate: never offer another payment — no NEAR Pay, no connect
       to pay, and the payer's funding rail is gone with them. */
    await expect(page.locator("#payActions")).toContainText("Nothing more to pay for this invoice.");
    await expect(page.locator("#payActions [data-pay]")).toHaveCount(0);
    await expect(page.locator("#payActions [data-wallet='connect']")).toHaveCount(0);
    await expect(page.locator("#fundRail")).toHaveCount(0);

    const pdf = await downloadPdf(page, '[data-receipt-pdf="cross"]');
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect(pdf).toContain(RECEIPT_SENTENCE);
    expect(pdf).toContain("e2e-tp-1");
    expect(pdf).toContain("pi_0123456789abcdef"); // payment reference row

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Tidepool: SETTLED is not success — no receipt, no sentence, pay buttons stay gated", async ({ page }) => {
    const scenario = makeScenario({ tpStatusBody: tpStatusBody("SETTLED") });
    await seedJourney(page);
    const { errors } = await installMocks(page, scenario);
    await page.goto("/?flat=1#pay/e2e-tp-1");

    /* Provider claim pending: the pending state, explicitly not a pass. */
    await expect(page.locator("#tpWrap")).toContainText("awaiting verification");
    await expect(page.locator("#tpWrap .pay-receipt")).toHaveCount(0);
    await expect(page.locator("[data-receipt-pdf]")).toHaveCount(0);
    await expect(page.locator("#tpWrap")).not.toContainText(RECEIPT_SENTENCE);
    await expect(page.locator("#toast")).not.toContainText("Cross-chain payment verified");

    /* An unresolved attempt blocks the NEAR buttons too — one invoice,
       never two live payment paths. */
    await expect(page.locator("#payActions")).toContainText("in progress");
    await expect(page.locator("#payActions [data-pay]")).toHaveCount(0);
    await expect(page.locator("#payActions [data-wallet='connect']")).toHaveCount(0);

    expect(scenario.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
});
