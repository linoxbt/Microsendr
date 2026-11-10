import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { buildApi } from '../services/api/src/app.js';

const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
after(async () => { await app.close(); await pool.end(); });
const origin = 'http://127.0.0.1:4310';
const hex = (n: number) => randomBytes(n).toString('hex');

async function member(username: string | null, opts: { payable?: boolean; linked?: boolean; managed?: boolean } = {}) {
  const userId = id('usr'), accountId = id('acct'), token = hex(32), csrf = hex(32);
  await pool.query('INSERT INTO personal_users(id,email,username,first_name,last_name,payable_by_username) VALUES($1,$2,$3,$4,$5,$6)',
    [userId, `${userId}@example.test`, username, 'Ada', 'Okafor', !!opts.payable]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), userId, csrf]);
  const linked = `0x${hex(20)}`, managed = `0x${hex(20)}`;
  if (opts.linked) await pool.query("INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address) VALUES($1,$2,$3,'qie-mainnet',$4)", [id('cwa'), userId, accountId, linked]);
  if (opts.managed) await pool.query('INSERT INTO personal_managed_wallets(personal_user_id,account_id,privy_wallet_id,address) VALUES($1,$2,$3,$4)', [userId, accountId, `privy_${hex(8)}`, managed]);
  return { userId, linked, managed, headers: { origin, cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf } };
}
const name = () => `p2p_${hex(5)}`;
const lookup = (who: { headers: Record<string, string> }, username: string) =>
  app.inject({ url: `/personal/api/recipients/${encodeURIComponent(username)}`, headers: who.headers });

test('a user who opted in with a linked wallet can be found by @username', async () => {
  const payer = await member(name());
  const handle = name();
  const payee = await member(handle, { payable: true, linked: true });
  for (const form of [handle, `@${handle}`, handle.toUpperCase()]) {
    const found = await lookup(payer, form);
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().address.toLowerCase(), payee.linked);
    assert.equal(found.json().display_name, 'Ada O.');
    assert.equal(found.json().username, handle);
  }
});

test('usernames reveal nothing without opt-in, a receiving wallet, or for oneself', async () => {
  const payer = await member(name());
  const hidden = name(), walletless = name(), self = name(), managedOnly = name();
  await member(hidden, { linked: true });
  await member(walletless, { payable: true });
  const me = await member(self, { payable: true, linked: true });
  await member(managedOnly, { payable: true, managed: true });
  for (const handle of [hidden, walletless, 'nobody_here', managedOnly, '../etc'])
    assert.deepEqual([(await lookup(payer, handle)).statusCode, (await lookup(payer, handle)).json().error.code], [404, 'recipient_unavailable']);
  assert.equal((await lookup(me, self)).statusCode, 404);
  // An account wallet receives only while it can also send.
  const previous = { flag: process.env.KORA_MANAGED_TRANSFERS, id: process.env.PRIVY_APP_ID, secret: process.env.PRIVY_APP_SECRET };
  Object.assign(process.env, { KORA_MANAGED_TRANSFERS: 'true', PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'test-secret' });
  try { assert.equal((await lookup(payer, managedOnly)).statusCode, 200); }
  finally {
    for (const [key, value] of [['KORA_MANAGED_TRANSFERS', previous.flag], ['PRIVY_APP_ID', previous.id], ['PRIVY_APP_SECRET', previous.secret]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('opting in needs CSRF and a username, and can be turned off', async () => {
  const handle = name();
  const user = await member(handle, { linked: true });
  const url = '/personal/api/payment-settings';
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...user.headers, 'x-kora-csrf': '0'.repeat(64) }, payload: { payable_by_username: true } })).statusCode, 403);
  const on = await app.inject({ method: 'POST', url, headers: user.headers, payload: { payable_by_username: true } });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().receiving_address.toLowerCase(), user.linked);
  assert.equal((await lookup(await member(name()), handle)).statusCode, 200);
  await app.inject({ method: 'POST', url, headers: user.headers, payload: { payable_by_username: false } });
  assert.equal((await lookup(await member(name()), handle)).statusCode, 404);
  const anonymous = await member(null, { linked: true });
  const refused = await app.inject({ method: 'POST', url, headers: anonymous.headers, payload: { payable_by_username: true } });
  assert.deepEqual([refused.statusCode, refused.json().error.code], [409, 'username_required']);
  assert.deepEqual((await app.inject({ url, headers: user.headers })).json().payable_by_username, false);
});

test('a send keeps the @username only when it resolved to the address paid', async () => {
  const { rememberPayee } = await import('../services/api/src/p2p.js');
  const payer = await member(name());
  const handle = name();
  const payee = await member(handle, { payable: true, linked: true });
  const accountId = (await pool.query('SELECT id FROM kora_accounts WHERE personal_user_id=$1', [payer.userId])).rows[0].id;
  const settlement = async (to: string) => {
    const settlementId = id('stl');
    await pool.query(`INSERT INTO chain_settlements(id,personal_user_id,account_id,asset_position_id,network,chain_id,direction,
      source_address,destination_address,amount_atomic,required_confirmations,minimum_block_number,idempotency_key,authorization_expires_at)
      VALUES($1,$2,$3,'pos_qiev3_mainnet','qie-mainnet','1990','outbound',$4,$5,1,3,1,$6,now())`,
      [settlementId, payer.userId, accountId, `0x${hex(20)}`, to, hex(8)]);
    return settlementId;
  };
  const stored = async (settlementId: string) =>
    (await pool.query('SELECT recipient_username FROM chain_settlements WHERE id=$1', [settlementId])).rows[0].recipient_username;
  const paid = await settlement(payee.linked);
  assert.equal(await rememberPayee(payer.userId, paid, `@${handle.toUpperCase()}`, payee.linked), handle);
  assert.equal(await stored(paid), handle);
  // A username that points elsewhere, an unknown name, or another user's settlement records nothing.
  const elsewhere = await settlement(`0x${hex(20)}`);
  assert.equal(await rememberPayee(payer.userId, elsewhere, handle, `0x${hex(20)}`), null);
  assert.equal(await rememberPayee(payer.userId, elsewhere, 'nobody_here', payee.linked), null);
  assert.equal(await stored(elsewhere), null);
  const stranger = await member(name());
  await rememberPayee(stranger.userId, paid, handle, payee.linked);
  assert.equal(await stored(paid), handle);
  const overview = await app.inject({ url: '/personal/api/overview', headers: payer.headers });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().activity.find((item: { id: string }) => item.id === paid).to_username, handle);
});
