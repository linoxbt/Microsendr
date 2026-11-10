-- Buying stablecoins with naira through Fonbnk. The customer pays Fonbnk's bank
-- instructions directly; Roots never collects the naira, and coins go to a wallet
-- the customer controls. Rows mirror the provider's order for display and polling.
CREATE TABLE personal_conversion_orders (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  provider text NOT NULL CHECK (provider = 'fonbnk'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  provider_order_id text NOT NULL UNIQUE,
  direction text NOT NULL CHECK (direction = 'buy'),
  quote_id text NOT NULL,
  idempotency_key text NOT NULL,
  pay_currency text NOT NULL,
  pay_amount numeric(30,2) NOT NULL CHECK (pay_amount > 0),
  receive_asset text NOT NULL CHECK (receive_asset ~ '^[A-Z0-9]+_[A-Z0-9_]+$'),
  receive_amount numeric(38,8) NOT NULL CHECK (receive_amount > 0),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  fees jsonb NOT NULL DEFAULT '[]',
  transfer_instructions jsonb,
  status text NOT NULL,
  provider_expires_at timestamptz,
  payout_tx_hash text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (personal_user_id, idempotency_key)
);
CREATE INDEX personal_conversion_orders_owner ON personal_conversion_orders(personal_user_id, created_at DESC);
CREATE INDEX personal_conversion_orders_open ON personal_conversion_orders(updated_at)
  WHERE status NOT IN ('payout_successful', 'refund_successful');

-- Webhook deliveries are retried and may arrive out of order; keep each once.
CREATE TABLE fonbnk_webhook_events (
  body_hash text PRIMARY KEY,
  provider_order_id text,
  status text,
  received_at timestamptz NOT NULL DEFAULT now()
);
