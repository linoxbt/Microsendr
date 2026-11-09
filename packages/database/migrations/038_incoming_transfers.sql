-- Incoming QIE and QUSDC transfers to Personal wallet addresses. These are chain
-- observations verified against a QIE node, not customer ledger balances. Rows are
-- facts about an address; ownership is resolved when read, using the window in which
-- the address belonged to an account, so a relinked address never leaks history.
CREATE TABLE chain_incoming_transfers (
  id text PRIMARY KEY,
  network text NOT NULL CHECK (network = 'qie-mainnet'),
  asset text NOT NULL CHECK (asset IN ('QIEV3', 'QUSDC')),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) NOT NULL CHECK (amount_atomic > 0),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  -- -1 for a native transfer, otherwise the log index of the token Transfer event.
  log_index integer NOT NULL CHECK (log_index >= -1),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_time timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, tx_hash, log_index, address)
);
CREATE INDEX chain_incoming_transfers_address ON chain_incoming_transfers(network, address, block_time DESC);
CREATE TRIGGER chain_incoming_transfers_immutable BEFORE UPDATE OR DELETE ON chain_incoming_transfers
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

-- Per address and asset: how far the indexer has verified, and when to look again.
CREATE TABLE chain_incoming_cursors (
  network text NOT NULL,
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL CHECK (asset IN ('QIEV3', 'QUSDC')),
  scanned_through_block bigint,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  failures integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY (network, address, asset)
);
CREATE INDEX chain_incoming_cursors_due ON chain_incoming_cursors(next_poll_at);
