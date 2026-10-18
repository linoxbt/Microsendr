import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApi } from '../services/api/src/app.js';
import { pool, id } from '../packages/database/src/index.js';
import { createMerchant, invariantReport } from '../packages/ledger/src/index.js';
import { issueApiKey } from '../packages/payments/src/auth.js';
import { runOnce } from '../services/worker/src/worker.js';
import { models, contracts } from '../packages/contracts/src/index.js';
import { Microsendr, MicrosendrError } from '../sdks/typescript/src/index.js';
process.env.KORA_WEBHOOK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});
async function fixture(scopes?: Parameters<typeof issueApiKey>[2]) {
  const merchant = id('test');
  await createMerchant(merchant, 'Product test');
  const key = await issueApiKey(merchant, 'Administrator', scopes);
  const app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  apps.push(app);
  const headers = { authorization: `Bearer ${key.secret}` };
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: Record<string, unknown>, idem = id('idem')) =>
    app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': idem }, payload });
  return { merchant, key, app, headers, get, post };
}
const origin = 'http://127.0.0.1:4310';
test('console sessions exchange keys for HttpOnly cookies, enforce origin and CSRF, and honor revocation', async () => {
  const f = await fixture();
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/console/session',
        headers: { origin: 'https://foreign.test' },
        payload: { api_key: f.key.secret },
      })
    ).statusCode,
    403,
  );
  const login = await f.app.inject({
    method: 'POST',
    url: '/console/session',
    headers: { origin },
    payload: { api_key: f.key.secret },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.body.includes(f.key.secret), false);
  const cookie = String(login.headers['set-cookie']).split(';')[0],
    csrf = login.json().csrf_token;
  assert.match(String(login.headers['set-cookie']), /HttpOnly/);
  assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
  assert.equal((await f.app.inject({ url: '/v1/me', headers: { cookie } })).json().id, f.merchant);
  for (const token of ['', 'é'.repeat(64), '0'.repeat(64)])
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/customers',
          headers: { cookie, origin, 'x-kora-csrf': token, 'idempotency-key': id('idem') },
          payload: { name: 'Blocked' },
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: { cookie, origin, 'x-kora-csrf': csrf, 'idempotency-key': id('idem') },
        payload: { name: 'Session recipient' },
      })
    ).statusCode,
    201,
  );
  await pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [f.key.id]);
  assert.equal((await f.app.inject({ url: '/v1/me', headers: { cookie } })).statusCode, 401);
  assert.equal(
    (await f.app.inject({ url: '/console/session', headers: { cookie } })).json().authenticated,
    false,
  );
});
test('console logout invalidates the session and cookie', async () => {
  const f = await fixture();
  const r = await f.app.inject({
    method: 'POST',
    url: '/console/session',
    headers: { origin },
    payload: { api_key: f.key.secret },
  });
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const result = await f.app.inject({
    method: 'POST',
    url: '/console/logout',
    headers: { origin, cookie, 'x-kora-csrf': r.json().csrf_token },
  });
  assert.equal(result.statusCode, 200);
  assert.equal((await f.app.inject({ url: '/v1/me', headers: { cookie } })).statusCode, 401);
});
test('scoped API keys are replayable, hashed, encrypted in cache and revocable without exposing list secrets', async () => {
  const f = await fixture(),
    input = { name: 'Reader', scopes: ['payments:read'] };
  const a = await f.post('/v1/api_keys', input, 'new-key'),
    b = await f.post('/v1/api_keys', input, 'new-key');
  assert.equal(a.statusCode, 201, a.body);
  assert.deepEqual(a.json(), b.json());
  const key = a.json();
  assert.equal((await f.get('/v1/api_keys')).body.includes(key.secret), false);
  const stored = (await pool.query('SELECT hash FROM api_keys WHERE id=$1', [key.id])).rows[0];
  assert.equal(stored.hash.includes(key.secret), false);
  const cached = (
    await pool.query('SELECT response FROM idempotency WHERE merchant_id=$1 AND key=$2', [
      f.merchant,
      'new-key',
    ])
  ).rows[0];
  assert.equal(JSON.stringify(cached).includes(key.secret), false);
  assert.equal((await f.post(`/v1/api_keys/${key.id}/revoke`, {})).statusCode, 200);
  assert.equal(
    (await f.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${key.secret}` } }))
      .statusCode,
    401,
  );
});
test('key creation cannot escalate caller scopes and ownership guards hide foreign keys and operations', async () => {
  const a = await fixture(),
    b = await fixture(['payments:read', 'keys:write']);
  assert.equal(
    (await b.post('/v1/api_keys', { name: 'Escalation', scopes: ['operations:write'] })).statusCode,
    403,
  );
  assert.equal((await b.post(`/v1/api_keys/${a.key.id}/revoke`, {})).statusCode, 404);
  assert.equal((await b.get('/v1/operations/reconciliation')).statusCode, 403);
});
test('request logs omit credentials, payloads, and query values while retaining route and status', async () => {
  const f = await fixture();
  await f.post('/v1/customers', { name: 'payload_private_marker' });
  await f.get('/v1/intents?search=query_private_marker');
  const r = await f.get('/v1/request_logs');
  assert.equal(r.statusCode, 200);
  for (const secret of [f.key.secret, 'payload_private_marker', 'query_private_marker'])
    assert.equal(r.body.includes(secret), false);
  assert.ok(r.json().data.some((row: { path: string }) => row.path === '/v1/customers'));
});
test('key cursor pagination and SDK iteration expose each owned key once without hashes', async () => {
  const f = await fixture();
  for (let n = 0; n < 4; n++) await issueApiKey(f.merchant, `Reader ${n}`, ['payments:read']);
  const first = (await f.get('/v1/api_keys?limit=2')).json();
  assert.equal(first.has_more, true);
  assert.equal(first.data.length, 2);
  assert.equal('hash' in first.data[0], false);
  const sdk = new Microsendr({
    apiKey: f.key.secret,
    fetch: (async (url, options) => {
      const r = await f.app.inject({
        url: String(url),
        headers: options?.headers as Record<string, string>,
      });
      return new Response(r.body, { status: r.statusCode });
    }) as typeof fetch,
  });
  const collected = [];
  for await (const key of sdk.paginate(sdk.listApiKeys, { limit: '2' })) collected.push(key.id);
  assert.equal(collected.length, 5);
  assert.equal(new Set(collected).size, 5);
});
test('guest workspace seeds actual payments and safely recovers an ambiguous instruction once', async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: 'POST',
    url: '/console/workspaces',
    headers: { origin },
    payload: { name: 'Workspace fixture' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = String(response.headers['set-cookie']).split(';')[0],
    session = response.json();
  const get = (url: string) => f.app.inject({ url, headers: { cookie } });
  const intents = (await get('/v1/intents')).json().data;
  assert.equal(intents.length, 7);
  assert.equal(intents.filter((i: { state: string }) => i.state === 'succeeded').length, 5);
  const unknown = intents.find((i: { state: string }) => i.state === 'unknown');
  assert.ok(unknown);
  const detail = (await get(`/v1/operations/intents/${unknown.id}`)).json();
  assert.equal(detail.hold.state, 'held');
  assert.equal(detail.receipts.length, 0);
  assert.equal((await f.get(`/v1/operations/intents/${unknown.id}`)).statusCode, 404);
  const recovery = await f.app.inject({
    method: 'POST',
    url: `/v1/operations/intents/${unknown.id}/recover`,
    headers: {
      origin,
      cookie,
      'x-kora-csrf': session.csrf_token,
      'idempotency-key': 'recovery-test',
    },
    payload: {},
  });
  assert.equal(recovery.statusCode, 202, recovery.body);
  await runOnce({ onlyIntent: unknown.id });
  await runOnce({ onlyIntent: unknown.id });
  const settled = (await get(`/v1/operations/intents/${unknown.id}`)).json();
  assert.equal(settled.intent.state, 'succeeded');
  assert.equal(settled.receipts.length, 1);
  assert.equal(settled.hold.state, 'captured');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM fake_provider_movements WHERE instruction_id=$1',
        [detail.instructions[0].id],
      )
    ).rows[0].n,
    1,
  );
  for (const journal of settled.journals) {
    const assets = new Map<string, bigint>();
    for (const entry of journal.entries)
      assets.set(
        entry.asset,
        (assets.get(entry.asset) ?? 0n) +
          (entry.side === 'debit' ? 1n : -1n) * BigInt(entry.amount),
      );
    assert.ok([...assets.values()].every((v) => v === 0n));
  }
  const stats = await get('/v1/console/overview');
  assert.equal(stats.statusCode, 200, stats.body);
  models.Overview.parse(stats.json());
  assert.equal(stats.json().completed, 6);
  assert.equal((await get('/v1/intents?state=failed')).json().data.length, 1);
  assert.equal((await get('/v1/intents?search=Studio')).json().data.length, 1);
  assert.deepEqual(await invariantReport(), {
    balanced: true,
    nonnegative: true,
    no_empty_journals: true,
    violations: [],
  });
});
test('OpenAPI covers every versioned endpoint with concrete response models and idempotency headers', async () => {
  const f = await fixture();
  const spec = (await f.app.inject({ url: '/openapi.json' })).json();
  assert.equal(spec.openapi, '3.0.3');
  for (const [key, contract] of Object.entries(contracts)) {
    const [method, path] = key.split(' '),
      op = spec.paths[path.replace(':id', '{id}')][method.toLowerCase()];
    assert.equal(op.operationId, contract.operationId);
    if (contract.body)
      assert.ok(
        op.parameters.some(
          (p: { in: string; name: string; required: boolean }) =>
            p.in === 'header' && p.name === 'idempotency-key' && p.required,
        ),
      );
  }
  assert.ok(!spec.paths['/console/workspaces']);
  assert.ok(!spec.paths['/internal/providers/fake/callback']);
});
test('browser-safe SDK sends exact integer strings, stable keys, and structured errors without automatic retries', async () => {
  const f = await fixture();
  let calls = 0;
  const sdk = new Microsendr({
    apiKey: f.key.secret,
    fetch: (async (url, options) => {
      calls++;
      const r = await f.app.inject({
        method: options?.method as 'GET' | 'POST',
        url: String(url),
        headers: options?.headers as Record<string, string>,
        payload: options?.body as string,
      });
      return new Response(r.body, {
        status: r.statusCode,
        headers: r.headers as Record<string, string>,
      });
    }) as typeof fetch,
  });
  const a = await sdk.createCustomer({ name: 'SDK customer' }, 'sdk-customer'),
    b = await sdk.createCustomer({ name: 'SDK customer' }, 'sdk-customer');
  assert.equal(a.id, b.id);
  await assert.rejects(
    sdk.createCustomer({ name: 'Changed' }, 'sdk-customer'),
    (e) =>
      e instanceof MicrosendrError &&
      e.status === 409 &&
      e.code === 'idempotency_conflict' &&
      !!e.requestId,
  );
  assert.equal(calls, 3);
  await pool.query('UPDATE merchants SET max_source_minor=$2 WHERE id=$1', [
    f.merchant,
    '900719925474099300',
  ]);
  const q = await sdk.createQuote(
    { source_asset: 'NGN', destination_asset: 'USDC', amount_minor: '900719925474099300' },
    'sdk-quote',
  );
  assert.equal(typeof q.source.amount_minor, 'string');
  assert.equal(q.source.amount_minor, '900719925474099300');
});
