/* Paylink runtime configuration.
   Values are read from the built frontend. Kept as plain data so the page
   can be opened from a static host with no build step. */

export const CONFIG = {
  network: "testnet",
  /* rpc.testnet.near.org is deprecated: it answers 429 with no CORS headers, so
     the browser only ever sees "Failed to fetch". FastNEAR is the free testnet
     endpoint NEAR documents as its replacement. */
  rpcUrl: "https://test.rpc.fastnear.com",
  explorer: "https://testnet.nearblocks.io",

  /* Paylink payment-link contract (v2: Tidepool sandbox USDC allowlist —
     paylink.testnet v1 kept usdc.fakes.testnet and cannot be re-inited). */
  contractId: "paylink-v2.testnet",

  /* Accepted NEP-141 token. Must be on the contract's allowlist, which is
     fixed at init — see contracts/paylink-contract/README.md. Tidepool's
     test USDC: the faucet drips it free and swaps settle into it. */
  tokenId: "usdc.tidepool-sandbox.testnet",

  /* Token display metadata — used for human-readable amounts only.
     On-chain the contract only ever sees the raw integer amount. */
  token: {
    symbol: "USDC",
    decimals: 6,
    label: "USDC (testnet)",
    /* Names a document may use for this same token. The contract id is the
       only thing that goes on chain; these exist so an invoice that says
       "USDC" is not rejected as a different asset. Deliberately does not
       list USDC.e — that is a different test token we do not accept. */
    aliases: ["USDC"],
    /* The token is a USDC test token: worth one dollar by definition.
       Real market prices are not needed by anything on this page. */
    usdPrice: 1,
  },

  /* Fee taken from the payout at `claim`, in basis points (50 = 0.5%).
     Mirrors FEE_BPS in the contract, which also exposes `fee_bps()` so this
     number can be checked against the chain rather than trusted. */
  feeBps: 50,
  feeAccount: "paylink-fees.testnet",

  /* Indicative naira line under the dollar figure on the pay card — the
     Lagos story, on screen. Free, keyless, CORS-enabled public FX reference
     (no account, no quota). Display only: if the fetch fails the line stays
     hidden and the pay flow never notices. */
  fx: {
    url: "https://open.er-api.com/v6/latest/USD",
    quote: "NGN",
  },

  /* Invoice parsing proxy (Cloudflare Worker in workers/parse/).
     Empty string = the "paste a payment request" block stays hidden. The Worker
     holds the Gemini key; this file never does. Set this to the Worker URL
     after deploying it — see README.md. */
  parseEndpoint: "https://paylink-parse.g32772584.workers.dev",

  /* Tidepool — community testnet sandbox of the NEAR 1Click API.
     Keyless, free: the faucet drips test tokens and quotes settle swaps
     into the allowlisted USDC. Fail-closed everywhere in app.js. */
  tidepool: {
    origin: "https://www.usetidepool.tech",
    verifier: "verifier.tidepool-sandbox.testnet",
  },
};

/* 1 yoctoNEAR, required by NEP-141 state-changing calls and by `claim`. */
export const ONE_YOCTO = "1";

/* Storage stake the contract demands on `create_link`
   (CREATE_STORAGE_STAKE in lib.rs = 0.01 NEAR). */
export const CREATE_STAKE = "10000000000000000000000";

/* Longest note `create_link` accepts (MAX_DESCRIPTION_LEN in lib.rs = 280).
   The contract counts UTF-8 BYTES via `String::len()`, not characters. */
export const MAX_DESCRIPTION_BYTES = 280;

/* Gas, in gas units (1 Tgas = 10^12).
   50  Tgas — plain calls: create_link, view-driven writes.
   200 Tgas — `claim`, which queues two ft_transfers (15 each), the on_claimed
              callback (10) and still executes its own state writes.
   150 Tgas — `ft_transfer_call`, which must fund the token's ft_transfer
              plus the receiver's `ft_on_transfer` (NEP-141 reserves 10
              Tgas for the receiver). */
export const GAS_DEFAULT = "50000000000000";
export const GAS_CLAIM = "200000000000000";
export const GAS_FT_CALL = "150000000000000";
