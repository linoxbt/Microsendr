# Operations runbook

These procedures operate the local sandbox and staging controls. Production
roles, custody/provider contacts, on-call ownership, service objectives, offsite
backup destinations, and recovery objectives require approval before activation.

## Ambiguous payment or provider outage

1. Record the affected merchant, intent, provider binding, instruction/hash,
   timestamps, and reason in the incident system. Use Operations to inspect the
   hold, attempts, receipts, and journals. Keep credentials and XDR private.
2. Pause new payments through Pilot controls or `POST /v1/controls/pause` using
   an operations writer and a stable idempotency key. Wait for acknowledgment.
   A submitted transaction can still settle after pause.
3. Preserve unknown holds and saved references/envelopes. Request status
   verification for the same intent; recover using its original provider binding.
   Never create a replacement transaction, change a reference, or fall back to
   another rail while the first outcome is ambiguous.
4. Match authoritative identity, amount, asset, and receipt before capture.
   Verified rejection releases the original hold; verified late returns use the
   correcting lifecycle. Generic journal reversal is blocked for owned payments.
5. Inspect unresolved work and run daily ledger controls. Review discrepancies
   against independent provider statements; a clean ledger report alone does not
   certify provider cash or liabilities.
6. Record current review evidence and request resume at the current policy
   revision. Another active enrolled operator independently reviews it. Keep
   the incident and provider confirmation references in the evidence system.

## Stellar sequence or signer incident

Pause the merchant and inspect the stored Testnet hash, sequence, receipt, and
fee journals. Verify the hash through the configured Horizon network. An unknown
sequence blocks other treasury payments. An expired unobserved envelope remains
ambiguous: do not re-sign it at a new sequence. Signer outage must not trigger a
local secret fallback. Remote mode is an optional bridge, not a validated
production custody service. Credential rotation and account migration need
approved custody procedures and reconciliation of existing movements.

## Daily controls

Run `POST /v1/controls/reports` with a UTC date and idempotency key. Review
unbalanced/empty journal and negative-account counts, open intents, absent
receipts, open reconciliation, provider snapshot reviews, and unsettled
collections. Investigate any nonzero count before approving a pilot policy.
Confirm that the balance period is complete. Merchant history is immutable;
corrections use new evidence and lifecycle journals, never edits to posted rows.

## Encrypted local backup and restore drill

Run `pnpm backup:drill` while PostgreSQL is available. The script uses matching
PostgreSQL tools inside `KORA_POSTGRES_CONTAINER` (default `kora-postgres`), an
exported repeatable-read snapshot, and a custom-format archive. It creates a
private random AES-256-GCM key at `.sandbox/backup-key` if absent, stores only
an encrypted archive, reads it back, authenticates and decrypts it, and restores
into a new random `kora_restore_*` database. It never restores over the source
and never starts a worker against the restored database.

All public-schema tables are compared by row counts and deterministic SHA-256
row checksums at the same snapshot. The drill also checks restored journal
immutability, rejection of late entries, balancing, nonnegative merchant
balances, and absence of empty journals. Its private proof names the isolated
database and encrypted archive without credentials. It intentionally leaves the
database for inspection. Restores contain credentials and queued work: do not
point a running API or worker at them.

The archive limit is 256 MiB for this local drill. The source and named container
must refer to the same PostgreSQL database. A matching-version server container
avoids the installed host PostgreSQL 16 client mismatch with PostgreSQL 17.
In CI, the container is the PostgreSQL service container.

This is a logical backup/restore validation. It does not implement offsite
retention, scheduled production backups, WAL archiving/PITR, geographic recovery,
or key escrow. The archive and encryption key remain on the same development
host. Production needs an approved separate key vault, encrypted offsite copies,
retention policy, monitored jobs, measured RPO/RTO, and repeated recovery drills.
Environment secrets are not part of the database dump: preserve the application
encryption keys separately under an approved process.

## Recovery before restarting service

Keep workers stopped while restoring to an isolated database. Verify manifests,
ledger invariants, constraints, application encryption-key availability, and
provider balances/receipts. Identify all restored pending jobs and instructions;
reconcile external movements that occurred after the snapshot before any queue
is resumed. Restored outbox entries must not cause duplicate provider sends.
An authorized recovery review, external status verification, and capped resume
are required before directing service traffic to recovered state. No production
cutover is automated by the local drill.

PostgreSQL's [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
and [pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)
describe archive and snapshot handling. Restoring an archive executes its SQL;
use trusted Kora archives and isolated databases.

## Worker failure handling

- Each worker queue (payments, rails, webhooks, chain settlements, Didit decisions,
  Personal Paystack) retries a failing iteration with exponential backoff and never
  stops the others. Failures are logged as JSON lines naming the queue.
- The worker touches `/tmp/worker-heartbeat` (override with `KORA_WORKER_HEARTBEAT`)
  as iterations complete; the Compose healthcheck marks it unhealthy after two
  minutes without one.
- Outbox jobs that fail 25 times (10 for an unmapped provider event) are parked:
  `SELECT id,kind,attempts,last_error FROM outbox WHERE dead_at IS NOT NULL`.
  `POST /v1/operations/intents/:id/recover` re-queues a parked payment job.
- Chain settlements whose evidence contradicts the instruction become
  `mismatched`; ones not final after seven days become `expired`. Review both:
  `SELECT id,status,last_error FROM chain_settlements WHERE status IN ('mismatched','expired')`.
- Personal Paystack operations idle in flight for five minutes are re-verified by
  reference. A payout Paystack has no record of after an hour releases its
  reservation.
- Applied migrations are checksummed. Editing one fails `pnpm db:migrate`; add a
  new migration instead.
