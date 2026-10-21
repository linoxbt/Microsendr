# Microsendr settlement status

The consumer dashboard uses custom accounts and excludes simulated ledger balances. Native QIEV3 can be received and sent through an account linked, user controlled wallet. Digital-dollar deposits, live fiat balances and conversion are unavailable. Historical sandbox modules remain isolated for testing. See [consumer accounts](consumer-accounts.md).

## QIE mainnet

- Chain ID 1990 and the RPC endpoint are configured from QIE's public documentation.
- Personal accounts link one or more existing EVM wallets through a five-minute, single-use signed challenge. The private key remains with the wallet provider. A wallet cannot be active on two Microsendr accounts at once. Registration does not require a wallet.
- The linked address and QR code receive native QIEV3 on QIE Mainnet. The app reads the onchain balance without posting a Microsendr customer liability. It does not claim to custody the funds or credit digital dollars.
- Sending native QIEV3 requires a linked wallet, a fresh signed settlement authorization and an explicit transaction confirmation in that wallet. It is not a gasless transfer; the user needs QIEV3 for network fees.
- The API requires a wallet signature over the account, network, chain ID, sender, recipient, atomic amount, idempotency key and short expiry. It persists the instruction and the current QIE block before the browser broadcasts. One transaction hash can be attached only once.
- The worker verifies chain ID, transaction sender/recipient/amount, receipt, canonical block hash, creation block floor and 12 confirmations. Evidence that contradicts the instruction (sender, recipient, amount, or a transaction mined before the instruction) is terminal `mismatched`. RPC errors enter `unknown` and back off from 15 seconds to an hour; a settlement not final after seven days becomes `expired`. No automatic resubmission occurs. Submitting a hash whose visible sender is another wallet is refused.
- Native QIEV3 stays in the user's linked wallet. The settlement record is evidence of an external wallet transfer, **not** a customer ledger balance or digital-dollar credit. The sandbox NGN ledger remains separate.
- Digital-dollar deposits and transfers remain disabled. The home screen reads balances of the QUSDC contract `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5` (6 decimals) held in the user's wallets and labels them "Digital dollars"; these are observed onchain holdings, not Microsendr balances. Their USD estimate uses the QIE explorer's rate and fails closed unless the token reports 6 decimals and a rate within 5% of $1.
- The signed instruction binds the sending wallet to one Microsendr Account for that transfer. Incoming transfers update the wallet's observed onchain balance; they are not independently indexed into Microsendr activity or credited. Unsupported tokens are never treated as QIEV3 or digital dollars.

Future chains implement the `ChainSettlementAdapter` contract in `packages/settlement`, receive a canonical `asset_positions` entry, and register only after their own receipt, custody, liquidity and reconciliation controls are tested. The QIE adapter does not imply another chain is enabled.

## Paystack

- The provider connector supports **Paystack test mode** for Business rail workflows. Personal now has separate test-mode collection and withdrawal instructions with idempotency keys, provider credential binding, reserved balances, verified receipts, explicit provider fee journals, and unknown-outcome quarantine.
- Historical Personal API modules support Paystack test checkout and bank recipient name enquiry; these are excluded from the redesigned consumer UI. The user must select **Check status** after checkout or payout; provider verification then posts or releases the corresponding ledger amount. Automatic webhook/poll reconciliation remains a production-readiness gap.
- `PAYSTACK_SECRET_KEY` is absent on the deployed server. Only a test secret key can be used by the current connector.
- Paystack test transactions move no real NGN. They remain marked simulated in backend records and are never shown as customer balances in the new dashboard. Paystack does not convert a QIE asset to NGN.
- Production use requires partner approval and a separately verified crypto-to-fiat settlement route.

## Privy

- Legacy Personal endpoints verify access and identity tokens with Privy's app-scoped public JWKS. The app secret is unnecessary for this flow and must remain server-side.
- The deployment app ID is in the ignored `.env.public`; the app secret supplied in chat was **not** stored in the repository or deployment. Rotate that exposed secret in Privy before using it for any server API calls.

## Identity and email

Didit workflow and webhook credentials are configured on the deployment. A user must consent before opening hosted verification; signed webhook decisions remain authoritative. Actual verification completion requires the user's own documents and has not been performed by the coding agent. SMTP is not configured, so email verification and recovery currently show an unavailable state. New password registration and password sign-in do not depend on SMTP.
