# Phase 2 — Sandbox product

Run the commands in the root README, build the web app, then start the API and
worker. The API serves the built app on port 4310. In development, `pnpm dev`
adds Vite on port 5173 with same-origin API proxies.

## Workspace and access

`/connect` either creates an isolated sandbox or exchanges an existing sandbox
API key for a one-day session. Session tokens are random and hashed in PostgreSQL;
the cookie is HttpOnly and SameSite=Strict, and Secure for configured HTTPS origins.
Browser mutations require an exact allowed Origin plus a session CSRF token.
Revoking the linked API key immediately invalidates its sessions. Sign-out deletes
the session. API keys never enter localStorage or sessionStorage.

`KORA_CONSOLE_ORIGINS` specifies exact trusted origins. It is separate from
`KORA_WEBHOOK_ALLOWED_ORIGINS`. The API binds to loopback by default. The
workspace-creation endpoint is limited to five requests/hour per client address,
creates a fresh merchant every time, and does not reveal its administrator key.
This local sandbox onboarding does not implement production identity or KYB.

New workspaces receive journaled NGN 2,500,000, KES 750,000, GHS 12,000 and
simulated USDC 8,000 before seven sample payments execute. Five settle, one fails
with insufficient provider float, and one has an ambiguous acknowledgement with
a real simulator movement and a held balance. Seed execution jobs start with a
future availability time so a running worker cannot erase the unknown fixture.

Existing Phase 1 keys retain their existing permissions. To administer keys and
operations, create a new CLI workspace/key with the current default scopes.
The API never permits a key to grant scopes that its caller lacks.

## Product surfaces

| Surface | Behavior |
| --- | --- |
| Overview | Actual available/reserved ledger balances, settled source volume in USD equivalents, UTC daily activity and latest intents |
| Transactions | Reference/ID search, state filter, cursor pagination, export of loaded rows, detail timeline |
| New transfer | Exact decimal-to-integer parsing, five-minute quote, included source fee, idempotent recipient/instrument/intent creation, worker status polling |
| Hosted flow | Same payment workflow for simulated asset purchase/redemption using prefunded workspace balances |
| Network | Clearly labeled simulator corridors and assets; no live capacity or uptime claims |
| Assets | Available/reserved balances and exact USDC sandbox issuer/network identity |
| Customers | Actual recipient records and verified simulator instruments |
| Developers | Scoped keys with secrets returned on creation/retry, revocation, encrypted webhook registration, disable/replay, delivery results and request metadata |
| Operations | Owned reconciliation records, holds, instructions, attempts, matched receipts and immutable journals; safe unknown-intent status recovery |
| Docs | Generated endpoint inventory, SDK examples and interactive `/reference` |

The source amount **includes** the 0.5% fee. The full source amount is reserved;
the conversion uses source minus fee. Display math uses integer strings and
BigInt. The activity chart converts only display heights to JavaScript numbers.
No historical volumes or merchant balances are fabricated for presentation.

## Simulator outcomes

- `success`: the fake provider confirms with durable evidence; worker records
  a receipt, captures the source hold, books the destination journal and emits success.
- `insufficient_float`: provider rejects; worker releases funds and emits failure.
- `timeout`: provider commits acceptance before the acknowledgement is lost;
  intent stays unknown with funds held. Operations recovery queues status lookup,
  producing one receipt/capture from the original instruction.

Webhook registration accepts only allowed origins and follows no redirects.
Run `pnpm webhook:receiver` on port 4311 for local delivery. The request log stores
only request ID, merchant/key IDs, HTTP method, route template, status, duration
and timestamp. Bodies, headers, actual resource IDs and query values are omitted.

## Contract and SDK

`packages/contracts` defines strict request schemas and named response schemas.
Fastify registers these on each versioned route, validates inputs, serializes
responses and generates OpenAPI 3.0.3. Internal callbacks and session endpoints
are excluded from the public API contract. All mutations document idempotency.

`pnpm generate` writes `specs/openapi/microsendr.json` and generated SDK types.
`pnpm contract:check` checks both without writing. The SDK client imports no Node
runtime modules; raw-body signature helpers are a separate Node-only export.
Builds produce ESM, source maps and declarations. No package is published by CI.

## Validation and phase boundary

Browser checks use real HTTP, the built app, PostgreSQL and a separate worker
process. They exercise completion, hosted conversion, unknown recovery, receipt
and journal visibility, scoped-key revocation, endpoint registration/replay,
request-log redaction, customer instruments and narrow-screen navigation.
They also check quote renewal and same-key retry after a simulated lost intent
response; the real API persists one intent and the worker settles it once.
Screenshots are stored locally in ignored `.sandbox/screenshots/`.

Run the integration and browser suites sequentially with standalone workers
stopped; process-crash fixtures intentionally leave unacknowledged jobs.
CI repeats contract, build, core, database, smoke and browser checks sequentially.
No hosted deployment, real-bank collection, live KYC, production custody or
Stellar network transaction is included. Those retain their later phase gates.
