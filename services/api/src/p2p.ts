import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress } from 'viem';
import { z } from 'zod';
import { pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { QIE_NETWORK } from '../../../packages/qie/src/index.js';
import { managedTransfersEnabled } from './managed-transfer.js';

type Person = { user_id: string; account_id: string };
const usernameSchema = z.string().trim().toLowerCase().regex(/^@?[a-z][a-z0-9_]{2,23}$/).transform((v) => v.replace(/^@/, ''));

/**
 * Where a Roots user receives P2P payments: their own linked wallet (most recent), or
 * their account wallet only while it can also send, so money never lands somewhere it
 * cannot leave. Null when they cannot be paid.
 */
export async function receivingAddress(userId: string, accountId: string) {
  const linked = (await pool.query(`SELECT address FROM personal_chain_wallets WHERE personal_user_id=$1 AND account_id=$2
    AND network=$3 AND status='active' ORDER BY created_at DESC, id LIMIT 1`, [userId, accountId, QIE_NETWORK])).rows[0];
  if (linked) return { address: getAddress(linked.address), custody: 'user_wallet' as const };
  if (!managedTransfersEnabled()) return null;
  const managed = (await pool.query('SELECT address FROM personal_managed_wallets WHERE personal_user_id=$1 AND account_id=$2',
    [userId, accountId])).rows[0];
  return managed ? { address: getAddress(managed.address), custody: 'managed' as const } : null;
}

/** The Roots user payable at this username, or null. Never the requester themselves. */
export async function payableUser(username: unknown, requesterId: string) {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) return null;
  const row = (await pool.query(`SELECT u.id,u.username,u.first_name,u.last_name,a.id AS account_id FROM personal_users u
    JOIN kora_accounts a ON a.personal_user_id=u.id WHERE u.username=$1 AND u.payable_by_username AND a.status='active'`,
    [parsed.data])).rows[0];
  if (!row || row.id === requesterId) return null;
  const receiving = await receivingAddress(row.id, row.account_id);
  if (!receiving) return null;
  const initial = typeof row.last_name === 'string' && row.last_name ? ` ${row.last_name[0].toUpperCase()}.` : '';
  return {
    username: row.username as string, display_name: `${row.first_name ?? ''}${initial}`.trim() || `@${row.username}`,
    address: receiving.address,
  };
}

/**
 * Records the @username a send was addressed to, only if that username still
 * resolves to the address the money went to. Returns the stored username or null.
 */
export async function rememberPayee(userId: string, settlementId: string, username: string | undefined, to: string) {
  if (!username) return null;
  const found = await payableUser(username, userId);
  if (!found || found.address.toLowerCase() !== to.toLowerCase()) return null;
  await pool.query('UPDATE chain_settlements SET recipient_username=$3 WHERE id=$1 AND personal_user_id=$2',
    [settlementId, userId, found.username]);
  return found.username;
}

export function registerP2P(app: FastifyInstance, required: (request: FastifyRequest, write?: boolean) => Promise<Person>) {
  // Lookups are rate limited: a username search must not become a way to list users.
  app.get('/personal/api/recipients/:username', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request);
    const found = await payableUser((request.params as { username: string }).username, person.user_id);
    if (!found) throw new PaymentError(404, 'recipient_unavailable', 'No Roots user can be paid at that username');
    return { ...found, network: QIE_NETWORK, asset: 'QIEV3' };
  });

  app.get('/personal/api/payment-settings', async (request) => {
    const person = await required(request);
    const row = (await pool.query('SELECT username,payable_by_username FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    const receiving = await receivingAddress(person.user_id, person.account_id);
    return { username: row.username, payable_by_username: row.payable_by_username, receiving_address: receiving?.address ?? null };
  });

  app.post('/personal/api/payment-settings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const { payable_by_username } = z.object({ payable_by_username: z.boolean() }).strict().parse(request.body);
    const row = (await pool.query('SELECT username FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    if (payable_by_username && !row.username) throw new PaymentError(409, 'username_required', 'Choose a username in your profile first');
    await pool.query('UPDATE personal_users SET payable_by_username=$2,updated_at=now() WHERE id=$1', [person.user_id, payable_by_username]);
    const receiving = await receivingAddress(person.user_id, person.account_id);
    return { username: row.username, payable_by_username, receiving_address: receiving?.address ?? null };
  });
}
