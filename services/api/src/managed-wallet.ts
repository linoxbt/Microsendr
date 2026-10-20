import { getAddress, isAddress } from 'viem';
import { pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';

type Wallet = { id: string; address: string; network: 'qie-mainnet'; custody: 'managed' };
const base = 'https://api.privy.io/v1/wallets';

export async function ensureManagedWallet(userId: string, accountId: string): Promise<Wallet | null> {
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  // A row lock serializes repeated requests from the same account. Privy's immutable
  // external_id also lets us recover after a provider success and DB failure.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM personal_users WHERE id=$1 FOR UPDATE', [userId]);
    const existing = (await client.query(
      'SELECT privy_wallet_id,address FROM personal_managed_wallets WHERE personal_user_id=$1 AND account_id=$2',
      [userId, accountId],
    )).rows[0];
    if (existing) {
      await client.query('COMMIT');
      return { id: existing.privy_wallet_id, address: getAddress(existing.address), network: 'qie-mainnet', custody: 'managed' };
    }
    if (!appId || !secret) {
      await client.query('COMMIT');
      return null;
    }
    const headers = {
      authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
      'privy-app-id': appId,
      'content-type': 'application/json',
    };
    const externalId = `microsendr_${userId}`;
    const request = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Privy wallet request returned ${response.status}`);
      return response.json() as Promise<unknown>;
    };
    let remote: unknown;
    try {
      remote = await request(`${base}/ext_wal_${externalId}`);
    } catch {
      // external_id is unique at Privy; a concurrent/retried create cannot allocate a second wallet.
      try {
        remote = await request(base, { method: 'POST', body: JSON.stringify({
          chain_type: 'ethereum', external_id: externalId, display_name: 'Microsendr Personal',
        }) });
      } catch {
        remote = await request(`${base}/ext_wal_${externalId}`);
      }
    }
    const record = remote as { id?: unknown; address?: unknown };
    if (typeof record.id !== 'string' || typeof record.address !== 'string' || !isAddress(record.address))
      throw new Error('Privy returned an invalid wallet record');
    const address = getAddress(record.address);
    await client.query(
      'INSERT INTO personal_managed_wallets(personal_user_id,account_id,privy_wallet_id,address) VALUES($1,$2,$3,$4)',
      [userId, accountId, record.id, address.toLowerCase()],
    );
    await client.query('COMMIT');
    return { id: record.id, address, network: 'qie-mainnet', custody: 'managed' };
  } catch {
    await client.query('ROLLBACK');
    throw new PaymentError(503, 'wallet_provisioning_unavailable', 'Your account is ready, but its wallet address is temporarily unavailable. Please try again shortly.');
  } finally { client.release(); }
}
