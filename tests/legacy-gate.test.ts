import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../packages/database/src/index.js';
import { buildApi } from '../services/api/src/app.js';

after(async () => { await pool.end(); });

test('the retired business platform is unreachable when switched off (the production default)', async () => {
  const previous = process.env.KORA_LEGACY_PLATFORM;
  process.env.KORA_LEGACY_PLATFORM = 'false';
  const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  try {
    const origin = 'http://127.0.0.1:4310';
    for (const [method, url] of [['GET', '/v1/me'], ['GET', '/v1/assets'], ['POST', '/console/workspaces'], ['GET', '/console/session'],
      ['GET', '/console/auth/config'], ['POST', '/business/api/auth/start'], ['POST', '/business/api/sandbox/verify'], ['GET', '/openapi.json'],
      ['GET', '/reference'], ['GET', '/reference/static/index.html'], ['POST', '/internal/providers/fake/callback'], ['GET', '/v1/me?x=1']] as const) {
      const response = await app.inject({ method, url, headers: { origin, 'content-type': 'application/json' }, payload: method === 'POST' ? '{}' : undefined });
      assert.equal(response.statusCode, 404, `${method} ${url}: ${response.body}`);
    }
    // Percent-encoded spellings reach the same routes, so they are refused the same way.
    for (const url of ['/%761/me', '/%6fpenapi.json', '/%63onsole/auth/config', '/%62usiness/api/auth/start', '/%76%31/assets', '/v1%2Fme'])
      assert.equal((await app.inject({ url })).statusCode, 404, url);
    // Nothing was created by the attempted workspace provisioning.
    const health = await app.inject({ url: '/health' });
    assert.deepEqual([health.statusCode, health.json().service], [200, 'roots-api']);
    assert.equal((await app.inject({ url: '/personal/api/session' })).statusCode, 200);
    // Paths that only share a prefix are not caught.
    assert.notEqual((await app.inject({ url: '/personal/api/v1-like' })).statusCode, 500);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.KORA_LEGACY_PLATFORM; else process.env.KORA_LEGACY_PLATFORM = previous;
  }
});

test('with proxy signatures required, browser routes need the web proxy; webhooks and health stay open', async () => {
  const { SignJWT } = await import('jose');
  const previous = { required: process.env.KORA_REQUIRE_PROXY_SIGNATURE, secret: process.env.KORA_PROXY_SIGNING_SECRET };
  process.env.KORA_REQUIRE_PROXY_SIGNATURE = 'true';
  process.env.KORA_PROXY_SIGNING_SECRET = 'proxy-signing-secret-for-tests';
  const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  try {
    const direct = await app.inject({ url: '/personal/api/session' });
    assert.deepEqual([direct.statusCode, direct.json().error.code], [403, 'proxy_required']);
    for (const url of ['/%70ersonal/api/session', '/personal/%61pi/session', '/personal/api/%73ession', '/personal/api/webhooks/../session'])
      assert.equal((await app.inject({ url })).statusCode, 403, url);
    assert.equal((await app.inject({ url: '/%E0%A4%A' })).statusCode, 400);
    const forged = await app.inject({ url: '/personal/api/session', headers: { 'x-nf-sign': 'not-a-jws', 'x-nf-client-connection-ip': '1.2.3.4' } });
    assert.equal(forged.statusCode, 403);
    const sign = (secret: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer('netlify').setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    assert.equal((await app.inject({ url: '/personal/api/session', headers: { 'x-nf-sign': await sign('another-secret') } })).statusCode, 403);
    const proxied = await app.inject({ url: '/personal/api/session', headers: { 'x-nf-sign': await sign('proxy-signing-secret-for-tests') } });
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.deepEqual((await app.inject({ url: '/personal/api/health', headers: { 'x-nf-sign': await sign('proxy-signing-secret-for-tests') } })).json(),
      { status: 'ok', via_signed_proxy: true });
    assert.deepEqual((await app.inject({ url: '/personal/api/health' })).json(), { status: 'ok', via_signed_proxy: false });
    // Webhooks carry their own signatures: they reach the route (and fail its own check).
    assert.equal((await app.inject({ method: 'POST', url: '/personal/api/webhooks/fonbnk', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  } finally {
    await app.close();
    for (const [name, value] of [['KORA_REQUIRE_PROXY_SIGNATURE', previous.required], ['KORA_PROXY_SIGNING_SECRET', previous.secret]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('the config report names missing settings without their values', async () => {
  const { configReport } = await import('../services/api/src/config.js');
  const saved = { ...process.env };
  try {
    process.env.KORA_AUTH_SECRET = 'short';
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.SMTP_FROM; delete process.env.SMTP_HOST;
    const report = configReport();
    assert.equal(report.ready, false);
    assert.ok(report.missing.includes('KORA_AUTH_SECRET'));
    assert.ok(report.missing.includes('email (RESEND_API_KEY and EMAIL_FROM)'));
    assert.ok(!JSON.stringify(report).includes('short'));
    process.env.KORA_AUTH_SECRET = 'x'.repeat(40); process.env.RESEND_API_KEY = 're_test'; process.env.EMAIL_FROM = 'Roots <codes@example.test>';
    assert.deepEqual(configReport().missing, []);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
