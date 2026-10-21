# Microsendr

**Your money, without borders.** Microsendr is a consumer finance application and settlement foundation. The public Personal experience uses custom email/password accounts, optional Didit identity verification, editable profiles and a responsive finance dashboard. Earlier Business, Stellar Testnet and developer sandbox modules remain in the repository for regression coverage.

> **Current status:** Registration, profile editing, and account security are implemented. Users link a self-custody EVM wallet with a signed challenge, then receive and send native QIEV3 on QIE Mainnet from it. With `PRIVY_APP_ID` and a fresh server-only `PRIVY_APP_SECRET`, each account is also issued a managed (custodial) wallet address; because outbound transfers from it are not built, the app never shows that address for deposits. Email verification, password recovery and identity verification need `SMTP_*` and `KORA_AUTH_SECRET`; Didit opens hosted identity verification when its credentials are configured. Digital-dollar deposits, conversion, fiat deposits, and bank withdrawals remain unavailable pending verified asset and provider integrations. See [settlement status](docs/microsendr-settlement-status.md).

## Product surface

| Area | Current behavior |
| --- | --- |
| Personal | Custom account creation, password sign-in, optional identity verification, editable profile, payments navigation and receipts |
| Settlement backend | Linked wallet signed transfer instructions, receipt matching and worker reconciliation with terminal mismatch handling; no customer ledger credit. Managed (Privy) addresses are provisioned but cannot send yet and are not shown for deposits. |
| Paystack | Test-key-only checkout, bank name enquiry and payout; explicit status verification |
| Financial core | PostgreSQL double-entry ledger, idempotency, reservations, outbox, immutable journals and reconciliation controls |
| Historical modules | Business workspace, Stellar Testnet KUSD and multi-provider sandbox routing |

A displayed currency is not itself evidence of ownership of a corresponding bank balance or token. Network details are shown when a deposit or withdrawal requires them for safety.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Landing page and Personal React client |
| `services/api` | Fastify API, authentication and provider endpoints |
| `services/worker` | Durable outbox, provider jobs and webhook delivery |
| `packages` | Core types, ledger, payment engine and chain adapters |
| `connectors` | Fake provider and Paystack test connector |
| `sdks/typescript` | Typed API client and webhook verifier |
| `specs/openapi` | Generated REST contract |
| `tests` | Unit, database, provider and browser coverage |
| `docs` | Current status, decisions, runbooks and historical phases |

See [architecture](docs/architecture.md) for module boundaries and settlement rules.

## Local development

Requires Node.js 22+, pnpm 10 and Docker Compose.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm sandbox:init
docker compose up -d --wait
pnpm db:migrate
pnpm dev
```

Open the URL printed by Vite. Copy `.env.example` for optional integrations and keep credentials in ignored server-side environment files. Configure `PRIVY_APP_ID` and a **rotated** `PRIVY_APP_SECRET` on the API server to issue a wallet address at signup; without them, registration succeeds but wallet issuance remains pending. The key previously shared in chat is exposed and must not be deployed. Configure `SMTP_*` and `KORA_AUTH_SECRET` for email verification and password recovery. Legacy Privy endpoints remain for compatibility. `PAYSTACK_SECRET_KEY` accepts **test keys only**. No provider key or wallet secret belongs in browser variables.

See [consumer account implementation](docs/consumer-accounts.md) for routes, deployment requirements and remaining payment dependencies.

## Checks

```sh
pnpm build             # Contract, SDK, TypeScript, web assets
pnpm check             # Unit and database integration suites
pnpm contract:check    # Generated contract drift
pnpm test:browser      # Playwright, including phone layout
```

Database suites require the migrated local PostgreSQL instance. Older provider suites need their documented fixtures.

## Financial safety

- Use integer minor units and balanced, immutable journals.
- Require idempotency keys for money-moving commands. Keep ambiguous provider results **unknown** until verified.
- Match external receipts to instructions before posting balances. A redirect, client callback or transaction hash alone is insufficient.
- QIEV3 transfers are signed by the user's linked wallet; Microsendr records settlement evidence and posts no QIE customer liability. Managed (Privy) wallet addresses are custodial and cannot send yet, so the client never presents them for deposits.
- Credit only allowlisted assets on verified networks; a ticker is not an asset identity.
- Label provider test events as tests. Live QIE-to-NGN conversion requires a verified asset, liquidity route, regulated partner arrangement, monitoring and reconciliation.

## Documentation

- [Current settlement and provider status](docs/microsendr-settlement-status.md)
- [Architecture](docs/architecture.md)
- [Financial core](docs/financial-core.md)
- [Technical decisions](docs/decisions.md)
- [Operations runbook](docs/operations-runbook.md)
- [TypeScript SDK](sdks/typescript/README.md)
- [Historical phase documents](docs/README.md)

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability and [CONTRIBUTING.md](CONTRIBUTING.md) before changing money movement. The archived PDFs in `docs/reference/` preserve historical product specifications under neutral archive filenames.
