import { pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';

export const SEND_HOLD_HOURS = 24;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * Pause account-wallet sends after a credential change that only an email code authorised
 * (a password reset through recovery, or a PIN or passkey change on an account without a
 * password). Someone who takes over the inbox then cannot reset and drain straight away.
 */
export async function holdSends(userId: string, c: Queryable = pool) {
  await c.query(`UPDATE personal_users SET send_hold_until=GREATEST(COALESCE(send_hold_until,now()),now()+make_interval(hours => $2))
    WHERE id=$1`, [userId, SEND_HOLD_HOURS]);
}

/** Refuses an account-wallet send while a hold is in place. */
export async function assertNoSendHold(userId: string) {
  const until = (await pool.query('SELECT send_hold_until FROM personal_users WHERE id=$1 AND send_hold_until>now()', [userId])).rows[0]?.send_hold_until;
  if (until) {
    const when = new Date(until).toISOString().replace('T', ' ').slice(0, 16);
    throw new PaymentError(403, 'send_hold', `For your security, sending is paused until ${when} UTC after a recent sign-in change.`);
  }
}
