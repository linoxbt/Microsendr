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
