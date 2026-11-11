-- When reconciliation first saw a Roots-signed transaction missing while its nonce was
-- already used. It is written off only if that is still true ten minutes later, so a
-- lagging or load-balanced RPC node cannot make a mined transfer look replaced.
ALTER TABLE chain_settlements ADD COLUMN replaced_seen_at timestamptz;
