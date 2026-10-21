import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PaystackClient } from '../../../connectors/paystack/src/index.js';
import { pool, id, type Client } from '../../../packages/database/src/index.js';
import { requireScope, type Scope } from '../../../packages/payments/src/auth.js';
import { mutate, type MutationResult } from '../../../packages/payments/src/idempotency.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import {
  bankResolutionSchema,
  bankAccountSchema,
  collectionSchema,
  localPayoutSchema,
  complianceSchema,
  typedId,
  empty,
} from '../../../packages/contracts/src/index.js';
import {
  resolveBank,
  registerBank,
  createBankRecipient,
  localPayout,
  createCollection,
  collectionView,
  enqueue,
  releaseCollection,
  ingestProviderEvent,
  startStatement,
} from '../../../packages/rails/src/index.js';
import { page } from './pagination.js';

export async function registerRails(app: FastifyInstance, injected?: PaystackClient) {
  const client = () => {
    if (injected) return injected;
    if (!PaystackClient.configured())
      throw new PaymentError(
        503,
        'provider_not_configured',
        'Configure PAYSTACK_SECRET_KEY with a Paystack test key',
      );
    return PaystackClient.fromEnvironment();
  };
  const merchant = (r: FastifyRequest, scope: Scope) => {
    if (!r.principal) throw new PaymentError(401, 'invalid_api_key', 'Authentication is required');
    requireScope(r.principal, scope);
    return r.principal.merchant_id;
  };
  const resourceId = (r: FastifyRequest) => typedId.parse((r.params as { id: string }).id);
  async function owned(
    table: 'collections' | 'customers' | 'statement_runs',
    r: FastifyRequest,
    scope: Scope,
  ) {
    const m = merchant(r, scope),
      rid = resourceId(r);
    const row = (
      await pool.query(`SELECT * FROM ${table} WHERE id=$1 AND merchant_id=$2`, [rid, m])
    ).rows[0];
    if (!row) throw new PaymentError(404, 'resource_not_found', 'Resource not found');
    return row;
  }
  function write<T, P = undefined>(
    url: string,
    scope: Scope,
    schema: z.ZodType<T>,
    run: (c: Client, m: string, input: T, r: FastifyRequest, prepared: P) => Promise<MutationResult>,
    // Idempotent provider reads run here, before the transaction opens, so a slow
    // provider never holds a pooled connection or the idempotency lock.
    prepare?: (m: string, input: T, r: FastifyRequest) => Promise<P>,
  ) {
    app.post(url, async (r, reply) => {
      const m = merchant(r, scope),
        input = schema.parse(r.body ?? {});
      const prepared = (prepare ? await prepare(m, input, r) : undefined) as P;
      const result = await mutate(
        m,
        `POST ${r.routeOptions.url}:${JSON.stringify(r.params)}`,
        r.headers['idempotency-key'],
        input,
        (c) => run(c, m, input, r, prepared),
      );
      if (result.replayed) reply.header('idempotency-replayed', 'true');
      return reply.status(result.status).send(result.body);
    });
  }
  app.get('/v1/rails', async (r) => {
    merchant(r, 'payments:read');
    return {
      provider: 'paystack-test',
      mode: 'test',
      configured: !!injected || PaystackClient.configured(),
      asset: 'NGN',
      capabilities: [
        'name_enquiry',
        'collections',
        'payouts',
        'verified_callbacks',
        'returns',
        'ledger_snapshot_reconciliation',
      ],
    };
  });
  app.get('/v1/banks', async (r) => {
    merchant(r, 'customers:read');
    return { data: await client().banks() };
  });
  write(
    '/v1/bank_resolutions',
    'customers:write',
    bankResolutionSchema,
    async (c, m, input, _r, resolved: { account_name: string }) => ({
      status: 201,
      body: await resolveBank(c, m, client(), input, resolved),
    }),
    (_m, input) => client().resolveAccount(input.account_number, input.bank_code),
  );
  write(
    '/v1/customers/:id/bank_accounts',
    'customers:write',
    bankAccountSchema,
    async (c, m, input, r, recipient: { recipient_code: string }) => ({
      status: 201,
      body: await registerBank(c, m, resourceId(r), client(), input, recipient),
    }),
    (m, input) => createBankRecipient(pool, m, client(), input.resolution_id),
  );
  app.get('/v1/customers/:id/bank_accounts', async (r) => {
    const row = await owned('customers', r, 'customers:read');
    return {
      data: (
        await pool.query(
          'SELECT instrument_id,customer_id,recipient_code,bank_code,account_last4,account_name,created_at FROM bank_accounts WHERE customer_id=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT 100',
          [row.id, row.merchant_id],
        )
      ).rows,
    };
  });
  write('/v1/local_payouts', 'payments:write', localPayoutSchema, async (c, m, input) => {
    client();
    return { status: 201, body: await localPayout(c, m, input, client().binding) };
  });
  write('/v1/local_payouts/:id/verify', 'operations:write', empty, async (c, m, _input, r) => {
    client();
    const rid = resourceId(r);
    if (
      !(
        await c.query(
          "SELECT 1 FROM intents WHERE id=$1 AND merchant_id=$2 AND provider='paystack-test'",
          [rid, m],
        )
      ).rowCount
    )
      throw new PaymentError(404, 'intent_not_found', 'Local payout not found');
    await enqueue(c, 'payout_verify', rid);
    return { status: 202, body: { intent_id: rid, queued: true } };
  });
  write('/v1/collections', 'payments:write', collectionSchema, async (c, m, input) => {
    client();
    return { status: 201, body: await createCollection(c, m, input, client().binding) };
  });
  app.get('/v1/collections', async (r) => {
    const result = await page('collections', merchant(r, 'payments:read'), r.query);
    return { ...result, data: result.data.map(collectionView) };
  });
  app.get('/v1/collections/:id', async (r) =>
    collectionView(await owned('collections', r, 'payments:read')),
  );
  write('/v1/collections/:id/verify', 'payments:write', empty, async (c, m, _input, r) => {
    client();
    const rid = resourceId(r);
    if (
      !(await c.query('SELECT 1 FROM collections WHERE id=$1 AND merchant_id=$2', [rid, m]))
        .rowCount
    )
      throw new PaymentError(404, 'collection_not_found', 'Collection not found');
    await enqueue(c, 'collection_verify', rid);
    return { status: 202, body: { collection_id: rid, queued: true } };
  });
  write('/v1/collections/:id/release', 'operations:write', empty, async (c, m, _input, r) => ({
    status: 200,
    body: await releaseCollection(c, m, resourceId(r)),
  }));
  write(
    '/v1/customers/:id/compliance_decisions',
    'operations:write',
    complianceSchema,
    async (c, m, input, r) => {
      const customer = resourceId(r);
      const row = (
        await c.query(
          'UPDATE customers SET verification_state=$3 WHERE id=$1 AND merchant_id=$2 RETURNING id',
          [customer, m, input.decision === 'allow' ? 'sandbox_verified' : 'held'],
        )
      ).rows[0];
      if (!row) throw new PaymentError(404, 'customer_not_found', 'Customer not found');
      return {
        status: 201,
        body: (
          await c.query(
            'INSERT INTO compliance_decisions(id,merchant_id,customer_id,decision,reason,evidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,customer_id,decision,reason,created_at',
            [
              id('cd'),
              m,
              customer,
              input.decision,
              input.reason,
              {
                source: 'operator',
                identity_checks: 'sandbox_only',
                api_key_id: r.principal!.key_id,
              },
            ],
          )
        ).rows[0],
      };
    },
  );
  app.get('/v1/customers/:id/compliance_decisions', async (r) => {
    const row = await owned('customers', r, 'operations:read');
    return {
      data: (
        await pool.query(
          'SELECT id,customer_id,decision,reason,created_at FROM compliance_decisions WHERE customer_id=$1 AND merchant_id=$2 ORDER BY created_at DESC LIMIT 100',
          [row.id, row.merchant_id],
        )
      ).rows,
    };
  });
  write('/v1/operations/statements', 'operations:write', empty, async (c, m) => {
    client();
    return { status: 202, body: await startStatement(c, m, client().binding) };
  });
  app.get('/v1/operations/statements', (r) =>
    page('statement_runs', merchant(r, 'operations:read'), r.query),
  );
  app.get('/v1/operations/statements/:id', async (r) => {
    const row = await owned('statement_runs', r, 'operations:read');
    // Provider snapshots cover the whole integration. Never expose another
    // merchant's provider IDs, amounts, timestamps, or evidence.
    const items = (
      await pool.query(
        "SELECT id,provider_row_id,resource_id,difference_minor::text,expected_minor::text,state,evidence FROM statement_items WHERE run_id=$1 AND resource_id IS NOT NULL AND state!='unmapped' ORDER BY id",
        [row.id],
      )
    ).rows;
    const redacted = (
      await pool.query(
        "SELECT count(*)::int n FROM statement_items WHERE run_id=$1 AND (resource_id IS NULL OR state='unmapped')",
        [row.id],
      )
    ).rows[0].n;
    return { ...row, items, redacted_unmapped: redacted };
  });
  app.post('/internal/providers/paystack/webhook', async (r) =>
    ingestProviderEvent(r.rawBody, r.headers['x-paystack-signature'], client()),
  );
}
