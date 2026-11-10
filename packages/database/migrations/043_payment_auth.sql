-- Payment PIN and passkeys authorize sends from the account wallet. The PIN is
-- peppered and scrypt-hashed; wrong guesses lock it for a while.
ALTER TABLE personal_users
  ADD COLUMN payment_pin_hash text,
  ADD COLUMN pin_failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until timestamptz;

CREATE TABLE personal_passkeys (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX personal_passkeys_user ON personal_passkeys(personal_user_id);

-- One-time WebAuthn challenges. A send challenge is bound to its recipient and amount.
CREATE TABLE personal_webauthn_challenges (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('register', 'send')),
  challenge text NOT NULL,
  origin text NOT NULL,
  destination_address text,
  amount_atomic numeric(78,0),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_webauthn_challenges_user ON personal_webauthn_challenges(personal_user_id, created_at);
