import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { paystackHarness } from '../tests/paystack-harness.js';
import { buildApi } from '../services/api/src/app.js';
import {
  createMerchant,
  sandboxFund,
  balances,
  invariantReport,
} from '../packages/ledger/src/index.js';
import { issueApiKey } from '../packages/payments/src/auth.js';
import { pool, id } from '../packages/database/src/index.js';
import { Microsendr } from '../sdks/typescript/src/index.js';
const h = await paystackHarness();
process.env.KORA_WEBHOOK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const app = await buildApi({ serveWeb: false, paystackClient: h.client });
try {
  const merchant = id('smoke');
  await createMerchant(merchant, 'Phase 3 isolated smoke');
  await sandboxFund(merchant, 'NGN', '1000000', `fund:${merchant}`);
  const key = await issueApiKey(merchant, 'Smoke operator');
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 }),
    sdk = new Microsendr({ baseUrl, apiKey: key.secret });
  const worker = (mode: 'intent' | 'rail', resource: string, crash?: string) =>
    new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/rail-process-worker.ts', mode, resource, h.origin],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            KORA_TEST_PAYSTACK_KEY: h.secretKey,
            KORA_TEST_CRASH_CHECKPOINT: crash ?? '',
          },
        },
      );
      // Errors are intentionally not printed: test config and account details stay private.
      child.stderr.resume();
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Smoke worker timed out'));
      }, 20000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  const customer = await sdk.createCustomer({ name: 'Smoke recipient' }, id('idem'));
  const resolution = await sdk.resolveBank(
    { account_number: '0001234567', bank_code: '058' },
    id('idem'),
  );
  const account = await sdk.createBankAccount(
    customer.id,
    { resolution_id: resolution.id, label: 'Test bank' },
    id('idem'),
  );
  const intent = await sdk.createLocalPayout(
    {
      customer_id: customer.id,
      destination_instrument_id: account.instrument_id,
      amount_minor: '100000',
      reference: 'Crash recovery smoke',
    },
    id('idem'),
  );
  assert.equal((await worker('intent', intent.id, 'provider_accepted')).signal, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await worker('intent', intent.id)).code, 0);
  assert.equal((await sdk.getIntent(intent.id)).state, 'succeeded');
  assert.equal(h.counts().transferPosts, 1);
  const callback = async (event: string, reference: string) => {
    const raw = JSON.stringify({ event, data: { reference, domain: 'test' } });
    const result = await fetch(`${baseUrl}/internal/providers/paystack/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': h.sign(raw) },
      body: raw,
    });
    assert.equal(result.status, 200);
    return result.json();
  };
  const col = await sdk.createCollection(
    { customer_id: customer.id, amount_minor: '100000', email: 'smoke@example.test' },
    id('idem'),
  );
  assert.equal((await worker('rail', col.id)).code, 0);
  h.complete(col.provider_reference);
  await callback('charge.success', col.provider_reference);
  assert.equal((await callback('charge.success', col.provider_reference)).duplicate, true);
  const inbox = (
    await pool.query('SELECT id FROM provider_inbox WHERE provider_reference=$1', [
      col.provider_reference,
    ])
  ).rows[0];
  assert.equal((await worker('rail', inbox.id)).code, 0);
  assert.equal((await sdk.getCollection(col.id)).state, 'succeeded');
  const transfer = [...h.transfers.keys()][0];
  h.reverse(transfer);
  await callback('transfer.reversed', transfer);
  const returned = (
    await pool.query('SELECT id FROM provider_inbox WHERE provider_reference=$1', [transfer])
  ).rows[0];
  assert.equal((await worker('rail', returned.id)).code, 0);
  assert.equal((await sdk.getIntent(intent.id)).state, 'returned');
  const statement = await sdk.createStatement(id('idem'));
  assert.equal((await worker('rail', statement.id)).code, 0);
  const detail = await sdk.getStatement(statement.id);
  assert.equal(detail.matched, 3);
  assert.equal(detail.unmatched, 0);
  assert.equal(
    (await balances(merchant)).find((b) => b.asset === 'NGN' && b.purpose === 'available')!.minor,
    '1099900',
  );
  const invariants = await invariantReport();
  assert.equal(invariants.balanced && invariants.nonnegative && invariants.no_empty_journals, true);
  console.log(
    JSON.stringify(
      {
        provider: 'local Paystack API harness',
        remote_provider_validated: false,
        separate_worker_processes: true,
        crash_after_acceptance_recovered: true,
        transfer_posts: h.counts().transferPosts,
        collection_posts: h.counts().collectionPosts,
        duplicate_callback_deduplicated: true,
        returned_once: true,
        statement_matched: detail.matched,
        invariants,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await h.close();
  await pool.end();
}
