-- Dead-lettering counts consecutive failures only; ordinary status polls reset it.
ALTER TABLE outbox ADD COLUMN failures integer NOT NULL DEFAULT 0;

-- A hash claimed by a settlement whose evidence proved it was not that sender's
-- transfer must not block the real sender from linking it.
ALTER TABLE chain_settlements DROP CONSTRAINT chain_settlements_tx_hash_key;
CREATE UNIQUE INDEX chain_settlements_tx_hash ON chain_settlements(tx_hash)
  WHERE tx_hash IS NOT NULL AND status <> 'mismatched';

-- Worker sweeps look for in-flight rows by status.
CREATE INDEX personal_didit_sessions_open ON personal_didit_sessions(updated_at)
  WHERE status IN ('creating','Not Started','In Progress','Awaiting User','In Review','Resubmitted');
CREATE INDEX personal_paystack_operations_open ON personal_paystack_operations(updated_at)
  WHERE status IN ('submitting','checkout_ready','pending','unknown');
