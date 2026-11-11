-- Quotes are kept so an order can only use a quote this user received, before it
-- expires, for the same asset and amount.
CREATE TABLE personal_conversion_quotes (
  quote_id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
  asset text NOT NULL,
  amount numeric(30,2) NOT NULL,
  pay_amount numeric(38,8) NOT NULL,
  receive_amount numeric(38,8) NOT NULL,
  fees jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_conversion_quotes_owner ON personal_conversion_quotes(personal_user_id, created_at DESC);

-- An order row is written before Fonbnk is called (status 'creating'), so a timeout or
-- crash can be resolved by looking the order up by its reference.
ALTER TABLE personal_conversion_orders ALTER COLUMN provider_order_id DROP NOT NULL;
ALTER TABLE personal_conversion_orders
  ADD COLUMN request_hash text,
  ADD COLUMN quote_used boolean,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN check_count integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS personal_conversion_orders_open;
CREATE INDEX personal_conversion_orders_due ON personal_conversion_orders(next_check_at)
  WHERE status NOT IN ('payout_successful', 'refund_successful', 'create_failed');
