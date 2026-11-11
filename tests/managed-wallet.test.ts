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

test('signup wallet provisioning is owned, persistent and settles on one wallet', async () => {
  const { userId, accountId } = await person();
  // A Privy stand-in following the documented API: create with external_id, list filtered by
  // ?external_id=. It does not enforce uniqueness, so concurrent creates make duplicates.
  const wallets: { id: string; address: string; external_id: string; created_at: number }[] = [];
  let seq = 0;
  await withPrivy(async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['privy-app-id'], 'test-app');
    assert.equal(headers.authorization, `Basic ${Buffer.from('test-app:test-secret').toString('base64')}`);
    assert.equal(headers['privy-idempotency-key'], undefined);
    const u = new URL(String(url));
    assert.equal(u.origin + u.pathname, 'https://api.privy.io/v1/wallets');
    if (init?.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { chain_type: 'ethereum', external_id: `roots_${userId}` });
      const n = ++seq;
      wallets.push({ id: `wallet_${n}_${userId}`, address: `0x${n}${userId.slice(4).padEnd(39, "0")}`, external_id: `roots_${userId}`, created_at: 1700000000000 + n });
      return Response.json(wallets.at(-1));
    }
    assert.equal(u.searchParams.get('external_id'), `roots_${userId}`);
    // Newest first, as a list might return: the client must still pick the oldest.
    return Response.json({ data: [...wallets].reverse(), next_cursor: null });
  }, async () => {
    const [first, second] = await Promise.all([ensureManagedWallet(userId, accountId), ensureManagedWallet(userId, accountId)]);
    const third = await ensureManagedWallet(userId, accountId);
    assert.equal(first?.address.toLowerCase(), `0x1${userId.slice(4).padEnd(39, "0")}`);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal((await pool.query('SELECT count(*)::int n FROM personal_managed_wallets WHERE personal_user_id=$1', [userId])).rows[0].n, 1);
  });
  // A wallet created earlier at Privy but never recorded here is found, not created again.
  const other = await person();
  let created = false;
  await withPrivy(async (url, init) => {
    if (init?.method === 'POST') { created = true; return new Response('{}', { status: 500 }); }
    return Response.json({ data: [{ id: `wallet_${other.userId}`, address: `0x2${other.userId.slice(4).padEnd(39, "0")}`, external_id: `roots_${other.userId}`, created_at: 1 }] });
  }, async () => {
    assert.equal((await ensureManagedWallet(other.userId, other.accountId))?.address.toLowerCase(), `0x2${other.userId.slice(4).padEnd(39, "0")}`);
    assert.equal(created, false);
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
  // The lookup finds nothing and the create fails: the create error is reported.
  await withPrivy(async (_url, init) => init?.method === 'POST' ? new Response('{}', { status: 503 }) : Response.json({ data: [] }), async () => {
    await assert.rejects(ensureManagedWallet(userId, accountId), (error: unknown) =>
      error instanceof ManagedWalletError && error.reason === 'privy_status_503');
  });
  await withPrivy(async () => Response.json({ data: [{ id: 'w', address: 'not-an-address', external_id: `roots_${userId}` }] }), async () => {
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
