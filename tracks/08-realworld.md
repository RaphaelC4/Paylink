# 08. Real-World Money

**Track id:** `realworld` · **Tagline:** Bring the boring money onchain

Build payroll, invoicing, remittances, merchant payments and stablecoin rails for real
businesses. Something a normal company could use tomorrow.

**Lean on:** Stablecoins, NEAR Intents, meta transactions

## Start here

- [1Click API quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart)
- [Building a meta transaction relayer](https://docs.near.org/web3-apps/tutorials/meta-transactions)
- [NEP-141 fungible token standard](https://github.com/near/NEPs/blob/master/neps/nep-0141.md)
- [PingPay Agent Pay facilitator](https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator)

## Note

PingPay's facilitator lets agents pay an x402 paywall in USDC on Base, settling to your NEAR
recipient.

## Prompt

```text
Track: Real-World Money (id: realworld).

Build [crypto invoicing for freelancers who don't care about crypto]. A freelancer creates
an invoice and gets a link. The client pays from whatever chain and token they already hold.
The freelancer receives USDC on NEAR and never buys NEAR for gas.

Requirements:
- Invoice page with amount, due date, line items and a pay button. Payment goes through
  1Click API.
- Payer signs a swap intent and the freelancer gets paid in USDC on NEAR.
- Gasless path: a relayer submits the payment and the freelancer never touches NEAR for gas.
- Status the freelancer trusts: on-chain confirmation, not "processing..." purgatory.
- Bonus: export a CSV of payments for tax time.
```

Source: <https://raw.githubusercontent.com/nearai/near-hackathon-prompt-examples/main/tracks/08-realworld.md>
(fetched 2026-11-05 during build; this file is the track brief this repo submits against)
