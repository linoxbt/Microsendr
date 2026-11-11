import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../../../packages/database/src/index.js';
import { hashKey } from '../../../packages/payments/src/auth.js';
import { secureCookie } from './config.js';

const COOKIE = 'roots_device';

/** True when this browser has signed in to the account with this email before. */
export async function knownDevice(request: FastifyRequest, email: string) {
  const token = request.cookies[COOKIE];
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
  return !!(await pool.query(`UPDATE personal_known_devices d SET last_seen_at=now() FROM personal_users u
    WHERE d.token_hash=$1 AND u.id=d.personal_user_id AND u.email=$2 RETURNING 1`, [hashKey(token), email])).rowCount;
}

/** Marks this browser as known for the account after a successful sign-in. */
export async function rememberDevice(request: FastifyRequest, reply: FastifyReply, userId: string, origin: string) {
  const existing = request.cookies[COOKIE];
  if (typeof existing === 'string' && /^[a-f0-9]{64}$/.test(existing) &&
      (await pool.query('SELECT 1 FROM personal_known_devices WHERE token_hash=$1 AND personal_user_id=$2', [hashKey(existing), userId])).rowCount)
    return;
  const token = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO personal_known_devices(token_hash,personal_user_id) VALUES($1,$2)', [hashKey(token), userId]);
  reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie(origin), path: '/personal/api', maxAge: 365 * 86400 });
}
