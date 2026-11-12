import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StellarTestnetConnector } from '../../../connectors/stellar/src/index.js';
import { pool, type Client } from '../../../packages/database/src/index.js';
import { requireScope, type Scope } from '../../../packages/payments/src/auth.js';
import { mutate, type MutationResult } from '../../../packages/payments/src/idempotency.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import {
  accountChallenge,
  registerStellarAccount,
  purchase,
  deposit,
  redeem,
} from '../../../packages/stellar/src/index.js';
import {
  stellarAccountSchema,
  stellarPurchaseSchema,
  stellarDepositSchema,
  stellarRedeemSchema,
  typedId,
} from '../../../packages/contracts/src/index.js';
export async function registerStellar(app: FastifyInstance, injected?: StellarTestnetConnector) {
  const connector = () => {
    if (injected) return injected;
    if (!StellarTestnetConnector.configured())
      throw new PaymentError(
        503,
        'stellar_not_configured',
        'Configure the isolated Stellar Testnet issuer and treasury signer',
      );
    return StellarTestnetConnector.fromEnvironment();
  };
  const merchant = (r: FastifyRequest, scope: Scope) => {
    if (!r.principal) throw new PaymentError(401, 'invalid_api_key', 'Authentication required');
    requireScope(r.principal, scope);
    return r.principal.merchant_id;
  };
  const rid = (r: FastifyRequest) => typedId.parse((r.params as { id: string }).id);
  async function customer(r: FastifyRequest, scope: Scope) {
    const m = merchant(r, scope);
    if (
      !(await pool.query('SELECT 1 FROM customers WHERE id=$1 AND merchant_id=$2', [rid(r), m]))
        .rowCount
    )
      throw new PaymentError(404, 'customer_not_found', 'Customer not found');
    return m;
  }
  function write<T>(
    url: string,
    scope: Scope,
    schema: z.ZodType<T>,
    run: (c: Client, m: string, input: T, r: FastifyRequest) => Promise<MutationResult>,
  ) {
    app.post(url, async (r, reply) => {
      const m = merchant(r, scope),
        input = schema.parse(r.body ?? {});
      const result = await mutate(
        m,
        `POST ${r.routeOptions.url}:${JSON.stringify(r.params)}`,
        r.headers['idempotency-key'],
        input,
        (c) => run(c, m, input, r),
      );
      if (result.replayed) reply.header('idempotency-replayed', 'true');
      return reply.status(result.status).send(result.body);
    });
  }
  app.get('/v1/stellar', async (r) => {
    merchant(r, 'payments:read');
    const configured = !!injected || StellarTestnetConnector.configured(),
      c = configured ? connector() : null;
    return {
      provider: 'stellar-testnet',
      network: 'testnet',
      configured,
      asset_code: 'KUSD',
      asset_name: 'Microsendr Test USD',
      issuer: c?.config.issuer ?? null,
      treasury: c?.config.treasury ?? null,
      fx_basis: 'fixture_1600_ngn_per_kusd',
      partner_fx_configured: false,
    };
  });
  app.get('/v1/customers/:id/stellar_challenge', async (r) => {
    const m = await customer(r, 'customers:read'),
      address = z.string().parse((r.query as { address: string }).address);
    return {
      challenge_hex: accountChallenge(m, rid(r), address, connector()).toString('hex'),
      address,
    };
  });
  write(
    '/v1/customers/:id/stellar_accounts',
    'customers:write',
    stellarAccountSchema,
    async (c, m, input, r) => ({
      status: 201,
      body: await registerStellarAccount(c, m, rid(r), connector(), input),
    }),
  );
  app.get('/v1/customers/:id/stellar_accounts', async (r) => {
    const m = await customer(r, 'customers:read');
    return {
      data: (
        await pool.query(
          'SELECT * FROM stellar_accounts WHERE merchant_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 100',
          [m, rid(r)],
        )
      ).rows,
    };
  });
  write('/v1/stellar/purchases', 'payments:write', stellarPurchaseSchema, async (c, m, input) => ({
    status: 201,
    body: await purchase(c, m, connector(), input),
  }));
  write('/v1/stellar/deposits', 'payments:write', stellarDepositSchema, async (c, m, input) => ({
    status: 201,
    body: await deposit(c, m, connector(), input),
  }));
  app.get('/v1/stellar/deposits', async (r) => ({
    data: (
      await pool.query(
        'SELECT * FROM stellar_deposits WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 100',
        [merchant(r, 'payments:read')],
      )
    ).rows,
  }));
  write('/v1/stellar/redemptions', 'payments:write', stellarRedeemSchema, async (c, m, input) => {
    connector();
    return { status: 201, body: await redeem(c, m, input) };
  });
  app.get('/v1/stellar/redemptions', async (r) => ({
    data: (
      await pool.query(
        'SELECT * FROM stellar_redemptions WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 100',
        [merchant(r, 'payments:read')],
      )
    ).rows,
  }));
}
