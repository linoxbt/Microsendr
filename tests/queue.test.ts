import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, id } from '../packages/database/src/index.js';
import { createMerchant, sandboxFund } from '../packages/ledger/src/index.js';
import { issueApiKey } from '../packages/payments/src/auth.js';
import { buildApi } from '../services/api/src/app.js';
import { runOnce } from '../services/worker/src/worker.js';
import { runQueues } from '../services/worker/src/queues.js';
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});
async function fixture() {
  const merchant = id('test');
  await createMerchant(merchant, 'Queue regression fixture');
  await sandboxFund(merchant, 'NGN', '10000000', id('fund'));
  const key = await issueApiKey(merchant, 'Queue fixture'),
    app = await buildApi({ serveWeb: false, rateLimitMax: 10000 });
  apps.push(app);
  const post = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${key.secret}`, 'idempotency-key': id('idem') },
      payload: body as Record<string, unknown>,
    });
  const customer = (await post('/v1/customers', { name: 'Queue recipient' })).json();
  const account = (
    await post(`/v1/customers/${customer.id}/instruments`, {
      type: 'stellar_account',
      asset: 'USDC',
      label: 'Sandbox wallet',
      sandbox_identifier: 'sandbox:queue:wallet',
    })
  ).json();
  const intent = async (scenario = 'success') => {
    const q = (
      await post('/v1/quotes', {
        source_asset: 'NGN',
        destination_asset: 'USDC',
        amount_minor: '160000',
      })
    ).json();
    const r = await post('/v1/intents', {
      quote_id: q.id,
      customer_id: customer.id,
      destination_instrument_id: account.id,
      reference: id('order'),
      scenario,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  };
  const state = async (intentId: string) =>
    (await pool.query('SELECT state FROM intents WHERE id=$1', [intentId])).rows[0].state;
  const job = async (intentId: string) =>
    (await pool.query('SELECT * FROM outbox WHERE intent_id=$1', [intentId])).rows[0];
  return { merchant, post, intent, state, job };
}
test('requested recoveries and new payments run ahead of older background retries', async () => {
  const f = await fixture(),
    background = await f.intent('timeout');
  await runOnce({ onlyIntent: background.id });
  assert.equal((await f.job(background.id)).priority, 0);
  await pool.query("UPDATE outbox SET available_at=now()-interval '1 day' WHERE intent_id=$1", [
    background.id,
  ]);
  const recover = await f.intent('timeout');
  await runOnce({ onlyIntent: recover.id });
  const fresh = await f.intent();
  assert.equal((await f.post(`/v1/operations/intents/${recover.id}/recover`, {})).statusCode, 202);
  assert.equal((await f.job(recover.id)).priority, 2);
  await runOnce({ onlyMerchant: f.merchant });
  assert.equal(await f.state(recover.id), 'succeeded');
  assert.equal(await f.state(background.id), 'unknown');
  assert.equal(await f.state(fresh.id), 'processing');
  await runOnce({ onlyMerchant: f.merchant });
  assert.equal(await f.state(fresh.id), 'succeeded');
  assert.equal(await f.state(background.id), 'unknown');
  await runOnce({ onlyMerchant: f.merchant });
  assert.equal(await f.state(background.id), 'succeeded');
  const count = (
    await pool.query(
      'SELECT count(*)::int n FROM fake_provider_movements m JOIN instructions ins ON ins.id=m.instruction_id JOIN intents i ON i.id=ins.intent_id WHERE i.merchant_id=$1',
      [f.merchant],
    )
  ).rows[0].n;
  assert.equal(count, 3);
});
test('a new recovery request fences an active worker acknowledgement without duplicating capture', async () => {
  const f = await fixture(),
    i = await f.intent('timeout');
  await runOnce({ onlyIntent: i.id });
  await pool.query('UPDATE outbox SET available_at=now() WHERE intent_id=$1', [i.id]);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const old = runOnce({
    onlyIntent: i.id,
    checkpoint: async (point) => {
      if (point === 'instruction_committed') {
        enter();
        await gate;
      }
    },
  });
  await entered;
  assert.ok((await f.job(i.id)).locked_by);
  try {
    assert.equal((await f.post(`/v1/operations/intents/${i.id}/recover`, {})).statusCode, 202);
    assert.equal((await f.job(i.id)).priority, 2);
    assert.equal((await f.job(i.id)).locked_by, null);
  } finally {
    release();
  }
  await old;
  const queued = await f.job(i.id);
  assert.equal(queued.priority, 2);
  assert.equal(queued.processed_at, null);
  await runOnce({ onlyIntent: i.id });
  assert.ok((await f.job(i.id)).processed_at);
  assert.equal(await f.state(i.id), 'succeeded');
  const journals = (
    await pool.query(
      "SELECT count(*)::int n FROM journals WHERE reference=(SELECT 'capture:'||hold_id FROM intents WHERE id=$1)",
      [i.id],
    )
  ).rows[0].n;
  assert.equal(journals, 1);
});
test('a slow delivery queue does not block payment progress or shutdown', async () => {
  let running = true,
    payments = 0,
    delivered = false,
    release!: () => void,
    ready!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    progressed = new Promise<void>((resolve) => {
      ready = resolve;
    });
  const worker = runQueues(
    [
      async () => {
        await gate;
        delivered = true;
        return false;
      },
      async () => {
        payments++;
        if (payments === 2) ready();
        return true;
      },
    ],
    () => running,
  );
  await progressed;
  assert.equal(delivered, false);
  assert.ok(payments >= 2);
  running = false;
  release();
  await worker;
  assert.equal(delivered, true);
});
test('a failing queue is reported and retried with backoff while other queues keep working', async () => {
  let running = true,
    failures = 0,
    healthy = 0;
  const errors: number[] = [];
  const worker = runQueues(
    [
      async () => {
        failures++;
        if (failures >= 3 && healthy >= 3) running = false;
        throw new Error('Queue failure fixture');
      },
      async () => {
        healthy++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return true;
      },
    ],
    () => running,
    { onError: (queue, _error, count) => errors.push(queue * 100 + count), backoffMs: () => 5 },
  );
  await worker;
  assert.ok(failures >= 3);
  assert.ok(healthy >= 3);
  assert.deepEqual(errors.slice(0, 3), [1, 2, 3]);
});
