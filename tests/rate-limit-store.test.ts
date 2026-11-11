import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pool } from '../packages/database/src/index.js';
import { buildApi } from '../services/api/src/app.js';

after(async () => { await pool.end(); });

test('with the shared store, two API instances count against one limit', async () => {
  const previous = process.env.KORA_RATE_LIMIT_STORE;
  process.env.KORA_RATE_LIMIT_STORE = 'postgres';
  const a = await buildApi({ serveWeb: false, rateLimitMax: 3 });
  const b = await buildApi({ serveWeb: false, rateLimitMax: 3 });
  try {
    const remoteAddress = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const hit = (app: typeof a) => app.inject({ url: '/personal/api/session', remoteAddress });
    assert.equal((await hit(a)).statusCode, 200);
    assert.equal((await hit(b)).statusCode, 200);
    assert.equal((await hit(a)).statusCode, 200);
    // The fourth request in the window is refused, whichever instance receives it.
    const limited = await hit(b);
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    // A different client is unaffected; an expired window starts again.
    assert.equal((await a.inject({ url: '/personal/api/session', remoteAddress: '10.250.250.250' })).statusCode, 200);
    await pool.query("UPDATE rate_limit_hits SET window_ends=now()-interval '1 second' WHERE key LIKE $1", [`%${remoteAddress}%`]);
    assert.equal((await hit(a)).statusCode, 200);
  } finally {
    await a.close(); await b.close();
    if (previous === undefined) delete process.env.KORA_RATE_LIMIT_STORE; else process.env.KORA_RATE_LIMIT_STORE = previous;
  }
});
