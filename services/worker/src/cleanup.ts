import { pool } from '../../../packages/database/src/index.js';

// Expired sign-in material has no further use; keep it a day for support, then remove
// it in small batches so the tables (and their indexes) stay small.
const sweeps = [
  "DELETE FROM personal_sessions WHERE ctid IN (SELECT ctid FROM personal_sessions WHERE expires_at < now() - interval '1 day' LIMIT 500)",
  "DELETE FROM personal_email_challenges WHERE ctid IN (SELECT ctid FROM personal_email_challenges WHERE expires_at < now() - interval '1 day' LIMIT 500)",
  "DELETE FROM personal_webauthn_challenges WHERE ctid IN (SELECT ctid FROM personal_webauthn_challenges WHERE expires_at < now() - interval '1 day' LIMIT 500)",
  "DELETE FROM personal_chain_wallet_challenges WHERE ctid IN (SELECT ctid FROM personal_chain_wallet_challenges WHERE expires_at < now() - interval '1 day' LIMIT 500)",
  "DELETE FROM personal_auth_limits WHERE ctid IN (SELECT ctid FROM personal_auth_limits WHERE window_started_at < now() - interval '1 day' LIMIT 500)",
  // Quotes an order still refers to are kept; the rest expire within minutes.
  `DELETE FROM personal_conversion_quotes q WHERE q.ctid IN (SELECT ctid FROM personal_conversion_quotes WHERE expires_at < now() - interval '1 day' LIMIT 500)
     AND NOT EXISTS (SELECT 1 FROM personal_conversion_orders o WHERE o.quote_id = q.quote_id)`,
];

let lastRun = 0;
/** Worker job: one cleanup pass every ten minutes (or now, when forced). */
export async function cleanupExpired(force = false) {
  if (!force && Date.now() - lastRun < 10 * 60_000) return false;
  lastRun = Date.now();
  let removed = 0;
  for (const sql of sweeps) removed += (await pool.query(sql)).rowCount ?? 0;
  // More left: run again soon rather than wait ten minutes.
  if (removed >= 500) lastRun = 0;
  return removed > 0;
}
