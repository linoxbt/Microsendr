-- QUSDC on QIE Mainnet can be sent as well as received. Its own asset position keeps
-- token settlements apart from native QIE ones.
INSERT INTO asset_positions(id,asset_code,network,issuer,token_address,form,decimals,environment,enabled)
VALUES ('pos_qusdc_mainnet','QUSDC','qie-mainnet','0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5',
  '0x3f43da82ec9a4f5285f10faf1f26eca7319e5da5','issued',6,'production',true)
ON CONFLICT (id) DO NOTHING;

-- A passkey approval names the asset as well as the recipient and amount.
ALTER TABLE personal_webauthn_challenges ADD COLUMN asset_position_id text NOT NULL DEFAULT 'pos_qiev3_mainnet';
