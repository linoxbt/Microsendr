import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApi } from '../services/api/src/app.js';
import { pool, id } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';

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
async function register(data = input(), remoteAddress?: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/personal/api/auth/register',
    ...(remoteAddress ? { remoteAddress } : {}),
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
  // Changed with the old password: sends are not held.
  const hold = (await pool.query('SELECT send_hold_until FROM personal_users WHERE email=$1', [auth.data.email])).rows[0];
  assert.equal(hold.send_hold_until, null);
});

test('replacing a password with only an email code holds account-wallet sends for a day', async () => {
  const auth = await register(input(), '10.66.0.2');
  await pool.query('UPDATE personal_users SET email_verified_at=now() WHERE email=$1', [auth.data.email]);
  const start = await app.inject({ method: 'POST', url: '/personal/api/auth/start', headers: { origin }, payload: { email: auth.data.email }, remoteAddress: '10.66.0.1' });
  assert.equal(start.statusCode, 200, start.body);
  const verify = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin },
    payload: { challenge_id: start.json().challenge_id, code: codes.get(auth.data.email) }, remoteAddress: '10.66.0.1' });
  assert.equal(verify.statusCode, 200, verify.body);
  const reset = await write({ cookie: cookie(verify), csrf: verify.json().csrf_token }, '/personal/api/profile/password', {
    password: 'recovered-password-8812',
  });
  assert.equal(reset.statusCode, 200, reset.body);
  const until = (await pool.query('SELECT send_hold_until FROM personal_users WHERE email=$1', [auth.data.email])).rows[0].send_hold_until;
  assert.ok(until && new Date(until).getTime() > Date.now() + 23 * 3600_000);
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
  // Without provider credentials there is no route, so no quote can be fabricated.
  assert.equal(overview.capabilities.conversion.available, false);
  const quote = await write(auth, '/personal/api/conversion/quote', { direction: 'buy', asset: 'POLYGON_USDC', amount: 10000 });
  assert.equal(quote.statusCode, 503);
  assert.equal(quote.json().error.code, 'conversion_unavailable');
  assert.equal((await app.inject({ url: '/personal/api/profile' })).statusCode, 401);
});

test('a new code replaces the old one, and wrong codes are capped per email across codes', async () => {
  const email = `${id('codes')}@example.test`;
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2)', [id('usr'), email]);
  const remoteAddress = '10.20.0.1';
  const start = () => app.inject({ method: 'POST', url: '/personal/api/auth/start', remoteAddress, headers: { origin }, payload: { email } });
  const verify = (challenge_id: string, code: string) =>
    app.inject({ method: 'POST', url: '/personal/api/auth/verify', remoteAddress: '10.20.0.2', headers: { origin }, payload: { challenge_id, code } });
  const age = () => pool.query("UPDATE personal_email_challenges SET created_at=created_at-interval '61 seconds' WHERE email=$1", [email]);
  const first = await start();
  const firstCode = codes.get(email)!;
  await age();
  const second = await start();
  // The first code no longer works once a second was issued.
  assert.equal((await verify(first.json().challenge_id, firstCode)).statusCode, 401);
  // Ten wrong guesses across codes block the email for an hour, even with the right code.
  const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  for (let i = 0; i < 5; i++) await verify(second.json().challenge_id, wrong(codes.get(email)!));
  await age();
  const third = await start();
  for (let i = 0; i < 5; i++) await verify(third.json().challenge_id, wrong(codes.get(email)!));
  await age();
  const fourth = await start();
  const blocked = await verify(fourth.json().challenge_id, codes.get(email)!);
  assert.equal(blocked.statusCode, 429, blocked.body);
  // Five codes an hour at most.
  await age();
  assert.equal((await start()).statusCode, 200);
  await age();
  const sixth = await app.inject({ method: 'POST', url: '/personal/api/auth/start', remoteAddress: '10.20.0.3', headers: { origin }, payload: { email } });
  assert.equal(sixth.json().error.code, 'code_recently_sent');
});

test('the account-wide login cap does not lock out a browser that signed in before', async () => {
  const auth = await register(input(), '10.30.1.1');
  const remoteAddress = '10.30.0.1';
  const login = (data: { email: string; password: string }) => app.inject({ method: 'POST', url: '/personal/api/auth/password', remoteAddress,
    headers: { origin }, payload: { email: data.email, password: data.password } });
  const good = await login(auth.data);
  assert.equal(good.statusCode, 200, good.body);
  const device = String(good.headers['set-cookie']).match(/roots_device=([a-f0-9]{64})/)?.[1];
  assert.ok(device, 'a known-device cookie is set on sign-in');
  // Simulate a distributed attack that exhausted the account-wide cap.
  await pool.query(`INSERT INTO personal_auth_limits(email_hash,failures) VALUES($1,500)
    ON CONFLICT(email_hash) DO UPDATE SET failures=500, window_started_at=now()`, [hashKey(`${auth.data.email}|*`)]);
  const stranger = await login(auth.data);
  assert.equal(stranger.statusCode, 429);
  const owner = await app.inject({ method: 'POST', url: '/personal/api/auth/password', remoteAddress: '10.30.0.2', headers: { origin, cookie: `roots_device=${device}` },
    payload: { email: auth.data.email, password: auth.data.password } });
  assert.equal(owner.statusCode, 200, owner.body);
  // A device cookie for another account does not help.
  const other = await register(input(), '10.30.1.2');
  const otherDevice = await app.inject({ method: 'POST', url: '/personal/api/auth/password', remoteAddress: '10.30.0.2', headers: { origin, cookie: `roots_device=${device}` },
    payload: { email: other.data.email, password: other.data.password } });
  assert.equal(otherDevice.statusCode, 200);
  await pool.query(`INSERT INTO personal_auth_limits(email_hash,failures) VALUES($1,500)
    ON CONFLICT(email_hash) DO UPDATE SET failures=500, window_started_at=now()`, [hashKey(`${other.data.email}|*`)]);
  const crossDevice = await app.inject({ method: 'POST', url: '/personal/api/auth/password', remoteAddress: '10.30.0.2', headers: { origin, cookie: `roots_device=${device}` },
    payload: { email: other.data.email, password: other.data.password } });
  assert.equal(crossDevice.statusCode, 429);
});
