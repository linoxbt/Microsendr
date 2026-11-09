-- Outbound native transfers from Privy-managed (custodial) wallets reuse
-- chain_settlements. The signed transaction is kept so the worker can re-broadcast
-- the identical transaction, never a new one.
ALTER TABLE chain_settlements ADD COLUMN custody text NOT NULL DEFAULT 'user_wallet'
  CHECK (custody IN ('user_wallet', 'managed'));
ALTER TABLE chain_settlements ADD COLUMN signed_transaction text
  CHECK (signed_transaction IS NULL OR signed_transaction ~ '^0x[0-9a-f]+$');
ALTER TABLE chain_settlements ADD CONSTRAINT chain_settlements_managed_signed
  CHECK (custody = 'user_wallet' OR tx_hash IS NULL OR signed_transaction IS NOT NULL);
CREATE INDEX chain_settlements_managed_daily ON chain_settlements(personal_user_id, created_at)
  WHERE custody = 'managed';

-- One signing at a time per managed wallet, so concurrent sends cannot reuse a nonce.
ALTER TABLE personal_managed_wallets ADD COLUMN signing_until timestamptz;
