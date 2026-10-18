import { registerNetwork } from './network.js';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { assets, verifyWebhook } from '../../../packages/core/src/index.js';
import { pool, id, type Client } from '../../../packages/database/src/index.js';
import { balances, LedgerError } from '../../../packages/ledger/src/index.js';
import {
  authenticate,
  requireScope,
  type Principal,
  type Scope,
} from '../../../packages/payments/src/auth.js';
import { mutate, type MutationResult } from '../../../packages/payments/src/idempotency.js';
import {
  createQuote,
  createIntent,
  cancelIntent,
  publicIntent,
  consumeCallback,
  webhookSecret,
  PaymentError,
  type Intent,
} from '../../../packages/payments/src/index.js';
import {
  validateWebhookUrl,
  encryptWebhookSecret,
} from '../../../packages/payments/src/webhooks.js';
import type { ProviderStatus } from '../../../packages/provider-sdk/src/index.js';
import {
  assetSchema,
  amount,
  typedId,
  empty,
  quoteSchema,
  customerSchema,
  instrumentSchema,
  intentSchema,
  webhookSchema,
  contracts,
  models,
  jsonSchema,
} from '../../../packages/contracts/src/index.js';
import { readSession, requireCsrf, registerSessions } from './sessions.js';
import type { PrivyConfig } from './identity.js';
import { PaystackClient } from '../../../connectors/paystack/src/index.js';
import { ProviderError } from '../../../packages/provider-sdk/src/index.js';
import { registerControls } from './controls.js';
import { registerStellar } from './stellar.js';
import type { StellarTestnetConnector } from '../../../connectors/stellar/src/index.js';
import { registerRails } from './rails.js';
import { registerProduct } from './product.js';
import { registerPersonal, type PersonalOptions } from './personal.js';
import { registerDidit } from './didit.js';
import { page, type ListTable } from './pagination.js';
declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    rawBody: string;
  }
}
function publicQuote(q: Record<string, unknown>) {
  return {
    id: q.id,
    object: 'quote',
    provider: q.provider,
    source: { asset: q.source_asset, amount_minor: q.source_minor },
    destination: { asset: q.destination_asset, amount_minor: q.destination_minor },
    fee: { asset: q.source_asset, amount_minor: q.fee_minor },
    route: q.route,
    expires_at: q.expires_at,
    created_at: q.created_at,
    mode: 'sandbox',
  };
}
async function owned(table: ListTable, resourceId: string, merchantId: string) {
  typedId.parse(resourceId);
  const row = (
    await pool.query(`SELECT * FROM ${table} WHERE id=$1 AND merchant_id=$2`, [
      resourceId,
      merchantId,
    ])
  ).rows[0];
  if (!row) throw new PaymentError(404, 'resource_not_found', 'Resource not found');
  return row;
}
export interface ApiOptions {
  personal?: PersonalOptions;
  privyConfig?: PrivyConfig;
  stellarConnector?: StellarTestnetConnector;
  logger?: boolean;
  paystackClient?: PaystackClient;
  rateLimitMax?: number;
  serveWeb?: boolean;
  beforeIntentCommit?: (c: Client, intent: Intent) => Promise<void>;
}
export async function buildApi(options: ApiOptions = {}) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.headers.authorization',
            'req.headers.kora-signature',
            'req.headers.x-paystack-signature',
            'req.headers.cookie',
            'req.body',
            'body',
          ],
        }
      : false,
    bodyLimit: 65536,
    requestIdHeader: false,
    genReqId: () => id('req'),
    ajv: { customOptions: { removeAdditional: false, useDefaults: false, coerceTypes: false } },
  });
  app.decorateRequest('principal', null);
  app.decorateRequest('rawBody', '');
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 300,
    timeWindow: '1 minute',
    allowList: (request) => request.method === 'GET' && /^\/(?:assets|images)\//.test(request.url),
  });
  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Microsendr API',
        version: '0.8.0',
        description:
          'African financial interoperability infrastructure. Paystack NGN collections and payouts accept test keys only. Cross-border routes and identity checks remain sandbox simulations.',
      },
      servers: [{ url: 'http://127.0.0.1:4310' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'kora_test_<secret>' },
        },
      },
    },
    refResolver: { buildLocalReference: (json) => String(json.$id) },
  });
  for (const [name, schema] of Object.entries(models))
    app.addSchema({ $id: name, title: name, ...jsonSchema(schema) });
  app.addHook('onRoute', (route) => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method,
      c = contracts[`${method} ${route.url}`];
    if (!c) {
      route.schema = { ...route.schema, hide: true };
      return;
    }
    const params = route.url.includes(':id')
      ? {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[a-z]+_[a-f0-9]{32}$' } },
        }
      : undefined;
    const querystring = c.query
      ? jsonSchema(c.query, true)
      : c.list
        ? {
            type: 'object',
            additionalProperties: false,
            properties: {
              limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
              after: { type: 'string', maxLength: 512 },
              ...(route.url === '/v1/intents'
                ? {
                    state: {
                      type: 'string',
                      enum: [
                        'processing',
                        'unknown',
                        'succeeded',
                        'failed',
                        'canceled',
                        'returned',
                      ],
                    },
                    search: { type: 'string', maxLength: 128 },
                  }
                : {}),
            },
          }
        : route.url === '/v1/console/overview'
          ? {
              type: 'object',
              additionalProperties: false,
              properties: { days: { type: 'string', enum: ['7', '28'] } },
            }
          : undefined;
    route.schema = {
      operationId: c.operationId,
      summary: c.summary,
      tags: [c.tag],
      security: [{ bearerAuth: [] }],
      ...(params ? { params } : {}),
      ...(querystring ? { querystring } : {}),
      ...(c.body
        ? {
            body: jsonSchema(c.body, true),
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
              },
              required: ['idempotency-key'],
              additionalProperties: true,
            },
          }
        : {}),
      response: { [c.status ?? 200]: { $ref: `${c.model}#` }, default: { $ref: 'Error#' } },
    };
  });
  await app.register(swaggerUi, {
    routePrefix: '/reference',
    uiConfig: { persistAuthorization: false },
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new PaymentError(400, 'invalid_json', 'Request body must contain valid JSON'));
    }
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'same-origin');
    if (request.routeOptions.url?.startsWith('/v1/')) {
      reply.header('cache-control', 'no-store');
      if (request.headers.authorization)
        request.principal = await authenticate(request.headers.authorization);
      else {
        const session = await readSession(request);
        if (!session)
          throw new PaymentError(
            401,
            'invalid_api_key',
            'A valid sandbox Bearer API key or console session is required',
          );
        if (!['GET', 'HEAD'].includes(request.method)) requireCsrf(request, session);
        request.principal = session.principal;
      }
      if (!['GET', 'HEAD'].includes(request.method) && request.principal) {
        const organization = (await pool.query(
          'SELECT kyb_required,kyb_state FROM organizations WHERE legacy_merchant_id=$1',
          [request.principal.merchant_id],
        )).rows[0];
        if (organization?.kyb_required && !['sandbox_approved','verified'].includes(organization.kyb_state))
          throw new PaymentError(403,'sandbox_kyb_required','Complete the Business sandbox verification fixture before changing financial data');
      }
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.principal && request.routeOptions.url?.startsWith('/v1/'))
      try {
        await pool.query(
          'INSERT INTO request_logs(id,merchant_id,api_key_id,request_id,method,path,status_code,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id('log'),
            request.principal.merchant_id,
            request.principal.key_id,
            request.id,
            request.method,
            request.routeOptions.url,
            reply.statusCode,
            Math.max(0, Math.round(reply.elapsedTime)),
          ],
        );
      } catch {
        request.log.error('Request metadata could not be recorded');
      }
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500,
      code = 'internal_error',
      message = 'The request could not be completed';
    if (error instanceof PaymentError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof ProviderError) {
      status = 503;
      code = 'provider_unavailable';
      message = 'Paystack test-mode verification is unavailable';
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'invalid_request';
      message = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    } else if (error instanceof LedgerError) {
      status = error.code === 'insufficient_funds' ? 422 : 409;
      code = error.code;
      message = error.message;
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = status === 429 ? 'rate_limited' : 'invalid_request';
      message = status === 429 ? 'Request rate limit exceeded' : 'Invalid request';
    }
    if (status >= 500) request.log.error({ code, request_id: request.id }, 'Request failed');
    reply.status(status).send({
      error: {
        type:
          status >= 500
            ? 'server_error'
            : status === 401 || status === 403
              ? 'authentication_error'
              : status === 422
                ? 'business_rule'
                : 'invalid_request',
        code,
        message,
        request_id: request.id,
      },
    });
  });
  const webRoot = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url)),
    serveWeb = options.serveWeb !== false && existsSync(`${webRoot}/index.html`);
  if (serveWeb)
    await app.register(staticFiles, {
      root: webRoot,
      prefix: '/',
      setHeaders: (res) => {
        res.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' https://challenges.cloudflare.com https://js.hcaptcha.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://auth.privy.io https://*.hcaptcha.com; font-src 'self'; connect-src 'self' https://auth.privy.io https://api.privy.io https://challenges.cloudflare.com https://*.hcaptcha.com; frame-src https://auth.privy.io https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
      },
    });
  app.setNotFoundHandler((request, reply) => {
    if (
      serveWeb &&
      request.method === 'GET' &&
      !/^\/(?:personal|business)\/api(?:\/|$)/.test(request.url) &&
      /^\/(?:$|app(?:\/|$)|personal(?:\/|$)|business(?:\/|$)|sandbox(?:\/|$)|login(?:\/|$)|connect(?:\/|$)|ramp(?:\/|$)|docs(?:\/|$))/.test(request.url)
    )
      return reply.sendFile('index.html');
    return reply.status(404).send({
      error: {
        type: 'invalid_request',
        code: 'route_not_found',
        message: 'Route not found',
        request_id: request.id,
      },
    });
  });
  function principal(request: FastifyRequest, scope: Scope) {
    if (!request.principal)
      throw new PaymentError(401, 'invalid_api_key', 'A valid sandbox Bearer API key is required');
    requireScope(request.principal, scope);
    return request.principal.merchant_id;
  }
  function write<T>(
    url: string,
    scope: Scope,
    schema: z.ZodType<T>,
    run: (
      c: Client,
      merchantId: string,
      input: T,
      request: FastifyRequest,
    ) => Promise<MutationResult>,
  ) {
    app.post(url, async (request, reply) => {
      const merchantId = principal(request, scope),
        input = schema.parse(request.body ?? {});
      const result = await mutate(
        merchantId,
        `POST ${request.routeOptions.url}:${JSON.stringify(request.params)}`,
        request.headers['idempotency-key'],
        input,
        (c) => run(c, merchantId, input, request),
      );
      if (result.replayed) reply.header('idempotency-replayed', 'true');
      return reply.status(result.status).send(result.body);
    });
  }
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', service: 'kora-api', mode: 'sandbox' };
  });
  app.get('/v1/me', async (request) => {
    const merchantId = principal(request, 'payments:read');
    return (
      await pool.query(
        'SELECT id,name,mode,enabled,max_source_minor::text FROM merchants WHERE id=$1',
        [merchantId],
      )
    ).rows[0];
  });
  app.get('/v1/assets', async (request) => {
    principal(request, 'payments:read');
    const sc = options.stellarConnector;
    return {
      data: assets
        .filter(
          (a) =>
            a.id !== 'XLM' && (a.id !== 'KUSD' || !!sc || !!process.env.STELLAR_TESTNET_ISSUER),
        )
        .map((a) =>
          a.id === 'KUSD'
            ? { ...a, issuer: sc?.config.issuer ?? process.env.STELLAR_TESTNET_ISSUER }
            : a,
        ),
      mode: 'sandbox',
    };
  });
  app.get('/v1/balances', async (request) => ({
    data: await balances(principal(request, 'payments:read')),
    mode: 'sandbox',
  }));
  write('/v1/customers', 'customers:write', customerSchema, async (c, merchantId, input) => ({
    status: 201,
    body: (
      await c.query(
        'INSERT INTO customers(id,merchant_id,name) VALUES($1,$2,$3) RETURNING id,name,verification_state,created_at',
        [id('cus'), merchantId, input.name],
      )
    ).rows[0],
  }));
  app.get('/v1/customers', (request) =>
    page('customers', principal(request, 'customers:read'), request.query),
  );
  app.get<{ Params: { id: string } }>('/v1/customers/:id', (request) =>
    owned('customers', request.params.id, principal(request, 'customers:read')),
  );
  write(
    '/v1/customers/:id/instruments',
    'customers:write',
    instrumentSchema,
    async (c, merchantId, input, request) => {
      const customerId = typedId.parse((request.params as { id: string }).id);
      if (
        !(
          await c.query('SELECT 1 FROM customers WHERE id=$1 AND merchant_id=$2', [
            customerId,
            merchantId,
          ])
        ).rowCount
      )
        throw new PaymentError(404, 'customer_not_found', 'Customer not found');
      if (
        (input.asset === 'USDC' && input.type !== 'stellar_account') ||
        (input.asset !== 'USDC' && input.type === 'stellar_account')
      )
        throw new PaymentError(
          422,
          'instrument_asset_mismatch',
          'Stellar instruments require USDC; local instruments require fiat',
        );
      return {
        status: 201,
        body: (
          await c.query(
            'INSERT INTO instruments(id,merchant_id,customer_id,type,asset,label,sandbox_identifier) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,customer_id,type,asset,label,sandbox_identifier,verified,created_at',
            [
              id('inst'),
              merchantId,
              customerId,
              input.type,
              input.asset,
              input.label,
              input.sandbox_identifier,
            ],
          )
        ).rows[0],
      };
    },
  );
  app.get<{ Params: { id: string } }>('/v1/customers/:id/instruments', async (request) => {
    const merchantId = principal(request, 'customers:read');
    await owned('customers', request.params.id, merchantId);
    return page('instruments', merchantId, request.query, {
      field: 'customer_id',
      value: request.params.id,
    });
  });
  write('/v1/quotes', 'payments:write', quoteSchema, async (c, m, input) => ({
    status: 201,
    body: publicQuote(await createQuote(c, m, input)),
  }));
  app.get<{ Params: { id: string } }>('/v1/quotes/:id', async (request) =>
    publicQuote(await owned('quotes', request.params.id, principal(request, 'payments:read'))),
  );
  write('/v1/intents', 'payments:write', intentSchema, async (c, m, input) => {
    const intent = await createIntent(c, m, input);
    await options.beforeIntentCommit?.(c, intent);
    return { status: 201, body: publicIntent(intent) };
  });
  app.get('/v1/intents', async (request) => {
    const result = await page('intents', principal(request, 'payments:read'), request.query);
    return { ...result, data: result.data.map((i) => publicIntent(i as Intent)) };
  });
  app.get<{ Params: { id: string } }>('/v1/intents/:id', async (request) => {
    const merchantId = principal(request, 'payments:read'),
      intent = await owned('intents', request.params.id, merchantId);
    const history = (
      await pool.query(
        'SELECT state,detail,created_at FROM intent_history WHERE intent_id=$1 ORDER BY created_at,id',
        [intent.id],
      )
    ).rows;
    return { ...publicIntent(intent), history };
  });
  write('/v1/intents/:id/cancel', 'payments:write', empty, async (c, m, _input, request) => ({
    status: 200,
    body: publicIntent(
      await cancelIntent(c, m, typedId.parse((request.params as { id: string }).id)),
    ),
  }));
  app.get('/v1/events', (request) =>
    page('events', principal(request, 'payments:read'), request.query),
  );
  write('/v1/webhook_endpoints', 'webhooks:write', webhookSchema, async (c, m, input) => {
    const url = validateWebhookUrl(input.url),
      secret = webhookSecret();
    const endpoint = (
      await c.query(
        'INSERT INTO webhook_endpoints(id,merchant_id,url,secret) VALUES($1,$2,$3,$4) RETURNING id,url,active,created_at',
        [id('whe'), m, url, encryptWebhookSecret(secret)],
      )
    ).rows[0];
    return { status: 201, body: { ...endpoint, secret } };
  });
  app.get('/v1/webhook_endpoints', async (request) => {
    const result = await page(
      'webhook_endpoints',
      principal(request, 'webhooks:read'),
      request.query,
    );
    return { ...result, data: result.data.map(({ secret, merchant_id, ...row }) => row) };
  });
  write(
    '/v1/webhook_endpoints/:id/disable',
    'webhooks:write',
    empty,
    async (c, m, _input, request) => {
      const endpointId = typedId.parse((request.params as { id: string }).id);
      const endpoint = (
        await c.query(
          'UPDATE webhook_endpoints SET active=false WHERE id=$1 AND merchant_id=$2 RETURNING id,url,active',
          [endpointId, m],
        )
      ).rows[0];
      if (!endpoint)
        throw new PaymentError(404, 'endpoint_not_found', 'Webhook endpoint not found');
      await c.query(
        "UPDATE webhook_deliveries SET state='failed',last_error='endpoint_disabled',locked_by=NULL,locked_until=NULL WHERE endpoint_id=$1 AND state='pending'",
        [endpointId],
      );
      return { status: 200, body: endpoint };
    },
  );
  app.get('/v1/webhook_deliveries', async (request) => {
    const merchantId = principal(request, 'webhooks:read');
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
      .strict()
      .parse(request.query);
    return {
      data: (
        await pool.query(
          'SELECT d.id,d.endpoint_id,d.event_id,d.state,d.attempts,d.status_code,d.last_error,d.next_attempt_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id JOIN events v ON v.id=d.event_id WHERE e.merchant_id=$1 ORDER BY v.created_at DESC,d.id LIMIT $2',
          [merchantId, limit],
        )
      ).rows,
    };
  });
  write('/v1/events/:id/replay', 'webhooks:write', empty, async (c, m, _input, request) => {
    const eventId = typedId.parse((request.params as { id: string }).id);
    if (
      !(await c.query('SELECT 1 FROM events WHERE id=$1 AND merchant_id=$2', [eventId, m])).rowCount
    )
      throw new PaymentError(404, 'event_not_found', 'Event not found');
    const deliveries = await c.query(
      "INSERT INTO webhook_deliveries(id,endpoint_id,event_id) SELECT $1 || '_' || id,id,$2 FROM webhook_endpoints WHERE merchant_id=$3 AND active=true ON CONFLICT(endpoint_id,event_id) DO UPDATE SET state='pending',attempts=0,next_attempt_at=now(),last_error=NULL,status_code=NULL,locked_by=NULL,locked_until=NULL RETURNING id",
      [id('dlv'), eventId, m],
    );
    return { status: 202, body: { event_id: eventId, queued: deliveries.rowCount } };
  });
  app.post('/internal/providers/fake/callback', async (request) => {
    const secret = process.env.KORA_PROVIDER_CALLBACK_SECRET;
    if (!secret || secret.length < 32)
      throw new PaymentError(
        503,
        'callback_not_configured',
        'Provider callback secret is not configured',
      );
    const signature = request.headers['kora-signature'];
    if (typeof signature !== 'string' || !verifyWebhook(request.rawBody, signature, secret))
      throw new PaymentError(
        401,
        'invalid_callback_signature',
        'Provider callback signature is invalid',
      );
    const status = z
      .object({
        provider_ref: z.string().min(1).max(160),
        outcome: z.enum(['confirmed', 'rejected']),
        evidence: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(request.body) as unknown as ProviderStatus;
    await consumeCallback(status);
    return { received: true };
  });
  await registerNetwork(app);
  await registerControls(app);
  await registerRails(app, options.paystackClient);
  await registerStellar(app, options.stellarConnector);
  await registerProduct(app);
  await registerPersonal(app, options.personal, options.privyConfig, options.paystackClient);
  registerDidit(app);
  await registerSessions(app, options.privyConfig, options.personal);
  app.get('/openapi.json', async () => app.swagger());
  await app.ready();
  return app;
}
