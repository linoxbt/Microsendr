# Microsendr

**Your money, without borders.** Microsendr is a consumer finance application and settlement foundation. The current public Personal experience uses Privy sign-in, an embedded QIE wallet, and clearly labeled sandbox money flows. Earlier Business, Stellar Testnet and developer sandbox modules remain in the repository for regression coverage.

> **Current status:** Development sandbox. NGN balances and Paystack test transactions are simulated. QIE mainnet support is read-only. Digital-dollar deposits, transfers, exchange and live bank payouts are not enabled. See [settlement status](docs/microsendr-settlement-status.md).

## Product surface

| Area | Current behavior |
| --- | --- |
| Personal | Privy login, embedded wallet, home, activity, profile, sandbox payments and Paystack test collection/payout |
| QIE | Mainnet address and native balance reads; receipt validation library; no automatic credit or live send |
| Paystack | Test-key-only checkout, bank name enquiry and payout; explicit status verification |
| Financial core | PostgreSQL double-entry ledger, idempotency, reservations, outbox, immutable journals and reconciliation controls |
| Historical modules | Business workspace, Stellar Testnet KUSD and multi-provider sandbox routing |

A displayed currency is not itself evidence of ownership of a corresponding bank balance or token. Network details are shown when a deposit or withdrawal requires them for safety.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Personal React client and historical sandbox console |
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

Open the URL printed by Vite. Copy `.env.example` for optional integrations and keep credentials in ignored server-side environment files. `PRIVY_APP_ID` enables hosted login. `PAYSTACK_SECRET_KEY` accepts **test keys only**. No provider key or wallet secret belongs in browser variables.

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
