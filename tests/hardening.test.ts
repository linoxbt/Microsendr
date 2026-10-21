import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { buildApi } from '../services/api/src/app.js';
import { authSecret } from '../services/api/src/config.js';
import { reconcileOneDiditSession } from '../services/api/src/didit.js';
import { id, pool } from '../packages/database/src/index.js';

const codes = new Map<string, string>();
const app = await buildApi({
  serveWeb: false,
  rateLimitMax: 10000,
  personal: { codeSecret: 'hardening-tests-only', sendCode: async (email, code) => { codes.set(email, code); } },
});
after(async () => {
  await app.close();
  await pool.end();
});
const origin = 'http://127.0.0.1:4310';
const cookie = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];
const profile = () => ({
  first_name: 'Ada', last_name: 'Okafor', username: 'ada_' + randomUUID().slice(0, 8), phone: '+2348000000000',
  residence_country: 'NG', nationality: 'NG', date_of_birth: '1995-05-12', address_line1: '14 Example Street',
  address_line2: '', city: 'Lagos', region: 'Lagos', postal_code: '100001', occupation: 'Designer', display_currency: 'USD',
});
async function register() {
  const data = { ...profile(), email: `${id('hard')}@example.test`, password: 'hardening-password-48213' };
  // Registration is limited per client, so each fixture account uses its own address.
  const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const r = await app.inject({ method: 'POST', url: '/personal/api/auth/register', headers: { origin, 'x-forwarded-for': ip }, payload: data });
  assert.equal(r.statusCode, 200, r.body);
  return { cookie: cookie(r), csrf: r.json().csrf_token as string, data };
}
const login = (email: string, password: string, ip = '203.0.113.10') => app.inject({
  method: 'POST', url: '/personal/api/auth/password', headers: { origin, 'x-forwarded-for': ip }, payload: { email, password },
});

test('rate limits key on the proxy-reported client and ignore an unsigned Netlify client header', async () => {
  const limited = await buildApi({ serveWeb: false, rateLimitMax: 2 });
  const previous = process.env.KORA_PROXY_SIGNING_SECRET;
  process.env.KORA_PROXY_SIGNING_SECRET = 'proxy-signing-secret-for-tests-only';
  try {
    const hit = (headers: Record<string, string>) => limited.inject({ url: '/health', headers });
    // Spoofed client headers without a valid signature share the transport identity.
    for (const ip of ['198.51.100.1', '198.51.100.2']) assert.equal((await hit({ 'x-forwarded-for': '192.0.2.9', 'x-nf-client-connection-ip': ip })).statusCode, 200);
    assert.equal((await hit({ 'x-forwarded-for': '192.0.2.9', 'x-nf-client-connection-ip': '198.51.100.3' })).statusCode, 429);
    // Another client behind the trusted proxy has its own allowance.
    assert.equal((await hit({ 'x-forwarded-for': '192.0.2.10' })).statusCode, 200);
    // A signed Netlify request is attributed to the reported client.
    const signed = await new SignJWT({ site_url: 'https://example.test' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('netlify').setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.KORA_PROXY_SIGNING_SECRET));
    assert.equal((await hit({ 'x-forwarded-for': '192.0.2.9', 'x-nf-client-connection-ip': '198.51.100.4', 'x-nf-sign': signed })).statusCode, 200);
  } finally {
    if (previous === undefined) delete process.env.KORA_PROXY_SIGNING_SECRET; else process.env.KORA_PROXY_SIGNING_SECRET = previous;
    await limited.close();
  }
});

test('failed passwords from one client cannot lock the owner out from another', async () => {
  const auth = await register();
  for (let attempt = 0; attempt < 11; attempt++) await login(auth.data.email, 'wrong-password-value', '203.0.113.66');
  assert.equal((await login(auth.data.email, 'wrong-password-value', '203.0.113.66')).statusCode, 429);
  assert.equal((await login(auth.data.email, auth.data.password, '203.0.113.77')).statusCode, 200);
});

test('legacy password hashes still verify and are upgraded on login', async () => {
  const auth = await register();
  const { scrypt } = await import('node:crypto');
  const legacy = await new Promise<string>((resolve, reject) => scrypt(auth.data.password, 'legacysalt', 64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(`scrypt:legacysalt:${key.toString('hex')}`)));
  await pool.query('UPDATE personal_users SET password_hash=$2 WHERE email=$1', [auth.data.email, legacy]);
  assert.equal((await login(auth.data.email, auth.data.password)).statusCode, 200);
  const stored = (await pool.query('SELECT password_hash FROM personal_users WHERE email=$1', [auth.data.email])).rows[0].password_hash;
  assert.match(stored, /^scrypt2:131072:/);
  assert.equal((await login(auth.data.email, auth.data.password)).statusCode, 200);
});

