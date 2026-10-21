-- Balance checks, reversals and reports look up entries by journal on every posting.
CREATE INDEX IF NOT EXISTS ledger_entries_journal ON ledger_entries(journal_id);

-- Outbox jobs that exhaust their retries or fail permanently are parked for review
-- instead of being retried forever.
ALTER TABLE outbox ADD COLUMN dead_at timestamptz;
CREATE INDEX outbox_dead ON outbox(dead_at) WHERE dead_at IS NOT NULL;

-- Chain evidence that contradicts its instruction is terminal. Transient RPC errors
-- back off between checks instead of polling every 15 seconds forever.
ALTER TABLE chain_settlements DROP CONSTRAINT chain_settlements_status_check;
ALTER TABLE chain_settlements ADD CONSTRAINT chain_settlements_status_check
  CHECK(status IN ('awaiting_submission','submitted','pending','unknown','confirmed','failed','expired','mismatched'));
ALTER TABLE chain_settlements ADD COLUMN check_failures integer NOT NULL DEFAULT 0;
ALTER TABLE chain_settlements ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
DROP INDEX chain_settlements_reconcile;
CREATE INDEX chain_settlements_reconcile ON chain_settlements(next_check_at,id)
  WHERE status IN ('submitted','pending','unknown');

-- Signed authorizations last five minutes; an unsubmitted instruction should not
-- linger for a week.
ALTER TABLE chain_settlements ALTER COLUMN submission_expires_at SET DEFAULT now()+interval '1 hour';

-- Settlement amounts, parties and hashes never change once recorded.
CREATE FUNCTION chain_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.personal_user_id IS DISTINCT FROM OLD.personal_user_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.source_address IS DISTINCT FROM OLD.source_address OR NEW.destination_address IS DISTINCT FROM OLD.destination_address
     OR NEW.amount_atomic IS DISTINCT FROM OLD.amount_atomic OR NEW.network IS DISTINCT FROM OLD.network
     OR NEW.chain_id IS DISTINCT FROM OLD.chain_id OR NEW.minimum_block_number IS DISTINCT FROM OLD.minimum_block_number
     OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN
    RAISE EXCEPTION 'chain settlement instruction is immutable';
  END IF;
  IF OLD.status IN ('confirmed','failed','expired','mismatched') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'chain settlement % is terminal', OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chain_settlement_guard BEFORE UPDATE ON chain_settlements
  FOR EACH ROW EXECUTE FUNCTION chain_settlement_guard();
CREATE TRIGGER chain_settlement_no_delete BEFORE DELETE ON chain_settlements
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

-- Balance checks sum one account's entries; cover them so the sum is an index-only scan.
CREATE INDEX IF NOT EXISTS ledger_entries_account_amounts ON ledger_entries(account_id) INCLUDE (side, amount);
