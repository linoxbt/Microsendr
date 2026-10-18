import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pool, id } from '../packages/database/src/index.js';
import { createMerchant, sandboxFund, invariantReport } from '../packages/ledger/src/index.js';
import { issueApiKey } from '../packages/payments/src/auth.js';
import { buildApi } from '../services/api/src/app.js';
import { processIntent } from '../packages/payments/src/index.js';
import { Microsendr } from '../sdks/typescript/src/index.js';
const app = await buildApi({ serveWeb: false });
try {
  const merchant = id('pilot');
  await createMerchant(merchant, 'Phase 6 Nigeria sandbox rehearsal');
  await sandboxFund(merchant, 'NGN', '10000000', id('fund'));
  const key = await issueApiKey(merchant, 'Private phase 6 fixture');
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const api = new Microsendr({ baseUrl, apiKey: key.secret });
  const customer = await api.createCustomer({ name: 'Nigeria sandbox recipient' }, id('idem'));
  const instrument = await api.createInstrument(
    customer.id,
    {
      type: 'bank_account',
      asset: 'NGN',
      label: 'Nigeria sandbox bank',
      sandbox_identifier: 'sandbox:phase6:recipient',
    },
    id('idem'),
  );
  const q = await api.createNetworkQuote(
    { corridor_id: 'ng-ng-sandbox', amount_minor: '160000', scenario: 'success' },
    id('idem'),
  );
  const idem = id('idem'),
    body = {
      plan_id: q.plan_id,
      customer_id: customer.id,
      destination_instrument_id: instrument.id,
      reference: 'phase6-crash-rehearsal',
    };
  const intent = await api.createNetworkIntent(body, idem);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/network-crash-fixture.ts', intent.id],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 73, stderr);
  const before = await api.getNetworkPlan(q.plan_id);
  assert.equal(before.legs.length, 2);
  assert.equal(before.legs[1].outcome, 'confirmed');
  assert.equal(before.capacity_state, 'held');
  assert.equal((await api.createNetworkIntent(body, idem)).id, intent.id);
  await processIntent(intent.id);
  const after = await api.getNetworkPlan(q.plan_id),
    completed = await api.getIntent(intent.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(after.capacity_state, 'consumed');
  assert.equal(after.legs.length, 3);
  assert.deepEqual(
    after.legs.slice(0, 2).map((l) => l.provider_reference),
    before.legs.map((l) => l.provider_reference),
  );
  assert.ok(after.legs.every((l) => l.outcome === 'confirmed' && l.journal_id));
  const counts = (
    await pool.query(
      'SELECT (SELECT count(*) FROM network_reservations WHERE intent_id=$1)::int reservations,(SELECT count(*) FROM receipts WHERE instruction_id=(SELECT id FROM instructions WHERE intent_id=$1))::int parent_receipts',
      [intent.id],
    )
  ).rows[0];
  assert.deepEqual(counts, { reservations: 1, parent_receipts: 1 });
  const delayedQuote = await api.createNetworkQuote(
    { corridor_id: 'ng-ng-sandbox', amount_minor: '160000', scenario: 'timeout' },
    id('idem'),
  );
  const delayed = await api.createNetworkIntent(
    { ...body, plan_id: delayedQuote.plan_id, reference: 'phase6-timeout-rehearsal' },
    id('idem'),
  );
  await processIntent(delayed.id);
  assert.equal((await api.getIntent(delayed.id)).state, 'unknown');
  await api.recoverIntent(delayed.id, id('idem'));
  await processIntent(delayed.id);
  assert.equal((await api.getIntent(delayed.id)).state, 'succeeded');
  const invariants = await invariantReport();
  assert.ok(invariants.balanced && invariants.nonnegative && invariants.no_empty_journals);
  await mkdir('.sandbox', { recursive: true, mode: 0o700 });
  await writeFile(
    '.sandbox/phase6-credentials.json',
    JSON.stringify({ merchant_id: merchant, api_key: key.secret }),
    { mode: 0o600 },
  );
  const proof = {
    mode: 'sandbox',
    external_validated: false,
    settlement_mode: 'simulated',
    corridor: 'ng-ng-sandbox',
    merchant_id: merchant,
    intent_id: intent.id,
    plan_id: q.plan_id,
    source_hold: (await pool.query('SELECT hold_id FROM intents WHERE id=$1', [intent.id])).rows[0]
      .hold_id,
    state: completed.state,
    crash_after_leg: 2,
    timeout_recovered_intent: delayed.id,
    receipts: after.legs.map((l) => ({
      position: l.position,
      reference: l.provider_reference,
      journal_id: l.journal_id,
    })),
    counts,
    invariants,
    checked_at: new Date().toISOString(),
  };
  await writeFile('.sandbox/phase6-evidence.json', JSON.stringify(proof, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      state: completed.state,
      simulated_leg_receipts: after.legs.length,
      ...counts,
      balanced: invariants.balanced,
      external_validated: false,
    }),
  );
} finally {
  await app.close();
  await pool.end();
}
