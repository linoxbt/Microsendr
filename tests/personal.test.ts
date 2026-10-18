import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApi } from '../services/api/src/app.js';
import { id, pool } from '../packages/database/src/index.js';
import { invariantReport } from '../packages/ledger/src/index.js';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { createHmac, randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4310';
const codes = new Map<string,string>();
const app = await buildApi({ serveWeb: false, rateLimitMax: 10000, personal: {
  codeSecret: 'personal-test-only-secret',
  sendCode: async (email, code) => { codes.set(email, code); },
} });
after(async () => { await app.close(); await pool.end(); });
const cookie = (r: { headers: Record<string,unknown> }) => String(r.headers['set-cookie']).split(';')[0];
async function login(email: string) {
  const start = await app.inject({ method: 'POST', url: '/personal/api/auth/start', headers: { origin }, payload: { email } });
  assert.equal(start.statusCode, 200, start.body);
  const verify = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin }, payload: { challenge_id: start.json().challenge_id, code: codes.get(email) } });
  assert.equal(verify.statusCode, 200, verify.body);
  return { cookie: cookie(verify), csrf: verify.json().csrf_token, challenge: start.json().challenge_id, code: codes.get(email) };
}
const write = (auth: { cookie: string; csrf: string }, url: string, payload: object, key?: string) => app.inject({
  method: 'POST', url, headers: { origin, cookie: auth.cookie, 'x-kora-csrf': auth.csrf, ...(key ? { 'idempotency-key': key } : {}) }, payload,
});

test('Personal email OTP is single use, creates a distinct account, and requires sandbox approval', async () => {
  const email = `${id('personal')}@example.test`;
  const auth = await login(email);
  const replay = await app.inject({ method: 'POST', url: '/personal/api/auth/verify', headers: { origin }, payload: { challenge_id: auth.challenge, code: auth.code } });
  assert.equal(replay.statusCode, 401);
  const session = await app.inject({ url: '/personal/api/session', headers: { cookie: auth.cookie } });
  assert.equal(session.json().email, email);
  assert.equal(session.json().kyc_state, 'not_started');
  const before = await write(auth, '/personal/api/sandbox/fund', {});
  assert.equal(before.statusCode, 403);
  const noCsrf = await app.inject({ method: 'POST', url: '/personal/api/sandbox/verify', headers: { origin, cookie: auth.cookie }, payload: { residence_country: 'NG', acknowledge_simulation: true } });
  assert.equal(noCsrf.statusCode, 403);
  const approved = await write(auth, '/personal/api/sandbox/verify', { residence_country: 'NG', acknowledge_simulation: true });
  assert.equal(approved.statusCode, 200, approved.body);
  const funded = await write(auth, '/personal/api/sandbox/fund', {});
  assert.equal(funded.statusCode, 200, funded.body);
  assert.equal((await write(auth, '/personal/api/sandbox/fund', {})).statusCode, 409);
  const home = await app.inject({ url: '/personal/api/home', headers: { cookie: auth.cookie } });
  assert.equal(home.json().balance.available_minor, '10000000');
  assert.equal(home.json().sandbox_funded, true);
});

test('Personal transfer posts once under an idempotency key and cannot overdraw', async () => {
  const senderEmail = `${id('sender')}@example.test`;
  const recipientEmail = `${id('receiver')}@example.test`;
  const sender = await login(senderEmail), recipient = await login(recipientEmail);
  for (const auth of [sender, recipient]) assert.equal((await write(auth, '/personal/api/sandbox/verify', { residence_country: 'NG', acknowledge_simulation: true })).statusCode, 200);
  assert.equal((await write(sender, '/personal/api/sandbox/fund', {})).statusCode, 200);
  const key = id('key'), payload = { recipient_email: recipientEmail, amount_minor: '125000' };
  const first = await write(sender, '/personal/api/transfers', payload, key);
  assert.equal(first.statusCode, 200, first.body);
  const retry = await write(sender, '/personal/api/transfers', payload, key);
  assert.equal(retry.json().id, first.json().id);
  assert.equal((await write(sender, '/personal/api/transfers', { ...payload, amount_minor: '125001' }, key)).statusCode, 409);
  assert.equal((await write(sender, '/personal/api/transfers', { ...payload, amount_minor: '99999999' }, id('key'))).statusCode, 422);
  const senderHome = await app.inject({ url: '/personal/api/home', headers: { cookie: sender.cookie } });
  const receiverHome = await app.inject({ url: '/personal/api/home', headers: { cookie: recipient.cookie } });
  assert.equal(senderHome.json().balance.available_minor, '9875000');
  assert.equal(receiverHome.json().balance.available_minor, '125000');
  const activity = await app.inject({ url: '/personal/api/activity', headers: { cookie: recipient.cookie } });
  assert.equal(activity.json().data.length, 1);
  assert.equal(activity.json().data[0].direction, 'received');
  assert.deepEqual(await invariantReport(), { balanced: true, nonnegative: true, no_empty_journals: true, violations: [] });
});

