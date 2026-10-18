# Architecture

Microsendr is a TypeScript monorepo with a Fastify API, durable worker, React client and PostgreSQL. The financial core is a modular monolith. API and worker share domain packages but run as separate processes.

## Boundaries

| Module | Owns |
| --- | --- |
| `apps/web` | Presentation and user authorization; never authoritative balances |
| `services/api` | Authentication, validation, idempotency and endpoints |
| `services/worker` | Leased outbox work, external attempts and webhook delivery |
| `packages/ledger` | Balanced immutable journals and balance projections |
| `packages/payments` | Intents, reservations, provider evidence and lifecycle |
| `packages/qie` | QIE chain configuration and read-only receipt validation |
| `connectors/paystack` | Test-mode NGN provider contract |

## Payment lifecycle

```text
authorize → validate → reserve → persist instruction/outbox → submit
          → verify provider or chain evidence → complete/release
          → reconcile → deliver receipt/event
```

Unknown external outcomes remain owned and visible. The orchestrator queries the same provider instruction before any safe retry. The frontend never promotes a callback, checkout redirect or transaction hash into an available balance.

## Deployment boundaries

The frontend is on Netlify. The API, worker and PostgreSQL run separately. The API hostname predates the rename and remains an infrastructure endpoint. Provider keys and signing material are server-side only. See [public deployment](public-deployment.md) and [settlement status](microsendr-settlement-status.md).

Historical Business and Stellar modules remain isolated from Personal routes. A production digital-dollar product requires an allowlisted QIE asset, reliable deposit attribution, signing/custody, provider settlement, reconciliation and partner approval.
