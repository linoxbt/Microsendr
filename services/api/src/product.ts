import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assets, type AssetId } from '../../../packages/core/src/index.js';
import { pool, id } from '../../../packages/database/src/index.js';
import {
  requireScope,
  hashKey,
  allScopes,
  type Scope,
} from '../../../packages/payments/src/auth.js';
import { randomBytes } from 'node:crypto';
import { mutate } from '../../../packages/payments/src/idempotency.js';
import {
  PaymentError,
  publicIntent,
  type Intent,
  emit,
} from '../../../packages/payments/src/index.js';
import { page } from './pagination.js';
import { keySchema, typedId, empty } from '../../../packages/contracts/src/index.js';
const usd = (asset: AssetId, minor: string) => {
  const a = assets.find((a) => a.id === asset)!;
  return (
    (BigInt(minor) * BigInt(a.usdNumerator) * 100n) /
    (BigInt(a.usdDenominator) * 10n ** BigInt(a.scale))
  );
};
export async function registerProduct(app: FastifyInstance) {
  const merchant = (r: FastifyRequest, scope: Scope) => {
    if (!r.principal) throw new PaymentError(401, 'invalid_api_key', 'Authentication is required');
    requireScope(r.principal, scope);
    return r.principal.merchant_id;
  };
  app.get('/v1/console/overview', async (r) => {
    const m = merchant(r, 'payments:read'),
      { days } = z
        .object({
          days: z.coerce
            .number()
            .refine((n) => n === 7 || n === 28)
            .default(7),
        })
        .strict()
        .parse(r.query);
    const totals = (
      await pool.query(
        'SELECT state,source_asset,SUM(source_minor)::text amount,COUNT(*)::int count FROM intents WHERE merchant_id=$1 GROUP BY state,source_asset',
        [m],
      )
    ).rows;
    const b = (
      await pool.query(
        "SELECT a.asset,a.purpose,COALESCE(SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END),0)::text amount FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id WHERE a.merchant_id=$1 GROUP BY a.asset,a.purpose",
        [m],
      )
    ).rows;
    const chartRows = (
      await pool.query(
        "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') date,source_asset,SUM(source_minor)::text amount FROM intents WHERE merchant_id=$1 AND state='succeeded' AND created_at>=(date_trunc('day',now() AT TIME ZONE 'UTC')-($2::integer-1)*interval '1 day') AT TIME ZONE 'UTC' GROUP BY date,source_asset",
        [m, days],
      )
    ).rows;
    const chart = Array.from({ length: days }, (_, index) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (days - 1 - index));
      const date = d.toISOString().slice(0, 10);
      return {
        date,
        minor_usd: chartRows
          .filter((row) => row.date === date)
          .reduce((sum, row) => sum + usd(row.source_asset, row.amount), 0n)
          .toString(),
      };
    });
    const open = (
      await pool.query(
        "SELECT COUNT(*)::int n FROM reconciliation_items r JOIN intents i ON i.id=r.intent_id WHERE i.merchant_id=$1 AND r.state='open'",
        [m],
      )
    ).rows[0].n;
    return {
      volume_minor_usd: totals
        .filter((t) => t.state === 'succeeded')
        .reduce((s, t) => s + usd(t.source_asset, t.amount), 0n)
        .toString(),
      available_minor_usd: b
        .filter((b) => b.purpose === 'available')
        .reduce((s, t) => s + usd(t.asset, t.amount), 0n)
        .toString(),
      reserved_minor_usd: b
        .filter((b) => b.purpose === 'reserved')
        .reduce((s, t) => s + usd(t.asset, t.amount), 0n)
        .toString(),
      completed: totals.filter((t) => t.state === 'succeeded').reduce((s, t) => s + t.count, 0),
      total: totals.reduce((s, t) => s + t.count, 0),
      open_reconciliation: open,
      chart,
      days,
    };
  });
  app.get('/v1/api_keys', async (r) => {
    const result = await page('api_keys', merchant(r, 'keys:read'), r.query);
    return {
      ...result,
      data: result.data.map(({ id, name, prefix, scopes, created_at, revoked_at }) => ({
        id,
        name,
        prefix,
        scopes,
        created_at,
        revoked_at,
      })),
    };
  });
  app.post('/v1/api_keys', async (r, reply) => {
    const m = merchant(r, 'keys:write'),
      input = keySchema.parse(r.body);
    if (input.scopes.some((scope) => !r.principal!.scopes.includes(scope)))
      throw new PaymentError(
        403,
        'scope_escalation_denied',
        'A key cannot grant permissions you do not have',
      );
    const result = await mutate(
      m,
      'POST /v1/api_keys',
      r.headers['idempotency-key'],
      input,
      async (c) => {
        const secret = `kora_test_${randomBytes(32).toString('hex')}`;
        const row = (
          await c.query(
            'INSERT INTO api_keys(id,merchant_id,name,prefix,hash,scopes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,prefix,scopes,created_at,revoked_at',
            [id('key'), m, input.name, secret.slice(0, 18), hashKey(secret), input.scopes],
          )
        ).rows[0];
        return { status: 201, body: { ...row, secret } };
      },
    );
    if (result.replayed) reply.header('idempotency-replayed', 'true');
    return reply.status(result.status).send(result.body);
  });
  app.post<{ Params: { id: string } }>('/v1/api_keys/:id/revoke', async (r, reply) => {
    const m = merchant(r, 'keys:write'),
      keyId = typedId.parse(r.params.id);
    empty.parse(r.body ?? {});
    const result = await mutate(
      m,
      `POST /v1/api_keys/${keyId}/revoke`,
      r.headers['idempotency-key'],
      {},
      async (c) => {
        const row = (
          await c.query(
            'UPDATE api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND merchant_id=$2 RETURNING id,name,prefix,scopes,created_at,revoked_at',
            [keyId, m],
          )
        ).rows[0];
        if (!row) throw new PaymentError(404, 'key_not_found', 'API key not found');
        return { status: 200, body: row };
      },
    );
    return reply.status(result.status).send(result.body);
  });
  app.get('/v1/request_logs', async (r) => {
    const m = merchant(r, 'keys:read');
    return {
      data: (
        await pool.query(
          'SELECT request_id,method,path,status_code,duration_ms,created_at FROM request_logs WHERE merchant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',
          [m],
        )
      ).rows,
    };
  });
  app.get('/v1/operations/reconciliation', async (r) => {
    const m = merchant(r, 'operations:read');
    return {
      data: (
        await pool.query(
          'SELECT r.*,i.reference FROM reconciliation_items r JOIN intents i ON i.id=r.intent_id WHERE i.merchant_id=$1 ORDER BY r.created_at DESC LIMIT 100',
          [m],
        )
      ).rows,
    };
  });
  app.get<{ Params: { id: string } }>('/v1/operations/intents/:id', async (r) => {
    const m = merchant(r, 'operations:read'),
      intent = (
        await pool.query('SELECT * FROM intents WHERE id=$1 AND merchant_id=$2', [
          typedId.parse(r.params.id),
          m,
        ])
      ).rows[0] as Intent | undefined;
    if (!intent) throw new PaymentError(404, 'intent_not_found', 'Intent not found');
    const hold = (
      await pool.query('SELECT id,state,amount::text,asset,reference FROM holds WHERE id=$1', [
        intent.hold_id,
      ])
    ).rows[0];
    const instructions = (
      await pool.query(
        'SELECT id,provider_ref,state,created_at FROM instructions WHERE intent_id=$1 ORDER BY created_at,id',
        [intent.id],
      )
    ).rows;
    const attempts = (
      await pool.query(
        'SELECT a.* FROM attempts a JOIN instructions ins ON ins.id=a.instruction_id WHERE ins.intent_id=$1 ORDER BY a.started_at,a.id',
        [intent.id],
      )
    ).rows;
    const receipts = (
      await pool.query(
        'SELECT r.* FROM receipts r JOIN instructions ins ON ins.id=r.instruction_id WHERE ins.intent_id=$1 ORDER BY r.created_at,r.id',
        [intent.id],
      )
    ).rows;
    const js = (
      await pool.query(
        'SELECT * FROM journals WHERE reference=ANY($1::text[]) ORDER BY created_at,id',
        [
          [
            `hold:intent:${intent.id}`,
            `capture:${intent.hold_id}`,
            `release:${intent.hold_id}`,
            `destination:${intent.id}`,
            `return:${intent.id}`,
            `provider-fee:${intent.id}`,
            `stellar-fee:${intent.id}`,
          ],
        ],
      )
    ).rows;
    const journals = [];
    for (const j of js) {
      const entries = (
        await pool.query(
          'SELECT e.account_id,a.asset,e.side,e.amount::text FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=$1 ORDER BY e.side,e.account_id',
          [j.id],
        )
      ).rows;
      journals.push({
        id: j.id,
        reference: j.reference,
        description: j.description,
        created_at: j.created_at,
        entries,
      });
    }
    const stellar_transactions = (
      await pool.query(
        'SELECT st.instruction_id,st.transaction_hash,st.sequence::text,st.source_address,st.expires_at::text FROM stellar_transactions st JOIN instructions i ON i.id=st.instruction_id WHERE i.intent_id=$1',
        [intent.id],
      )
    ).rows;
    const rail_receipts = (
      await pool.query(
        'SELECT id,kind,provider_reference,provider_id,payload,journal_id,created_at FROM rail_receipts WHERE resource_id=$1 AND merchant_id=$2',
        [intent.id, m],
      )
    ).rows;
    return {
      intent: publicIntent(intent),
      hold,
      instructions,
      attempts,
      receipts,
      journals,
      rail_receipts,
      stellar_transactions,
    };
  });
  app.post<{ Params: { id: string } }>('/v1/operations/intents/:id/recover', async (r, reply) => {
    const m = merchant(r, 'operations:write'),
      intentId = typedId.parse(r.params.id);
    empty.parse(r.body ?? {});
    const result = await mutate(
      m,
      `POST /v1/operations/intents/${intentId}/recover`,
      r.headers['idempotency-key'],
      {},
      async (c) => {
        const intent = (
          await c.query('SELECT * FROM intents WHERE id=$1 AND merchant_id=$2 FOR UPDATE', [
            intentId,
            m,
          ])
        ).rows[0] as Intent | undefined;
        if (!intent) throw new PaymentError(404, 'intent_not_found', 'Intent not found');
        if (intent.state !== 'unknown')
          throw new PaymentError(
            409,
            'recovery_unavailable',
            'Only ambiguous intents require status recovery',
          );
        const result = await c.query(
          'UPDATE outbox SET available_at=now(),priority=2,locked_by=NULL,locked_until=NULL,dead_at=NULL,attempts=0 WHERE intent_id=$1 AND processed_at IS NULL RETURNING id',
          [intent.id],
        );
        await emit(c, intent, 'intent.recovery_requested');
        return { status: 202, body: { intent_id: intent.id, queued: result.rowCount !== 0 } };
      },
    );
    return reply.status(result.status).send(result.body);
  });
}
