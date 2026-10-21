import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApi } from '../services/api/src/app.js';
import { pool, id } from '../packages/database/src/index.js';

const codes = new Map<string, string>();
const app = await buildApi({
  serveWeb: false,
  rateLimitMax: 10000,
  personal: {
    codeSecret: 'consumer-tests-only',
    sendCode: async (email, code) => {
      codes.set(email, code);
    },
  },
});
after(async () => {
  await app.close();
  await pool.end();
});
const origin = 'http://127.0.0.1:4310';
const cookie = (r: any) => String(r.headers['set-cookie']).split(';')[0];
const profile = () => ({
  first_name: 'Ada',
  last_name: 'Okafor',
  username: 'ada_' + randomUUID().slice(0, 8),
  phone: '+2348000000000',
  residence_country: 'NG',
  nationality: 'NG',
  date_of_birth: '1995-05-12',
  address_line1: '14 Example Street',
  address_line2: '',
  city: 'Lagos',
  region: 'Lagos',
  postal_code: '100001',
  occupation: 'Designer',
  display_currency: 'USD',
});
const input = () => ({
  ...profile(),
  email: `${id('consumer')}@example.test`,
  password: 'test-only-password-74638',
});
const write = (auth: any, url: string, payload: any, method: 'POST' | 'PATCH' = 'POST') =>
  app.inject({
    method,
    url,
    headers: { origin, cookie: auth.cookie, 'x-kora-csrf': auth.csrf },
    payload,
  });
async function register(data = input()) {
  const r = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/register',
    headers: { origin },
    payload: data,
  });
  assert.equal(r.statusCode, 200, r.body);
  return { cookie: cookie(r), csrf: r.json().csrf_token, data };
}
async function login(data: any) {
  return app.inject({
    method: 'POST',
    url: '/personal/api/auth/password',
    headers: { origin },
    payload: { email: data.email, password: data.password },
  });
}

test('custom registration persists profile, hashes password and never grants verification or test funds', async () => {
  const auth = await register();
  const result = await app.inject({
    url: '/personal/api/profile',
    headers: { cookie: auth.cookie },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.json().username, auth.data.username);
  assert.equal(result.json().email_verified_at, null);
  assert.equal(result.json().phone_verified_at, null);
  assert.equal(result.json().identity_status, 'Not Started');
  const identity = await write(auth, '/personal/api/kyc/session', { consent: true });
  assert.equal(identity.statusCode, 403);
  assert.equal(identity.json().error.code, 'verified_email_required');
  assert.equal(result.json().date_of_birth, auth.data.date_of_birth);
  assert.equal(result.json().password_hash, undefined);
  const user = (
    await pool.query('SELECT id,password_hash,kyc_state FROM personal_users WHERE email=$1', [
      auth.data.email,
    ])
  ).rows[0];
  assert.match(user.password_hash, /^scrypt2:131072:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.ok(!user.password_hash.includes(auth.data.password));
  assert.equal(user.kyc_state, 'not_started');
  const overview = (
    await app.inject({ url: '/personal/api/overview', headers: { cookie: auth.cookie } })
  ).json();
  assert.deepEqual(overview.balances, []);
  assert.equal(overview.total, null);
  assert.equal(overview.capabilities.conversion.available, false);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM personal_sandbox_funding WHERE personal_user_id=$1', [
        user.id,
      ])
    ).rowCount,
    0,
  );
  const signed = await login(auth.data);
  assert.equal(signed.statusCode, 200, signed.body);
  const rejected = await login({ ...auth.data, password: 'wrong-password' });
  assert.equal(rejected.statusCode, 401);
});

