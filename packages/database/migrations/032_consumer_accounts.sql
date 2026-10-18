-- Custom consumer registration. Contact collection is not contact verification.
ALTER TABLE personal_users DROP CONSTRAINT personal_email_verified_pair;
ALTER TABLE personal_users ADD CONSTRAINT personal_verified_email_requires_email CHECK(email_verified_at IS NULL OR email IS NOT NULL);
ALTER TABLE personal_users ADD COLUMN first_name text;
ALTER TABLE personal_users ADD COLUMN last_name text;
ALTER TABLE personal_users ADD COLUMN username text UNIQUE;
ALTER TABLE personal_users ADD COLUMN phone text;
ALTER TABLE personal_users ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE personal_users ADD COLUMN date_of_birth date;
ALTER TABLE personal_users ADD COLUMN address_line1 text;
ALTER TABLE personal_users ADD COLUMN address_line2 text;
ALTER TABLE personal_users ADD COLUMN city text;
ALTER TABLE personal_users ADD COLUMN region text;
ALTER TABLE personal_users ADD COLUMN postal_code text;
ALTER TABLE personal_users ADD COLUMN occupation text;
ALTER TABLE personal_users ADD COLUMN password_hash text;
ALTER TABLE personal_users ADD COLUMN profile_version integer NOT NULL DEFAULT 1;
ALTER TABLE personal_sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'legacy';
CREATE TABLE personal_auth_limits (
  email_hash text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE personal_profile_events (
  id text PRIMARY KEY,
  personal_user_id text NOT NULL REFERENCES personal_users,
  changed_fields text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
