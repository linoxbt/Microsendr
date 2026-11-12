import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { controlFixture } from './control-fixture.js';
import { buildApi } from '../services/api/src/app.js';
import { pool, id, transaction } from '../packages/database/src/index.js';
import { addEvidence } from '../packages/controls/src/index.js';
import { processIntent } from '../packages/payments/src/index.js';
import { invariantReport } from '../packages/ledger/src/index.js';
import { Microsendr, MicrosendrError } from '../sdks/typescript/src/index.js';
const app = await buildApi({ serveWeb: false });
try {
  const f = await controlFixture('Phase 5 capped staging rehearsal');
  await mkdir('.sandbox', { recursive: true, mode: 0o700 });
  await writeFile(
    '.sandbox/phase5-credentials.json',
    JSON.stringify(
      {
        merchant_id: f.merchant,
        requester_key: f.requester.secret,
        reviewer_key: f.reviewer.secret,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const a = new Microsendr({ baseUrl, apiKey: f.requester.secret }),
    b = new Microsendr({ baseUrl, apiKey: f.reviewer.secret });
  const policy = {
    caps: [{ asset: 'NGN' as const, per_transaction_minor: '200000', per_day_minor: '320000' }],
  };
  const request = await a.createControlApproval(
    { action: 'start_staging', policy, reason: 'Local fixture rehearsal' },
    id('idem'),
  );
  await assert.rejects(
    a.reviewControlApproval(
      request.id,
      { decision: 'approve', reason: 'Self approval attempt' },
      id('idem'),
    ),
    (e) => e instanceof MicrosendrError && e.code === 'self_approval',
  );
  await b.reviewControlApproval(
    request.id,
    { decision: 'approve', reason: 'Independent fixture identity' },
    id('idem'),
  );
  const customer = await a.createCustomer({ name: 'Capped staging fixture' }, id('idem'));
  await transaction(async (c) => {
    for (const kind of ['kyc', 'screening'] as const)
      await addEvidence(c, f.requester.principal, {
        kind,
        customer_id: customer.id,
        outcome: 'checked',
        reference: 'local-customer-fixture',
        reason: 'Simulated staging customer review',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
  });
  const instrument = await a.createInstrument(
    customer.id,
    {
      type: 'stellar_account',
      asset: 'USDC',
      label: 'Simulator',
      sandbox_identifier: 'sandbox:phase5',
    },
    id('idem'),
  );
  const quote = await a.createQuote(
    { source_asset: 'NGN', destination_asset: 'USDC', amount_minor: '160000' },
    id('idem'),
  );
  const body = {
      quote_id: quote.id,
      customer_id: customer.id,
      destination_instrument_id: instrument.id,
      reference: id('order'),
      scenario: 'timeout' as const,
    },
    key = id('idem');
  const intent = await a.createIntent(body, key);
  assert.equal((await a.createIntent(body, key)).id, intent.id);
  await processIntent(intent.id);
  await a.pausePayments('Rehearse incident pause', id('idem'));
  const pausedQuote = await a.createQuote(
    { source_asset: 'NGN', destination_asset: 'USDC', amount_minor: '160000' },
    id('idem'),
  );
  await assert.rejects(
    a.createIntent({ ...body, quote_id: pausedQuote.id, reference: id('order') }, id('idem')),
    (e) => e instanceof MicrosendrError && e.code === 'outbound_paused',
  );
  await processIntent(intent.id);
  assert.equal((await a.getIntent(intent.id)).state, 'succeeded');
  const report = await a.createDailyReport(new Date().toISOString().slice(0, 10), id('idem'));
  assert.equal(report.control_clean, true);
  assert.equal(report.provider_cash_complete, false);
  const resume = await a.createControlApproval(
    { action: 'resume', policy, reason: 'Known movement reconciled' },
    id('idem'),
  );
  await b.reviewControlApproval(
    resume.id,
    { decision: 'approve', reason: 'Independent recovery review' },
    id('idem'),
  );
  const ledger = await invariantReport();
  assert.equal(ledger.balanced && ledger.nonnegative && ledger.no_empty_journals, true);
  const counts = (
    await pool.query(
      'SELECT (SELECT count(*) FROM fake_provider_movements WHERE instruction_id IN(SELECT id FROM instructions WHERE intent_id=$1))::int movements,(SELECT count(*) FROM receipts WHERE instruction_id IN(SELECT id FROM instructions WHERE intent_id=$1))::int receipts,(SELECT count(*) FROM pilot_usage WHERE merchant_id=$2)::int usage',
      [intent.id, f.merchant],
    )
  ).rows[0];
  assert.deepEqual(counts, { movements: 1, receipts: 1, usage: 1 });
  const status = await a.getControls();
  assert.equal(status.live_ready, false);
  const proof = {
    created_at: new Date().toISOString(),
    mode: 'local_staging_rehearsal',
    merchant_id: f.merchant,
    intent_id: intent.id,
    operator_identities: 2,
    self_approval_blocked: true,
    pause_blocked_new_money: true,
    accepted_movement_recovered: true,
    ...counts,
    daily_report_id: report.id,
    ledger_controls_clean: report.control_clean,
    provider_cash_complete: false,
    live_ready: false,
    state: status.state,
    external_reviews_simulated: true,
  };
  await writeFile('.sandbox/phase5-evidence.json', JSON.stringify(proof, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await app.close();
  await pool.end();
}
