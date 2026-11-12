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
// must not exhaust the pool. Each wallet carries external_id roots_<user> (Privy: URL-safe,
// at most 64 characters, write-once). Privy does not document it as unique, so the wallet
// is looked up by it (GET /v1/wallets?external_id=, the documented filter) before creating
// and again after any create failure; if more than one ever matches, the oldest is used,
// so retries and concurrent requests settle on the same wallet. (Idempotency keys are
// avoided: Privy caches 5xx replies under a key for 24 hours.) The primary key on
// personal_user_id keeps one row here.
export async function ensureManagedWallet(userId: string, accountId: string): Promise<Wallet | null> {
  const existing = await findManagedWallet(userId, accountId);
  if (existing) return existing;
  const appId = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) return null;
  // Unique per app and write-once at Privy. Wallets issued under an earlier prefix
  // stay linked through the personal_managed_wallets row, which is checked first.
  // The prefix stays roots_ (the product's name when it was introduced): Privy stores
  // external ids permanently, so changing it would orphan wallets already issued.
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
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  };
  type PrivyWallet = { id?: unknown; address?: unknown; external_id?: unknown; created_at?: unknown };
  const lookup = async (): Promise<PrivyWallet | undefined> => {
    const page = await call(`${base}?${new URLSearchParams({ external_id: externalId, chain_type: 'ethereum', limit: '10' })}`);
    const matches = (Array.isArray(page.data) ? page.data as PrivyWallet[] : []).filter((wallet) => wallet.external_id === externalId);
    const time = (wallet: PrivyWallet) => typeof wallet.created_at === 'number' ? wallet.created_at
      : typeof wallet.created_at === 'string' ? Date.parse(wallet.created_at) || 0 : 0;
    // Oldest first; equal times fall back to the id, so every caller picks the same wallet.
    return matches.sort((a, b) => time(a) - time(b) || String(a.id).localeCompare(String(b.id)))[0];
  };
  let record: PrivyWallet | undefined = await lookup();
  if (!record) {
    try {
      // With PRIVY_POLICY_ID set (see scripts/privy-policy.ts), Privy itself limits what the wallet can sign.
      const policy = process.env.PRIVY_POLICY_ID;
      await call(base, { method: 'POST', body: JSON.stringify({ chain_type: 'ethereum', external_id: externalId,
        ...(policy ? { policy_ids: [policy] } : {}) }) });
    } catch (createError) {
      // A previous or concurrent attempt may have created it; otherwise report the failure.
      record = await lookup().catch(() => undefined);
      if (!record) throw createError;
    }
    // Read back by external id, so a duplicate created by a concurrent request resolves to the oldest.
    record ??= await lookup();
  }
  if (!record) throw new ManagedWalletError('invalid_wallet_record');
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