test('profile edits are owner scoped, versioned, CSRF protected and preserve verification separation', async () => {
  const a = await register(),
    b = await register();
  const update = {
    ...profile(),
    username: a.data.username,
    first_name: 'Amara',
    profile_version: 1,
  };
  const noCsrf = await app.inject({
    method: 'PATCH',
    url: '/personal/api/profile',
    headers: { origin, cookie: a.cookie },
    payload: update,
  });
  assert.equal(noCsrf.statusCode, 403);
  const injected = await write(
    a,
    '/personal/api/profile',
    { ...update, kyc_state: 'verified' },
    'PATCH',
  );
  assert.equal(injected.statusCode, 400);
  assert.equal((await write(a, '/personal/api/profile', update, 'PATCH')).statusCode, 200);
  assert.equal((await write(a, '/personal/api/profile', update, 'PATCH')).statusCode, 409);
  const read = async (auth: any) =>
    (await app.inject({ url: '/personal/api/profile', headers: { cookie: auth.cookie } })).json();
  assert.equal((await read(a)).first_name, 'Amara');
  assert.equal((await read(b)).first_name, 'Ada');
  assert.equal((await read(a)).identity_status, 'Not Started');
  const user = (await pool.query('SELECT id FROM personal_users WHERE email=$1', [a.data.email]))
    .rows[0];
  await pool.query(
    "INSERT INTO personal_didit_sessions(id,personal_user_id,provider_session_id,status) VALUES($1,$2,$3,'Approved')",
    [id('kyc'), user.id, randomUUID()],
  );
  assert.equal((await read(a)).identity_locked, true);
  const change = await write(
    a,
    '/personal/api/profile',
    { ...update, profile_version: 2, first_name: 'Changed' },
    'PATCH',
  );
  assert.equal(change.statusCode, 409);
  const preference = await write(
    a,
    '/personal/api/profile',
    { ...update, profile_version: 2, display_currency: 'NGN' },
    'PATCH',
  );
  assert.equal(preference.statusCode, 200, preference.body);
});

test('password rotation revokes every other session and refuses CSRF or wrong old password', async () => {
  const auth = await register();
  const second = await login(auth.data);
  const rejected = await write(auth, '/personal/api/profile/password', {
    current_password: 'incorrect',
    password: 'new-test-password-56789',
  });
  assert.equal(rejected.statusCode, 401);
  const changed = await write(auth, '/personal/api/profile/password', {
    current_password: auth.data.password,
    password: 'new-test-password-56789',
  });
  assert.equal(changed.statusCode, 200, changed.body);
  for (const value of [auth.cookie, cookie(second)])
    assert.equal(
      (await app.inject({ url: '/personal/api/session', headers: { cookie: value } })).json()
        .authenticated,
      false,
    );
  assert.equal(
    (
      await app.inject({ url: '/personal/api/session', headers: { cookie: cookie(changed) } })
    ).json().authenticated,
    true,
  );
  assert.equal((await login(auth.data)).statusCode, 401);
  assert.equal(
    (await login({ ...auth.data, password: 'new-test-password-56789' })).statusCode,
    200,
  );
});

test('claiming an unverified email revokes planted credentials and permits password recovery only after email proof', async () => {
  const auth = await register();
  const start = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/start',
    headers: { origin },
    payload: { email: auth.data.email },
  });
  assert.equal(start.statusCode, 200, start.body);
  const verify = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/verify',
    headers: { origin },
    payload: { challenge_id: start.json().challenge_id, code: codes.get(auth.data.email) },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(
    (await app.inject({ url: '/personal/api/session', headers: { cookie: auth.cookie } })).json()
      .authenticated,
    false,
  );
  assert.equal((await login(auth.data)).statusCode, 401);
  const owner = { cookie: cookie(verify), csrf: verify.json().csrf_token };
  const set = await write(owner, '/personal/api/profile/password', {
    password: 'owner-recovered-password-6723',
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(
    (await login({ ...auth.data, password: 'owner-recovered-password-6723' })).statusCode,
    200,
  );
});

test('payment availability cannot fabricate a quote or expose simulated money', async () => {
  // Reuse an OTP account with an actual test ledger balance to prove it is excluded.
  const email = `${id('old')}@example.test`;
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[id('usr'),email]);
  const start = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/start',
    headers: { origin },
    payload: { email },
  });
  const verified = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/verify',
    headers: { origin },
    payload: { challenge_id: start.json().challenge_id, code: codes.get(email) },
  });
  const auth = { cookie: cookie(verified), csrf: verified.json().csrf_token };
  assert.equal(
    (
      await write(auth, '/personal/api/sandbox/verify', {
        residence_country: 'NG',
        acknowledge_simulation: true,
      })
    ).statusCode,
    200,
  );
  assert.equal((await write(auth, '/personal/api/sandbox/fund', {})).statusCode, 200);
  const overview = (
    await app.inject({ url: '/personal/api/overview', headers: { cookie: auth.cookie } })
  ).json();
  assert.equal(overview.total, null);
  assert.deepEqual(overview.balances, []);
  for (const [source, destination] of [
    ['USD', 'NGN'],
    ['NGN', 'USD'],
  ]) {
    const quote = await write(auth, '/personal/api/conversion/quotes', {
      source,
      destination,
      amount: '100.00',
    });
    assert.equal(quote.statusCode, 503);
    assert.equal(quote.json().error.code, 'route_unavailable');
  }
  assert.equal((await app.inject({ url: '/personal/api/profile' })).statusCode, 401);
});
