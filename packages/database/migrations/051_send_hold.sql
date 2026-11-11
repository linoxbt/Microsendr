-- Sends from the account wallet pause until this time after a credential was changed on
-- the strength of an email code alone (recovery), so a taken-over inbox cannot reset the
-- password, PIN or passkeys and drain the wallet straight away.
ALTER TABLE personal_users ADD COLUMN send_hold_until timestamptz;
