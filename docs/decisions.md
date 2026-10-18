# Canonical implementation decisions

## Product name and scope

The current product is **Microsendr**, a consumer financial account with
QIE as its intended primary settlement network. The current launch scope is
Personal. Business and Stellar Testnet modules remain historical sandbox work.
The previous Kora name and network scope are retained in archived material only.

The repository supplied a v1.0 master PDF and a v2.1 network addendum referencing
an absent v2.0.0 baseline. The implementation uses their shared financial safety
requirements, the addendum's network domain direction, and the phased roadmap
in this repository. No missing baseline is assumed to have been reviewed.

## Financial truth

PostgreSQL double-entry accounting is canonical. Bank, anchor, and Stellar
observations are evidence that a payment engine must match before posting a
settlement journal. Redis is not needed for Phase 0 and will never own balances.

## Runtime and storage

TypeScript/Node with pnpm workspaces. PostgreSQL 17 and parameterized SQL using
`pg`; SQL migrations expose the deferred accounting triggers explicitly.
Drizzle/Turborepo are not required for the initial package count. The API
and worker are independent deployables; domain modules remain in-process.

## Asset identity and precision

Phase 0 registry keys identify fixed sandbox definitions. NGN/KES/GHS use scale
2. Simulated USDC uses scale 6 and explicit sandbox network/issuer metadata.
Quotes use fixed illustrative rational rates; they are not market quotations.
No registry entry denotes a production-approved Stellar issuer. The real Stellar
connector must define and test wire precision and rounding before activation.

## Instruction safety

A reservation and a stable provider instruction are distinct objects. The fake
provider persists an instruction fingerprint, enforces one instruction per hold,
and returns a durable status after an ambiguous acknowledgement. Local unique
keys alone are not a guarantee of exactly-once effects at a real provider.

## Foundation access

Phase 0 is a library/CLI foundation. Ledger functions are trusted internal
primitives. Phase 1 exposes scoped, authenticated API operations and performs
sandbox compliance/limit checks before reservation and again before provider
submission. Capture/release on external outcomes requires matching durable
provider evidence. Production deployment remains disabled in the config.

## Phase 1 delivery controls

Provider instructions are persisted before submission and their contents are
immutable. Outbox jobs use PostgreSQL leases with ownership tokens; per-intent
session advisory locks serialize execution and cancellation. A crashed worker's
lock is released by the database; the job becomes eligible when its lease expires.
Recovery queries status first. Reusing the same external instruction key after
no known outcome is permitted only for a connector declaring external instruction
idempotency. The simulator implements that declaration; real connectors must
prove it individually.

Webhook endpoints and cached mutation responses are encrypted with AES-256-GCM.
Local keys are generated into ignored, private `.env` configuration. Outbound
origins require an explicit operator allowlist; redirects are not followed.
Delivery is at-least-once and receivers deduplicate by event ID.

## Original source documents

The source PDFs are retained in `docs/reference/` under neutral archive
filenames. Their original wording is historical reference material; the
settlement status document describes current launch capabilities.
