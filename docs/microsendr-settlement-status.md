# Microsendr settlement status

The Personal product currently posts only **simulated NGN** to its double-entry ledger. The landing page and account must not describe the sandbox balance as fiat or digital dollars held for a customer.

## QIE mainnet

- Chain ID 1990 and the RPC endpoint are configured from QIE's public documentation.
- Privy provisions an EVM wallet on Personal login. The Profile page can show its QIE address and live native QIE balance through a server-side, read-only RPC call. The UI warns users not to deposit until monitoring and accounting are in place.
- `packages/qie` validates native transfer receipts against an expected instruction and confirmation threshold. It does **not** submit transactions or post to the ledger.
- Digital-dollar deposits and transfers remain disabled until the supported QUSDC contract, decimals, provenance, liquidity, custody, wallet signing behavior, and reconciliation path are verified. Search results for one commonly repeated QUSDC address resolve to an ordinary account on the QIE explorer.
- The wallet address is not yet bound to a Kora Account by signed identity evidence. Do not treat an arbitrary client address or transaction hash as a customer deposit.

## Paystack

- The existing provider connector supports **Paystack test mode** for Business rail workflows, with verified receipts and idempotent ledger posting. The Personal product does not yet use that connector.
- `PAYSTACK_SECRET_KEY` is absent on the deployed server. Only a test secret key can be used by the current connector.
- A Personal deposit/withdrawal flow needs its own persisted instructions, account/recipient binding, verified Paystack statuses, provider fee accounting, returns, and reconciliation. Paystack does not convert a QIE asset to NGN.
- Production use requires partner approval and a separately verified crypto-to-fiat settlement route.

## Privy

- The Personal backend verifies access and identity tokens with Privy's app-scoped public JWKS. The app secret is unnecessary for this flow and must remain server-side.
- The deployment app ID is in the ignored `.env.public`; the app secret supplied in chat was **not** stored in the repository or deployment. Rotate that exposed secret in Privy before using it for any server API calls.