test('Privy Personal requires a matching signed identity token with verified email', async () => {
  const pair = await generateKeyPair('ES256');
  const appId = 'microsendr-personal-test';
  const configured = await buildApi({ serveWeb: false, rateLimitMax: 10000, privyConfig: { appId, verificationKey: await exportSPKI(pair.publicKey) } });
  try {
    const subject = `did:privy:${id('user')}`, email = `${id('privy')}@example.test`;
    const sign = (sub: string, claims: Record<string, unknown>) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256' }).setIssuer('privy.io').setAudience(appId)
      .setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
    const access_token = await sign(subject, { sid: id('sid') });
    const identity_token = await sign(subject, { linked_accounts: JSON.stringify([{ type: 'email', address: email, lv: Math.floor(Date.now() / 1000) }]) });
    const login = (identity: string) => configured.inject({ method: 'POST', url: '/personal/api/auth/privy', headers: { origin }, payload: { access_token, identity_token: identity } });
    assert.equal((await login(await sign(`did:privy:${id('other')}`, { linked_accounts: JSON.stringify([{ type: 'email', address: email, lv: 1 }]) }))).statusCode, 401);
    assert.equal((await login(await sign(subject, { linked_accounts: JSON.stringify([{ type: 'email', address: email }]) }))).statusCode, 401);
    const first = await login(identity_token);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().email, email);
    assert.match(String(first.headers['set-cookie']), /HttpOnly/);
    const again = await login(identity_token);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().account_id, first.json().account_id);
    const changedEmail = `${id('updated')}@example.test`;
    const changed = await login(await sign(subject, { linked_accounts: JSON.stringify([{ type: 'email', address: changedEmail, lv: Math.floor(Date.now() / 1000) }]) }));
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().account_id, first.json().account_id);
    assert.equal(changed.json().email, changedEmail);
  } finally { await configured.close(); }
});

test('Didit session and signed decisions remain separate from sandbox access', async () => {
  const auth = await login(`${id('didit')}@example.test`);
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.DIDIT_API_KEY;
  const oldSecret = process.env.DIDIT_WEBHOOK_SECRET;
  const providerId = randomUUID();
  process.env.DIDIT_API_KEY = 'test-key-only';
  process.env.DIDIT_WEBHOOK_SECRET = 'test-webhook-secret-only';
  globalThis.fetch = async (input, init) => {
    assert.equal(input, 'https://verification.didit.me/v3/session/');
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'test-key-only');
    const request = JSON.parse(String(init?.body));
    assert.equal(request.workflow_id, '5045382d-f318-4cfe-8439-7b3d097adf63');
    assert.match(request.vendor_data, /^usr_/);
    return new Response(JSON.stringify({ session_id: providerId, url: `https://verify.didit.me/session/${providerId}` }), { status: 201 });
  };
  try {
    assert.equal((await write(auth, '/personal/api/kyc/session', { consent: false })).statusCode, 400);
    const created = await write(auth, '/personal/api/kyc/session', { consent: true });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().session_id, providerId);
    assert.equal((await write(auth, '/personal/api/kyc/session', { consent: true })).statusCode, 409);
    const before = await app.inject({ url: '/personal/api/kyc', headers: { cookie: auth.cookie } });
    assert.equal(before.json().status, 'Not Started');
    const user = (await pool.query('SELECT id FROM personal_users WHERE email=$1', [(await app.inject({ url: '/personal/api/session', headers: { cookie: auth.cookie } })).json().email])).rows[0];
    const send = (event_id: string, status: string, timestamp = Math.floor(Date.now() / 1000), valid = true) => {
      const event = { event_id, session_id: providerId, status, timestamp, vendor_data: user.id };
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
      const signature = valid ? createHmac('sha256', 'test-webhook-secret-only').update(canonical).digest('hex') : '0'.repeat(64);
      return app.inject({ method: 'POST', url: '/personal/api/webhooks/didit', headers: { 'x-signature-v2': signature }, payload: event });
    };
    assert.equal((await send('stale', 'Approved', 1)).statusCode, 401);
    assert.equal((await send('bad', 'Approved', undefined, false)).statusCode, 401);
    assert.equal((await send('approved', 'Approved')).statusCode, 200);
    assert.equal((await send('approved', 'Approved')).statusCode, 200);
    assert.equal((await send('late-progress', 'In Progress')).statusCode, 200);
    assert.equal((await app.inject({ url: '/personal/api/kyc', headers: { cookie: auth.cookie } })).json().status, 'Approved');
    assert.equal((await app.inject({ url: '/personal/api/session', headers: { cookie: auth.cookie } })).json().kyc_state, 'not_started');
    assert.equal((await send('expired', 'Kyc Expired')).statusCode, 200);
    assert.equal((await app.inject({ url: '/personal/api/kyc', headers: { cookie: auth.cookie } })).json().status, 'Kyc Expired');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.DIDIT_API_KEY; else process.env.DIDIT_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.DIDIT_WEBHOOK_SECRET; else process.env.DIDIT_WEBHOOK_SECRET = oldSecret;
  }
});
