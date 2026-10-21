import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { id, pool } from '../packages/database/src/index.js';
import { ensureManagedWallet, ManagedWalletError } from '../services/api/src/managed-wallet.js';

after(async () => { await pool.end(); });

async function person() {
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2)', [userId, `${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  return { userId, accountId };
}

async function withPrivy(fetchImpl: typeof fetch, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.PRIVY_APP_ID, originalSecret = process.env.PRIVY_APP_SECRET;
  process.env.PRIVY_APP_ID = 'test-app';
  process.env.PRIVY_APP_SECRET = 'test-secret';
  globalThis.fetch = fetchImpl;
  try { await run(); } finally {
    globalThis.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.PRIVY_APP_ID; else process.env.PRIVY_APP_ID = originalAppId;
    if (originalSecret === undefined) delete process.env.PRIVY_APP_SECRET; else process.env.PRIVY_APP_SECRET = originalSecret;
  }
}

test('signup wallet provisioning is owned, persistent and idempotent', async () => {
  const { userId, accountId } = await person();
  const address = `0x${userId.slice(4, 44).padEnd(40, '0')}`;
  const walletId = `wallet_${userId}`;
  const keys: string[] = [];
  await withPrivy(async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(String(url), 'https://api.privy.io/v1/wallets');
    assert.equal(headers['privy-app-id'], 'test-app');
    assert.equal(headers.authorization, `Basic ${Buffer.from('test-app:test-secret').toString('base64')}`);
    keys.push(headers['privy-idempotency-key']);
    assert.deepEqual(JSON.parse(String(init?.body)), { chain_type: 'ethereum' });
    return Response.json({ id: walletId, address });
  }, async () => {
    // Concurrent first requests share one idempotency key and persist one row.
    const [first, second] = await Promise.all([ensureManagedWallet(userId, accountId), ensureManagedWallet(userId, accountId)]);
    const third = await ensureManagedWallet(userId, accountId);
    assert.equal(first?.address.toLowerCase(), address);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.ok(keys.length <= 2);
    assert.ok(keys.every(key => key === `microsendr_${userId}`));
    assert.equal((await pool.query('SELECT count(*)::int n FROM personal_managed_wallets WHERE personal_user_id=$1', [userId])).rows[0].n, 1);
  });
});

test('provider failure is reported with a reason and holds no database connection', async () => {
  const { userId, accountId } = await person();
  let idleDuringCall = -1;
  await withPrivy(async () => {
    idleDuringCall = pool.totalCount - pool.idleCount;
    return new Response('{}', { status: 500 });
  }, async () => {
    await assert.rejects(ensureManagedWallet(userId, accountId), (error: unknown) =>
      error instanceof ManagedWalletError && error.reason === 'privy_status_500');
    assert.equal(idleDuringCall, 0);
    await assert.rejects(ensureManagedWallet(userId, accountId));
  });
  await withPrivy(async () => Response.json({ id: 'w', address: 'not-an-address' }), async () => {
    await assert.rejects(ensureManagedWallet(userId, accountId), (error: unknown) =>
      error instanceof ManagedWalletError && error.reason === 'invalid_wallet_record');
  });
  assert.equal((await pool.query('SELECT count(*)::int n FROM personal_managed_wallets WHERE personal_user_id=$1', [userId])).rows[0].n, 0);
});

test('unconfigured provisioning returns no wallet without calling the provider', async () => {
  const { userId, accountId } = await person();
  const originalAppId = process.env.PRIVY_APP_ID;
  delete process.env.PRIVY_APP_ID;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  try { assert.equal(await ensureManagedWallet(userId, accountId), null); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalAppId !== undefined) process.env.PRIVY_APP_ID = originalAppId;
  }
});
