import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { id, pool } from '../packages/database/src/index.js';
import { ensureManagedWallet } from '../services/api/src/managed-wallet.js';

after(async () => { await pool.end(); });

test('signup wallet provisioning is owned, persistent and idempotent', async () => {
  const userId = id('usr'), accountId = id('acct');
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2)', [userId, `${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.PRIVY_APP_ID, originalSecret = process.env.PRIVY_APP_SECRET;
  const address = '0x1234567890123456789012345678901234567890';
  let creates = 0;
  process.env.PRIVY_APP_ID = 'test-app';
  process.env.PRIVY_APP_SECRET = 'test-secret';
  globalThis.fetch = async (url, init) => {
    assert.equal((init?.headers as Record<string,string>)['privy-app-id'], 'test-app');
    assert.equal((init?.headers as Record<string,string>).authorization,
      `Basic ${Buffer.from('test-app:test-secret').toString('base64')}`);
    if (String(url).includes('/ext_wal_')) return new Response('{}', { status: 404 });
    creates++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chain_type, 'ethereum');
    assert.equal(body.external_id, `microsendr_${userId}`);
    return Response.json({ id: 'wallet_test_123', address });
  };
  try {
    const first = await ensureManagedWallet(userId, accountId);
    const second = await ensureManagedWallet(userId, accountId);
    assert.equal(first?.address, address);
    assert.deepEqual(second, first);
    assert.equal(creates, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM personal_managed_wallets WHERE personal_user_id=$1', [userId])).rows[0].n, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.PRIVY_APP_ID; else process.env.PRIVY_APP_ID = originalAppId;
    if (originalSecret === undefined) delete process.env.PRIVY_APP_SECRET; else process.env.PRIVY_APP_SECRET = originalSecret;
  }
});