test('email codes sign in to existing accounts only, without revealing which emails exist', async () => {
  const email = `${id('unknown')}@example.test`;
  const start = await app.inject({ method: 'POST', url: '/personal/api/auth/start', headers: { origin }, payload: { email } });
  assert.equal(start.statusCode, 200);
  assert.deepEqual(Object.keys(start.json()).sort(), ['challenge_id', 'sent']);
  assert.equal(codes.has(email), false);
  for (const code of ['000000', '123456']) {
    const verify = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin }, payload: { challenge_id: start.json().challenge_id, code } });
    assert.equal(verify.statusCode, 401);
  }
  assert.equal((await pool.query('SELECT 1 FROM personal_users WHERE email=$1', [email])).rowCount, 0);
});

test('the signed-in owner verifying their email keeps their password; anyone else resets it', async () => {
  const owner = await register();
  const start = await app.inject({ method: 'POST', url: '/personal/api/auth/start', headers: { origin }, payload: { email: owner.data.email } });
  const verify = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin, cookie: owner.cookie },
    payload: { challenge_id: start.json().challenge_id, code: codes.get(owner.data.email) } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal((await login(owner.data.email, owner.data.password)).statusCode, 200);
  assert.ok((await pool.query('SELECT email_verified_at FROM personal_users WHERE email=$1', [owner.data.email])).rows[0].email_verified_at);

  const squatted = await register();
  const claim = await app.inject({ method: 'POST', url: '/personal/api/auth/start', headers: { origin }, payload: { email: squatted.data.email } });
  const claimed = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin },
    payload: { challenge_id: claim.json().challenge_id, code: codes.get(squatted.data.email) } });
  assert.equal(claimed.statusCode, 200);
  assert.equal((await login(squatted.data.email, squatted.data.password)).statusCode, 401);
  assert.equal((await app.inject({ url: '/personal/api/session', headers: { cookie: squatted.cookie } })).json().authenticated, false);
});

