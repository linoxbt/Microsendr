-- Airtime, mobile data and gift cards, paid in QUSDC from the account wallet.
-- The QUSDC payment is an ordinary chain settlement to the Microsendr treasury; the
-- order is placed with the provider only after that payment is confirmed on chain.
CREATE TABLE personal_bill_orders (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('airtime', 'data', 'giftcard')),
  provider text NOT NULL DEFAULT 'reloadly',
  provider_environment text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  country_code text NOT NULL,
  operator_id bigint,
  product_id bigint,
  recipient_phone text,
  recipient_email text,
  product_name text NOT NULL,
  -- What the recipient gets, in their currency (naira of airtime, a $25 card, ...).
  face_amount numeric(20,2) NOT NULL,
  face_currency text NOT NULL,
  -- What Microsendr pays the provider, and what the customer pays.
  cost_usd numeric(20,6) NOT NULL,
  fee_usd numeric(20,6) NOT NULL,
  price_atomic numeric(40,0) NOT NULL CHECK (price_atomic > 0),
  settlement_id text REFERENCES chain_settlements(id),
  status text NOT NULL DEFAULT 'paying'
    CHECK (status IN ('paying', 'paid', 'fulfilling', 'delivered', 'payment_failed', 'refund_due')),
  provider_transaction_id text,
  delivery jsonb,
  error text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (personal_user_id, idempotency_key)
);
CREATE INDEX personal_bill_orders_owner ON personal_bill_orders(personal_user_id, created_at DESC);
CREATE INDEX personal_bill_orders_due ON personal_bill_orders(next_check_at) WHERE status IN ('paying', 'paid', 'fulfilling');
