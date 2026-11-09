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
// must not exhaust the pool. Privy's external_id is unique per app and write-once, so
// concurrent or retried creates converge on one wallet; after any create failure the
// wallet is looked up by that id. (Idempotency keys are avoided: Privy caches 5xx
// replies under a key for 24 hours.) The primary key on personal_user_id keeps one row.
export async function ensureManagedWallet(userId: string, accountId: string): Promise<Wallet | null> {
  const existing = await findManagedWallet(userId, accountId);
  if (existing) return existing;
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) return null;
  // Unique per app and write-once at Privy. Wallets issued under an earlier prefix
  // stay linked through the personal_managed_wallets row, which is checked first.
  const externalId = `roots_${userId}`;
  const call = async (url: string, init: RequestInit = {}) => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
          'privy-app-id': appId,
          'content-type': 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch (cause) {
      throw new ManagedWalletError(cause instanceof Error ? cause.name : 'network_error');
    }
    if (!response.ok) throw new ManagedWalletError(`privy_status_${response.status}`);
    return (await response.json().catch(() => ({}))) as { id?: unknown; address?: unknown };
  };
  let record: { id?: unknown; address?: unknown };
  try {
    record = await call(base, { method: 'POST', body: JSON.stringify({ chain_type: 'ethereum', external_id: externalId }) });
  } catch (createError) {
    // A previous attempt may have created it (Privy succeeded, we did not record it).
    try { record = await call(`${base}/ext_wal_${externalId}`); } catch { throw createError; }
  }
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

/** Privy wallet RPC (app-owned wallets: app credentials, no owner signature). */
export async function privyWalletRpc(walletId: string, body: unknown, request: typeof fetch = fetch) {
  const appId = process.env.PRIVY_APP_ID, secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new ManagedWalletError('unconfigured');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(walletId)) throw new ManagedWalletError('invalid_wallet_id');
  const response = await request(`${base}/${walletId}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
      'privy-app-id': appId,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ManagedWalletError(`privy_status_${response.status}`);
  return response.json() as Promise<unknown>;
}
