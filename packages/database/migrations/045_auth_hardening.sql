-- Browsers that have signed in to an account before. A known device is not held
-- back by the account-wide login cap, so strangers cannot lock the owner out.
CREATE TABLE personal_known_devices (
  token_hash text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_known_devices_user ON personal_known_devices(personal_user_id);
CREATE INDEX personal_email_challenges_email_created ON personal_email_challenges(email, created_at DESC);