test('sign-out always clears the cookie, and requires an allowed origin', async () => {
  const expired = await app.inject({ method: 'POST', url: '/personal/api/logout', headers: { origin, cookie: `kora_personal=${'a'.repeat(64)}` } });
  assert.equal(expired.statusCode, 200);
  assert.match(String(expired.headers['set-cookie']), /kora_personal=;/);
  assert.equal((await app.inject({ method: 'POST', url: '/personal/api/logout', headers: { origin: 'https://evil.example' } })).statusCode, 403);
  const auth = await register();
  assert.equal((await app.inject({ method: 'POST', url: '/personal/api/logout', headers: { origin, cookie: auth.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/personal/api/session', headers: { cookie: auth.cookie } })).json().authenticated, false);
});

test('sandbox fixtures are absent when disabled and require a verified email when enabled', async () => {
  const production = await buildApi({ serveWeb: false, rateLimitMax: 10000, personal: { codeSecret: 'x'.repeat(32), sendCode: async () => {}, sandboxFixtures: false } });
  try {
    const auth = await register();
    for (const url of ['/personal/api/sandbox/verify', '/personal/api/sandbox/fund', '/personal/api/transfers', '/personal/api/paystack/collections'])
      assert.equal((await production.inject({ method: 'POST', url, headers: { origin, cookie: auth.cookie, 'x-kora-csrf': auth.csrf }, payload: {} })).statusCode, 404, url);
    assert.equal((await production.inject({ url: '/personal/api/home', headers: { cookie: auth.cookie } })).statusCode, 404);
  } finally { await production.close(); }
  const unverified = await register();
  const denied = await app.inject({ method: 'POST', url: '/personal/api/sandbox/verify', headers: { origin, cookie: unverified.cookie, 'x-kora-csrf': unverified.csrf },
    payload: { residence_country: 'NG', acknowledge_simulation: true } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'verified_email_required');
});

test('wallet listing never provisions; explicit provisioning reports an unconfigured provider', async () => {
  const auth = await register();
  const previousFetch = globalThis.fetch, previousId = process.env.PRIVY_APP_ID;
  delete process.env.PRIVY_APP_ID;
  globalThis.fetch = async () => { throw new Error('wallet listing must not call a provider'); };
  try {
    const listed = await app.inject({ url: '/personal/api/wallets', headers: { cookie: auth.cookie } });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().data, []);
    const provision = await app.inject({ method: 'POST', url: '/personal/api/wallets/managed', headers: { origin, cookie: auth.cookie, 'x-kora-csrf': auth.csrf }, payload: {} });
    assert.equal(provision.statusCode, 503);
    assert.equal(provision.json().error.code, 'wallet_provisioning_unconfigured');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId !== undefined) process.env.PRIVY_APP_ID = previousId;
  }
});

test('Didit webhooks without an event id are deduplicated, and missed decisions are fetched', async () => {
  const userId = id('usr'), providerId = randomUUID(), recordId = id('kyc');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,now())', [userId, `${userId}@example.test`]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [id('acct'), userId]);
  await pool.query("INSERT INTO personal_didit_sessions(id,personal_user_id,provider_session_id,status) VALUES($1,$2,$3,'Not Started')", [recordId, userId, providerId]);
  const previous = { key: process.env.DIDIT_API_KEY, secret: process.env.DIDIT_WEBHOOK_SECRET };
  process.env.DIDIT_API_KEY = 'didit-test-key';
  process.env.DIDIT_WEBHOOK_SECRET = 'didit-test-secret';
  try {
    const event = { session_id: providerId, status: 'In Review', timestamp: Math.floor(Date.now() / 1000), vendor_data: userId };
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a < b ? -1 : 1)));
    const signature = createHmac('sha256', 'didit-test-secret').update(canonical).digest('hex');
    for (let delivery = 0; delivery < 2; delivery++) {
      const r = await app.inject({ method: 'POST', url: '/personal/api/webhooks/didit', headers: { 'x-signature-v2': signature }, payload: event });
      assert.equal(r.statusCode, 200, r.body);
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM personal_didit_events WHERE provider_session_id=$1', [providerId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT status FROM personal_didit_sessions WHERE id=$1', [recordId])).rows[0].status, 'In Review');
    // The approval webhook is lost; the worker fetches the decision once the session is stale.
    await pool.query("UPDATE personal_didit_sessions SET updated_at=now()-interval '1 hour' WHERE status='In Review' AND updated_at<now()");
    const requested: string[] = [];
    let reconciled = true;
    while (reconciled) reconciled = await reconcileOneDiditSession(async (url, init) => {
      requested.push(String(url));
      assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'didit-test-key');
      return Response.json({ status: String(url).includes(providerId) ? 'Approved' : 'In Review' });
    });
    assert.ok(requested.includes(`https://verification.didit.me/v3/session/${providerId}/decision/`));
    assert.equal((await pool.query('SELECT status FROM personal_didit_sessions WHERE id=$1', [recordId])).rows[0].status, 'Approved');
  } finally {
    for (const [name, value] of [['DIDIT_API_KEY', previous.key], ['DIDIT_WEBHOOK_SECRET', previous.secret]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('the email code secret must be at least 32 bytes', () => {
  const previous = process.env.KORA_AUTH_SECRET;
  try {
    process.env.KORA_AUTH_SECRET = 'short';
    assert.throws(() => authSecret(), /at least 32 bytes/);
    process.env.KORA_AUTH_SECRET = 'k'.repeat(32);
    assert.equal(authSecret(), 'k'.repeat(32));
    delete process.env.KORA_AUTH_SECRET;
    assert.equal(authSecret(), undefined);
  } finally {
    if (previous === undefined) delete process.env.KORA_AUTH_SECRET; else process.env.KORA_AUTH_SECRET = previous;
  }
});

test('outbox jobs are parked after consecutive failures only', async () => {
  const { runRailOnce } = await import('../packages/rails/src/index.js');
  const { PaystackClient } = await import('../connectors/paystack/src/index.js');
  const client = new PaystackClient({ secretKey: 'sk_test_hardeningparkedjobs000000', fetch: async () => { throw new Error('no provider call expected'); } });
  const job = id('obx'), resource = id('col');
  // Many earlier polls (attempts) but one failure short of the limit.
  await pool.query("INSERT INTO outbox(id,kind,resource_id,attempts,failures) VALUES($1,'collection_verify',$2,40,23)", [job, resource]);
  assert.equal(await runRailOnce({ client, onlyResource: resource }), true);
  let row = (await pool.query('SELECT failures,dead_at,last_error FROM outbox WHERE id=$1', [job])).rows[0];
  assert.deepEqual([row.failures, row.dead_at, row.last_error], [24, null, 'collection_not_found']);
  await pool.query('UPDATE outbox SET available_at=now() WHERE id=$1', [job]);
  await runRailOnce({ client, onlyResource: resource });
  row = (await pool.query('SELECT failures,dead_at FROM outbox WHERE id=$1', [job])).rows[0];
  assert.equal(row.failures, 25);
  assert.ok(row.dead_at);
  await pool.query('UPDATE outbox SET available_at=now() WHERE id=$1', [job]);
  assert.equal(await runRailOnce({ client, onlyResource: resource }), false);
});
