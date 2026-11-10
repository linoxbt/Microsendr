-- The @username a payment was addressed to, recorded only when it resolved to the
-- same address at send time. Lets the sender see "To @name" and pay again; it never
-- maps an arbitrary address back to a user.
ALTER TABLE chain_settlements ADD COLUMN recipient_username text;
