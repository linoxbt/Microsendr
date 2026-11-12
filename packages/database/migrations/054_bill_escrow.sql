-- Purchases paid into the MicrosendrPay escrow contract: the operator records each
-- payment on chain (hold), then releases it to the treasury on delivery (settle) or
-- returns it to the payer when delivery fails (refund).
ALTER TABLE personal_bill_orders
  ADD COLUMN escrow_state text CHECK (escrow_state IN ('held', 'settled', 'refunded')),
  ADD COLUMN escrow_hold_tx text,
  ADD COLUMN escrow_final_tx text;
ALTER TABLE personal_bill_orders DROP CONSTRAINT IF EXISTS personal_bill_orders_status_check;
ALTER TABLE personal_bill_orders ADD CONSTRAINT personal_bill_orders_status_check
  CHECK (status IN ('paying', 'paid', 'fulfilling', 'delivered', 'payment_failed', 'refund_due', 'refunded'));
DROP INDEX IF EXISTS personal_bill_orders_due;
CREATE INDEX personal_bill_orders_due ON personal_bill_orders(next_check_at)
  WHERE status IN ('paying', 'paid', 'fulfilling') OR escrow_state = 'held';
