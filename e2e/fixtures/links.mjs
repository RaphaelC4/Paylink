/* Fixture data for the E2E layer — pure data, no network, no keys.
 *
 * Invoice shapes mirror exactly what contracts/paylink-contract returns from
 * get_link (the fields app.js reads: link_id, creator, description, amount,
 * token, status, created_at/expires_at, paid_by/paid_amount/paid_at,
 * claimed_at). Timestamps are computed relative to load time so that
 * statusOf()'s device-clock derivation (OPEN → EXPIRED) behaves the same
 * way here as it does for a human opening the page.
 *
 * Amounts are NEP-141 base units with 6 decimals (USDC): 5000000 = 5 USDC.
 */

const HOUR = 3_600_000;
const NOW = Date.now();

export const TOKEN = "usdc.tidepool-sandbox.testnet";
export const CONTRACT = "paylink-v2.testnet";
export const PAYEE = "e2e-payee.testnet";
export const PAYER = "e2e-payer.testnet";

/** Base invoice; every variant is a fresh object (tests may mutate theirs). */
export function link(over = {}) {
  return {
    link_id: "e2e-open-1",
    creator: PAYEE,
    description: "E2E smoke — logo work",
    amount: "5000000",
    token: TOKEN,
    status: "OPEN",
    created_at: NOW - HOUR,
    expires_at: NOW + 72 * HOUR,
    paid_by: null,
    paid_amount: null,
    paid_at: null,
    claimed_at: null,
    ...over,
  };
}

export const OPEN_LINK = link();
export const PAID_LINK = link({
  status: "PAID",
  paid_by: PAYER,
  paid_amount: "5000000",
  paid_at: NOW - 60_000,
});
export const CLAIMED_LINK = link({
  status: "CLAIMED",
  paid_by: PAYER,
  paid_amount: "5000000",
  paid_at: NOW - 90_000,
  claimed_at: NOW - 30_000,
});
/* status stays OPEN — statusOf() derives EXPIRED from the device clock. */
export const EXPIRED_LINK = link({ expires_at: NOW - HOUR });
/* The token allowlist guard: renderPay refuses anything but CONFIG.tokenId. */
export const WRONG_TOKEN_LINK = link({ token: "usdt.tether.testnet" });
/* Note that itemises into line items: 3 + 2 = 5 USDC exactly. */
export const ITEMS_LINK = link({
  link_id: "e2e-items-1",
  description: "Logo — 3; Banner — 2",
});

/** Fresh id → invoice map for a scenario (tests mutate their own copy).
 *  Every entry's link_id MUST equal its map key: the app compares the
 *  returned link_id against the requested id (and the Tidepool rail against
 *  the stored journey's linkId), so a mismatched id is a different invoice
 *  as far as the frontend is concerned. */
export function makeLinks() {
  return {
    "e2e-open-1": link(),
    "e2e-paid-1": link({ ...PAID_LINK, link_id: "e2e-paid-1" }),
    "e2e-claimed-1": link({ ...CLAIMED_LINK, link_id: "e2e-claimed-1" }),
    "e2e-expired-1": link({ ...EXPIRED_LINK, link_id: "e2e-expired-1" }),
    "e2e-wrong-token-1": link({ ...WRONG_TOKEN_LINK, link_id: "e2e-wrong-token-1" }),
    "e2e-items-1": link({ ...ITEMS_LINK, link_id: "e2e-items-1" }),
    /* Used by receipt.spec.mjs, which flips OPEN → CLAIMED mid-test to make
       the page watch a payment land in-session (the celebrated gate). */
    "e2e-receipt-1": link({ link_id: "e2e-receipt-1" }),
    /* The Tidepool journey invoice (cross-chain receipt spec). */
    "e2e-tp-1": link({ link_id: "e2e-tp-1" }),
  };
}

/* ─────────────────────────────────────────── Tidepool Worker wire shapes ──
 * Bodies below are the exact shapes workers/tidepool/src/index.js serves and
 * frontend/tidepool.js validates (tpParseNetworks / tpParseStatus). */

export const TP_ENDPOINT = "https://paylink-tidepool.g32772584.workers.dev";

export const TP_JOURNEY = {
  linkId: "e2e-tp-1",
  intentId: "pi_0123456789abcdef", // ^pi_[0-9a-f]{16}$
  refundTo: PAYER,
  assetId: "usdc.near",
  blockchain: "near",
  at: NOW,
};

export const TP_NETWORKS = {
  networks: [
    {
      blockchain: "near",
      name: "NEAR",
      availability: "native", // pickable
      tokens: [
        { assetId: "usdc.near", symbol: "USDC", decimals: 6 },
        { assetId: "usdt.tether.near", symbol: "USDT", decimals: 6 },
      ],
    },
    {
      blockchain: "base",
      name: "Base",
      availability: "bridge-ok", // pickable
      tokens: [{ assetId: "usdc.base", symbol: "USDC", decimals: 6 }],
    },
    {
      blockchain: "bitcoin",
      name: "Bitcoin",
      availability: "bridge-down", // visible but disabled in the <select>
      tokens: [{ assetId: "btc", symbol: "BTC", decimals: 8 }],
    },
  ],
};

/** GET /status body for an intent in the given Paylink state. */
export function tpStatusBody(status, over = {}) {
  return {
    ok: true,
    intent: {
      intentId: TP_JOURNEY.intentId,
      linkId: TP_JOURNEY.linkId,
      status,
      createdAt: "2026-11-13T09:00:00.000Z",
      updatedAt: "2026-11-13T09:05:00.000Z",
      ...over,
    },
    conflict: null,
  };
}

/* The near-connect wallet registry manifest. The smoke suite answers every
   registry fetch with this empty-but-valid body so boot never depends on
   GitHub (and no wallet list can change a test). */
export const WALLET_MANIFEST = { version: "e2e-mock", wallets: [] };

/* Indicative FX (paintNgn reads rates.NGN only). */
export const FX_BODY = { result: "success", rates: { USD: 1, NGN: 1550.25 } };

/* Stand-in hashes: base58-shaped, unique per row. Purely local strings —
   they are never sent anywhere and exist only to prove the receipt prints
   the hashes the wallet returned. */
export const TX_PAYMENT_HASH = "3YJTe2bCk1pE2eReceiptFixtureHashAAAAAAA111111";
export const TX_RELEASE_HASH = "4ReleaseFixtureHashBBBBBBBBBBBB222222222222";
