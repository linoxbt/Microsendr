-- Statement reconciliation looks up Paystack transfer receipts by provider id.
CREATE INDEX IF NOT EXISTS receipts_provider_data_id ON receipts ((payload->'provider_data'->>'id'));
