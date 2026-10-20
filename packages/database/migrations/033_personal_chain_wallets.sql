-- User controlled QIE wallets are linked by a signed, short lived challenge.
-- Balances remain onchain and are never posted as customer ledger liabilities.
CREATE TABLE personal_chain_wallet_challenges (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  network text NOT NULL CHECK (network = 'qie-mainnet'),
  address text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_chain_wallet_challenges_owner
  ON personal_chain_wallet_challenges(personal_user_id,created_at DESC);

CREATE TABLE personal_chain_wallets (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  network text NOT NULL CHECK (network = 'qie-mainnet'),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  label text NOT NULL DEFAULT 'QIE wallet',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX personal_chain_wallets_active_address
  ON personal_chain_wallets(network,address) WHERE status='active';
CREATE INDEX personal_chain_wallets_owner
  ON personal_chain_wallets(personal_user_id,created_at DESC) WHERE status='active';
