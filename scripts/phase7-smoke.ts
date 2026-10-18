import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pool, id } from '../packages/database/src/index.js';
import { createMerchant, sandboxFund, invariantReport } from '../packages/ledger/src/index.js';
import { issueApiKey } from '../packages/payments/src/auth.js';
import { processIntent } from '../packages/payments/src/index.js';
import { buildApi } from '../services/api/src/app.js';
import { Microsendr } from '../sdks/typescript/src/index.js';
const app = await buildApi({ serveWeb: false });
try {
  const merchant = id('pilot');
  await createMerchant(merchant, 'Phase 7 Nigerian routing rehearsal');
  await sandboxFund(merchant, 'NGN', '10000000', id('fund'));
  const key = await issueApiKey(merchant, 'Private phase 7 fixture');
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 }),
    api = new Microsendr({ baseUrl, apiKey: key.secret });
  const customer = await api.createCustomer({ name: 'Nigeria routing recipient' }, id('idem'));
  const account = await api.createInstrument(
    customer.id,
    {
      type: 'bank_account',
      asset: 'NGN',
      label: 'Nigeria sandbox bank',
      sandbox_identifier: 'sandbox:phase7:recipient',
    },
    id('idem'),
  );
  const health = (status: 'healthy' | 'unavailable') =>
    api.recordNetworkHealth(
      {
        participant_id: 'nigeria-payout-sandbox',
        status,
        reason: 'Local routing rehearsal',
        valid_for_seconds: 300,
      },
      id('idem'),
    );
  await health('unavailable');
  const routes = await api.getNetworkRouting('160000');
  assert.equal(routes.selected_corridor_id, 'ng-ng-alternate');
  const quote = await api.createNetworkQuote(
    { corridor_id: 'auto', amount_minor: '160000', scenario: 'success' },
    id('idem'),
  );
  assert.equal(quote.routing?.selected_corridor_id, 'ng-ng-alternate');
  const body = {
      plan_id: quote.plan_id,
      customer_id: customer.id,
      destination_instrument_id: account.id,
      reference: 'phase7-alternate-rehearsal',
    },
    idem = id('idem');
  const first = await api.createNetworkIntent(body, idem);
  assert.equal((await api.createNetworkIntent(body, idem)).id, first.id);
  await processIntent(first.id);
  const completed = await api.getNetworkPlan(quote.plan_id);
  assert.equal((await api.getIntent(first.id)).state, 'succeeded');
  assert.equal(completed.legs[2].participant_id, 'nigeria-payout-alternate');
  await health('healthy');
  const frozen = await api.createNetworkQuote(
    { corridor_id: 'ng-ng-sandbox', amount_minor: '160000', scenario: 'timeout' },
    id('idem'),
  );
  const pending = await api.createNetworkIntent(
    { ...body, plan_id: frozen.plan_id, reference: 'phase7-frozen-timeout' },
    id('idem'),
  );
  await processIntent(pending.id);
  const accepted = await api.getNetworkPlan(frozen.plan_id);
  assert.equal(accepted.legs.length, 2);
  await health('unavailable');
  await api.recoverIntent(pending.id, id('idem'));
  await processIntent(pending.id);
  const held = await api.getNetworkPlan(frozen.plan_id);
  assert.equal(held.capacity_state, 'held');
  assert.equal(held.legs.filter((l) => l.outcome === 'confirmed').length, 2);
  assert.ok(held.legs.every((l) => l.participant_id !== 'nigeria-payout-alternate'));
  await health('healthy');
  await api.recoverIntent(pending.id, id('idem'));
  await processIntent(pending.id);
  const recovered = await api.getNetworkPlan(frozen.plan_id);
  assert.equal(recovered.capacity_state, 'consumed');
  assert.equal(recovered.legs[2].participant_id, 'nigeria-payout-sandbox');
  assert.deepEqual(
    recovered.legs.slice(0, 2).map((l) => l.provider_reference),
    accepted.legs.map((l) => l.provider_reference),
  );
  const counts = (
    await pool.query(
      `SELECT (SELECT count(*) FROM network_reservations WHERE intent_id=ANY($1))::int reservations,
    (SELECT count(*) FROM receipts WHERE instruction_id IN (SELECT id FROM instructions WHERE intent_id=ANY($1)))::int parent_receipts`,
      [[first.id, pending.id]],
    )
  ).rows[0];
  assert.deepEqual(counts, { reservations: 2, parent_receipts: 2 });
  const invariants = await invariantReport();
  assert.ok(invariants.balanced && invariants.nonnegative && invariants.no_empty_journals);
  await mkdir('.sandbox', { recursive: true, mode: 0o700 });
  await writeFile(
    '.sandbox/phase7-credentials.json',
    JSON.stringify({ merchant_id: merchant, api_key: key.secret }),
    { mode: 0o600 },
  );
  await writeFile(
    '.sandbox/phase7-evidence.json',
    JSON.stringify(
      {
        mode: 'sandbox',
        external_validated: false,
        merchant_id: merchant,
        selection: routes,
        alternate: completed,
        frozen_route_recovery: recovered,
        held_after_health_change: true,
        counts,
        invariants,
        checked_at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      alternate_route: 'succeeded',
      frozen_route: 'recovered_on_original_provider',
      simulated_leg_receipts: 6,
      ...counts,
      balanced: invariants.balanced,
      external_validated: false,
    }),
  );
} finally {
  await app.close();
  await pool.end();
}
