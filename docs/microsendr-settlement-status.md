# Microsendr settlement status

The Personal product currently posts only **simulated NGN** to its double-entry ledger. The landing page and account must not describe the sandbox balance as fiat or digital dollars held for a customer.

## QIE mainnet

- Chain ID 1990 and the RPC endpoint are configured from QIE's public documentation.
- Privy provisions an EVM wallet on Personal login. The Profile page shows its QIE address and live native QIEV3 balance. The Send page can initiate a user-authorized native QIEV3 transfer; the embedded wallet signs and broadcasts it.
- The API requires a wallet signature over the account, network, chain ID, sender, recipient, atomic amount, idempotency key and short expiry. It persists the instruction and the current QIE block before the browser broadcasts. One transaction hash can be attached only once.
- The worker verifies chain ID, transaction sender/recipient/amount, receipt, canonical block hash, creation block floor and 12 confirmations. RPC errors or mismatches enter an `unknown` state for repeated reconciliation; no automatic resubmission occurs.
- Native QIEV3 stays in the user's Privy wallet. The settlement record is evidence of an external wallet transfer, **not** a customer ledger balance or digital-dollar credit. The sandbox NGN ledger remains separate.
- Digital-dollar deposits and transfers remain disabled until the supported QUSDC contract, decimals, provenance, liquidity, custody, wallet signing behavior, and reconciliation path are verified. Search results for one commonly repeated QUSDC address resolve to an ordinary account on the QIE explorer.
- The signed instruction binds the sending wallet to one Microsendr Account for that transfer. Incoming deposits are not monitored or credited, and unsupported tokens are never treated as QIEV3 or digital dollars.

Future chains implement the `ChainSettlementAdapter` contract in `packages/settlement`, receive a canonical `asset_positions` entry, and register only after their own receipt, custody, liquidity and reconciliation controls are tested. The QIE adapter does not imply another chain is enabled.

## Paystack

- The provider connector supports **Paystack test mode** for Business rail workflows. Personal now has separate test-mode collection and withdrawal instructions with idempotency keys, provider credential binding, reserved balances, verified receipts, explicit provider fee journals, and unknown-outcome quarantine.
- Personal offers Paystack test checkout and bank recipient name enquiry. The user must select **Check status** after checkout or payout; provider verification then posts or releases the corresponding ledger amount. Automatic webhook/poll reconciliation remains a production-readiness gap.
- `PAYSTACK_SECRET_KEY` is absent on the deployed server. Only a test secret key can be used by the current connector.
- Paystack test transactions move no real NGN. The Personal balance continues to be labeled simulated, including after a verified test transaction. Paystack does not convert a QIE asset to NGN.
- Production use requires partner approval and a separately verified crypto-to-fiat settlement route.

## Privy

- The Personal backend verifies access and identity tokens with Privy's app-scoped public JWKS. The app secret is unnecessary for this flow and must remain server-side.
- The deployment app ID is in the ignored `.env.public`; the app secret supplied in chat was **not** stored in the repository or deployment. Rotate that exposed secret in Privy before using it for any server API calls.
