-- Privy provisions one EVM address per Personal account. Its key is never stored here.
CREATE TABLE personal_managed_wallets (
  personal_user_id text PRIMARY KEY REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  privy_wallet_id text NOT NULL UNIQUE,
  address text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  network text NOT NULL DEFAULT 'qie-mainnet' CHECK (network = 'qie-mainnet'),
  created_at timestamptz NOT NULL DEFAULT now()
);
