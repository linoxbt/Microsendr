-- Each account-wallet signing claims the wallet with its own token, so a slow request
-- can only release its own claim.
ALTER TABLE personal_managed_wallets ADD COLUMN signing_token text;
-- The nonce a Roots-signed transaction uses. Allocated past every unconfirmed nonce
-- this wallet already signed, so a transaction the node has not seen is never reused.
ALTER TABLE chain_settlements ADD COLUMN nonce bigint;
CREATE INDEX chain_settlements_open_nonce ON chain_settlements(source_address, nonce)
  WHERE custody='managed' AND status IN ('submitted','pending','unknown');
