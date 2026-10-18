-- Real, user-signed QIE native transfers are tracked separately from simulated NGN.
-- No customer ledger liability is created for funds held in a Privy wallet.
INSERT INTO asset_positions(id,asset_code,network,issuer,form,decimals,environment,enabled)
VALUES ('pos_qiev3_mainnet','QIEV3','qie-mainnet','native','native',18,'production',true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE chain_settlements (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  asset_position_id text NOT NULL REFERENCES asset_positions(id),
  network text NOT NULL,
  chain_id bigint NOT NULL,
  direction text NOT NULL CHECK(direction IN ('outbound')),
  source_address text NOT NULL,
  destination_address text NOT NULL,
  amount_atomic numeric(78,0) NOT NULL CHECK(amount_atomic>0),
  required_confirmations integer NOT NULL CHECK(required_confirmations BETWEEN 1 AND 1000),
  minimum_block_number bigint NOT NULL CHECK(minimum_block_number>=0),
  idempotency_key text NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  submission_expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  status text NOT NULL DEFAULT 'awaiting_submission'
    CHECK(status IN ('awaiting_submission','submitted','pending','unknown','confirmed','failed','expired')),
  tx_hash text UNIQUE,
  block_number bigint,
  block_hash text,
  observed_confirmations integer NOT NULL DEFAULT 0,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(personal_user_id,idempotency_key),
  CHECK(tx_hash IS NOT NULL OR status IN ('awaiting_submission','expired')),
  CHECK(status <> 'confirmed' OR (tx_hash IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL))
);
CREATE INDEX chain_settlements_reconcile ON chain_settlements(updated_at,id)
  WHERE status IN ('submitted','pending','unknown');
CREATE INDEX chain_settlements_personal ON chain_settlements(personal_user_id,created_at DESC);
