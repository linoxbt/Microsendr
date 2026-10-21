import { getAddress, isAddress } from 'viem';
import { pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';

type Wallet = { id: string; address: string; network: 'qie-mainnet'; custody: 'managed' };
const base = 'https://api.privy.io/v1/wallets';

export class ManagedWalletError extends PaymentError {
  constructor(readonly reason: string) {
    super(503, 'wallet_provisioning_unavailable', 'Your account is ready, but its wallet address is temporarily unavailable. Please try again shortly.');
  }
}

export function managedWalletConfigured() {
  return !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

export async function findManagedWallet(userId: string, accountId: string): Promise<Wallet | null> {
  const row = (await pool.query(
    'SELECT privy_wallet_id,address FROM personal_managed_wallets WHERE personal_user_id=$1 AND account_id=$2',
    [userId, accountId],
  )).rows[0];
  return row ? { id: row.privy_wallet_id, address: getAddress(row.address), network: 'qie-mainnet', custody: 'managed' } : null;
}

// No database connection or lock is held while Privy is called: a slow provider
// must not exhaust the pool. Concurrent or retried creates share one Privy
// idempotency key, and the primary key on personal_user_id keeps one row.
export async function ensureManagedWallet(userId: string, accountId: string): Promise<Wallet | null> {
  const existing = await findManagedWallet(userId, accountId);
  if (existing) return existing;
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) return null;
  let response: Response;
  try {
    response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
        'privy-app-id': appId,
        'privy-idempotency-key': `microsendr_${userId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chain_type: 'ethereum' }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
  } catch (cause) {
    throw new ManagedWalletError(cause instanceof Error ? cause.name : 'network_error');
  }
  if (!response.ok) throw new ManagedWalletError(`privy_status_${response.status}`);
  const record = (await response.json().catch(() => ({}))) as { id?: unknown; address?: unknown };
  if (typeof record.id !== 'string' || typeof record.address !== 'string' || !isAddress(record.address))
    throw new ManagedWalletError('invalid_wallet_record');
  const address = getAddress(record.address);
  await pool.query(
    `INSERT INTO personal_managed_wallets(personal_user_id,account_id,privy_wallet_id,address)
     VALUES($1,$2,$3,$4) ON CONFLICT(personal_user_id) DO NOTHING`,
    [userId, accountId, record.id, address.toLowerCase()],
  );
  return findManagedWallet(userId, accountId);
}
