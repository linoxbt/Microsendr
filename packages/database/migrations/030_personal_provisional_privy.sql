-- A verified Privy DID can own a Personal sandbox account before Privy's
-- optional email identity token is enabled. Email-based features remain gated
-- until the server obtains a verified linked email from Privy.
ALTER TABLE personal_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE personal_users ALTER COLUMN email_verified_at DROP NOT NULL;
ALTER TABLE personal_users ADD CONSTRAINT personal_email_verified_pair
  CHECK ((email IS NULL) = (email_verified_at IS NULL));
