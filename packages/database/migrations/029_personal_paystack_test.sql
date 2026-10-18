-- Personal Paystack instructions are test-mode only. Keep their provider
-- evidence and accounting separate from the one-time sandbox fixture.
CREATE TABLE personal_paystack_operations (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id),
  account_id text NOT NULL REFERENCES kora_accounts(id),
  kind text NOT NULL CHECK (kind IN ('collection', 'withdrawal')),
  amount_minor numeric(30,0) NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  provider_binding text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN
    ('created', 'submitting', 'checkout_ready', 'pending', 'unknown', 'completed', 'failed', 'returned')),
  checkout_url text,
  recipient_code text,
  bank_code text,
  bank_last4 text,
  bank_account_hash text,
  bank_name text,
  provider_id text,
  provider_fee_minor numeric(30,0),
  reserve_journal_id text UNIQUE REFERENCES journals(id),
  journal_id text UNIQUE REFERENCES journals(id),
  return_journal_id text UNIQUE REFERENCES journals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (personal_user_id, kind, idempotency_key),
  CHECK ((kind='collection' AND recipient_code IS NULL AND bank_account_hash IS NULL)
      OR (kind='withdrawal' AND recipient_code IS NOT NULL AND bank_account_hash IS NOT NULL))
);
CREATE INDEX personal_paystack_operations_owner ON personal_paystack_operations(personal_user_id,created_at DESC);
