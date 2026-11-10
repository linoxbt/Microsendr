import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress } from 'viem';
import { z } from 'zod';
import { id, pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import {
  FINAL_STATUSES, FonbnkClient, FonbnkError, verifyFonbnkWebhook,
  type FonbnkOrder, type FonbnkQuote, type LegRequest,
} from '../../../connectors/fonbnk/src/index.js';

type Person = { user_id: string; account_id: string; email: string | null };

/**
 * Buy and sell quotes, and buying stablecoins with naira, through Fonbnk. The customer
 * pays Fonbnk's own bank instructions, so Roots never holds the naira, and coins are
 * delivered only to a self-custody wallet the customer linked: Fonbnk does not serve
 * QIE, and the Roots account wallet can only send on QIE.
 */
export const conversionAssets = () =>
  (process.env.FONBNK_ASSETS || 'POLYGON_USDC,BASE_USDC,CELO_USDT').split(',').map((v) => v.trim()).filter((v) => /^[A-Z0-9]+_[A-Z0-9_]+$/.test(v));
const networkNames: Record<string, string> = { POLYGON: 'Polygon', BASE: 'Base', CELO: 'Celo', ARBITRUM: 'Arbitrum', OPTIMISM: 'Optimism', ETHEREUM: 'Ethereum', BNB: 'BNB Chain', AVALANCHE: 'Avalanche' };
const describeAsset = (code: string) => {
  const [network, ...rest] = code.split('_');
  return { code, network: networkNames[network] ?? network, asset: rest.join('_') };
};
const feeLabels: Record<string, string> = {
  platform: 'Fonbnk service fee', provider: 'Payment provider fee', blockchain: 'Network fee', merchant: 'Roots fee',
};
const legs = (direction: 'buy' | 'sell', asset: string, amount: number): [LegRequest, LegRequest] => {
  const naira: LegRequest = { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', countryIsoCode: 'NG' };
  const coin: LegRequest = { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: asset };
  return direction === 'buy'
    ? [{ ...naira, amount, transferType: 'manual' }, coin]
    : [{ ...coin, amount }, naira];
};

function publicQuote(direction: 'buy' | 'sell', quote: FonbnkQuote) {
  const pay = quote.deposit, receive = quote.payout;
  const fees = [...pay.cashout.chargedFees.map((f) => ({ ...f, currency: pay.currencyCode })),
    ...receive.cashout.chargedFees.map((f) => ({ ...f, currency: receive.currencyCode }))]
    .filter((f) => f.amount > 0)
    .map((f) => ({ id: f.id, recipient: f.recipient, label: feeLabels[f.recipient] ?? f.id, amount: f.amount, currency: f.currency }));
  // Fields Fonbnk needs to create the order. The destination wallet is always set by Roots.
  const fields = [...(pay.fieldsToCreateOrder ?? []), ...(receive.fieldsToCreateOrder ?? [])]
    .map((field) => z.object({ key: z.string() }).passthrough().safeParse(field))
    .flatMap((parsed) => parsed.success ? [parsed.data as Record<string, unknown> & { key: string }] : [])
    .filter((field) => !/^blockchain(WalletAddress|Memo)$/.test(field.key));
  return {
    quote_id: quote.quoteId, expires_at: quote.quoteExpiresAt, direction,
    pay: { currency: pay.currencyCode, amount: pay.cashout.amountBeforeFees },
    receive: { currency: receive.currencyCode, amount: receive.cashout.amountAfterFees },
    rate: receive.cashout.exchangeRate, rate_after_fees: receive.cashout.exchangeRateAfterFees ?? null,
    fees, total_fees_usd: (pay.cashout.totalChargedFeesUsd ?? 0) + (receive.cashout.totalChargedFeesUsd ?? 0),
    fields: direction === 'buy' ? fields : [],
  };
}

function publicOrder(row: Record<string, any>) {
  return {
    id: row.id, status: row.status, direction: row.direction, provider: row.provider, environment: row.provider_environment,
    pay: { currency: row.pay_currency, amount: Number(row.pay_amount) },
    receive: { ...describeAsset(row.receive_asset), amount: Number(row.receive_amount) },
    wallet_address: getAddress(row.wallet_address), fees: row.fees, transfer_instructions: row.transfer_instructions,
    expires_at: row.provider_expires_at, payout_tx_hash: row.payout_tx_hash, created_at: row.created_at, updated_at: row.updated_at,
  };
}

function providerError(error: unknown): never {
  if (error instanceof FonbnkError) {
    if (error.code === 'NG_BVN_REQUIRED')
      throw new PaymentError(409, 'provider_kyc_required', 'Fonbnk needs to verify your BVN before your first naira purchase.');
    if (error.status === 403)
      throw new PaymentError(503, 'conversion_unavailable', 'Buying with naira is not enabled for Roots yet.');
    throw new PaymentError(error.status >= 500 ? 503 : 422, 'conversion_provider_error', error.message);
  }
  throw error;
}

async function applyOrder(row: { id: string }, order: FonbnkOrder) {
  const hash = order.payout?.transaction?.meta?.transactionHash;
  await pool.query(`UPDATE personal_conversion_orders SET status=$2,provider_expires_at=COALESCE($3,provider_expires_at),
    payout_tx_hash=COALESCE($4,payout_tx_hash),last_checked_at=now(),updated_at=now() WHERE id=$1`,
    [row.id, order.status, order.expiresAt ?? null, typeof hash === 'string' ? hash : null]);
}

export function registerConversion(app: FastifyInstance, required: (request: FastifyRequest, write?: boolean) => Promise<Person>, client?: FonbnkClient) {
  const provider = () => {
    if (client) return client;
    if (!FonbnkClient.configured()) throw new PaymentError(503, 'conversion_unavailable', 'Currency conversion is not available yet.');
    return FonbnkClient.fromEnvironment();
  };
  const configured = () => !!client || FonbnkClient.configured();

  app.get('/personal/api/conversion/config', async (request) => {
    await required(request);
    return { available: configured(), provider: 'fonbnk', pay_currency: 'NGN', assets: conversionAssets().map(describeAsset), sell_orders: false };
  });

  app.post('/personal/api/conversion/quote', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request, true);
    const input = z.object({
      direction: z.enum(['buy', 'sell']), asset: z.string().refine((v) => conversionAssets().includes(v), 'Unsupported asset'),
      amount: z.number().positive().max(100_000_000),
    }).strict().parse(request.body);
    try {
      return publicQuote(input.direction, await provider().quote(...legs(input.direction, input.asset, input.amount)));
    } catch (error) { providerError(error); }
  });

  app.get('/personal/api/conversion/orders', async (request) => {
    const person = await required(request);
    const rows = (await pool.query('SELECT * FROM personal_conversion_orders WHERE personal_user_id=$1 ORDER BY created_at DESC LIMIT 20', [person.user_id])).rows;
    return { data: rows.map(publicOrder) };
  });

  app.post('/personal/api/conversion/orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
    const input = z.object({
      quote_id: z.string().min(1).max(200), asset: z.string().refine((v) => conversionAssets().includes(v), 'Unsupported asset'),
      amount: z.number().positive().max(100_000_000), wallet_id: z.string().regex(/^cwa_[a-f0-9]{32}$/),
      fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(120)).refine((f) => Object.keys(f).length <= 20),
    }).strict().parse(request.body);
    const previous = (await pool.query('SELECT * FROM personal_conversion_orders WHERE personal_user_id=$1 AND idempotency_key=$2', [person.user_id, key])).rows[0];
    if (previous) return publicOrder(previous);
    const owner = (await pool.query('SELECT email,email_verified_at FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    if (!owner?.email_verified_at || !owner.email) throw new PaymentError(403, 'verified_email_required', 'Verify your email before buying');
    // Coins go only to a wallet the customer controls on every EVM network.
    const wallet = (await pool.query(`SELECT address FROM personal_chain_wallets WHERE id=$1 AND personal_user_id=$2 AND account_id=$3 AND status='active'`,
      [input.wallet_id, person.user_id, person.account_id])).rows[0];
    if (!wallet) throw new PaymentError(403, 'wallet_not_linked', 'Choose one of your linked wallets');
    const [deposit, payout] = legs('buy', input.asset, input.amount);
    const fields = Object.fromEntries(Object.entries(input.fields).filter(([k]) => !/^blockchain(WalletAddress|Memo)$/.test(k)));
    const orderId = id('cnv');
    const publicApi = process.env.KORA_PUBLIC_API_URL;
    let created;
    try {
      created = await provider().createOrder({
        quoteId: input.quote_id, userEmail: owner.email, userCountryIsoCode: 'NG', userIp: request.clientIp || request.ip,
        deposit, payout, fieldsToCreateOrder: { ...fields, blockchainWalletAddress: getAddress(wallet.address) }, orderParams: orderId,
        ...(publicApi ? { webhookUrl: `${publicApi}/personal/api/webhooks/fonbnk` } : {}),
      });
    } catch (error) { providerError(error); }
    const order = created.order;
    const cashout = (leg: 'deposit' | 'payout') => order[leg]?.cashout;
    const fees = [...(cashout('deposit')?.chargedFees ?? []), ...(cashout('payout')?.chargedFees ?? [])]
      .filter((f) => f.amount > 0).map((f) => ({ id: f.id, recipient: f.recipient, label: feeLabels[f.recipient] ?? f.id, amount: f.amount }));
    const row = (await pool.query(`INSERT INTO personal_conversion_orders(id,personal_user_id,account_id,provider,provider_environment,provider_order_id,
      direction,quote_id,idempotency_key,pay_currency,pay_amount,receive_asset,receive_amount,wallet_address,fees,transfer_instructions,status,provider_expires_at)
      VALUES($1,$2,$3,'fonbnk',$4,$5,'buy',$6,$7,'NGN',$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (personal_user_id, idempotency_key) DO NOTHING RETURNING *`,
      [orderId, person.user_id, person.account_id, provider().sandbox ? 'sandbox' : 'production', order._id, input.quote_id, key,
        cashout('deposit')?.amountBeforeFees ?? input.amount, input.asset, cashout('payout')?.amountAfterFees ?? 0.00000001,
        wallet.address, JSON.stringify(fees), JSON.stringify(order.deposit?.transferInstructions ?? null), order.status, order.expiresAt ?? null])).rows[0];
    return publicOrder(row ?? (await pool.query('SELECT * FROM personal_conversion_orders WHERE personal_user_id=$1 AND idempotency_key=$2', [person.user_id, key])).rows[0]);
  });

  const owned = async (person: Person, orderId: string) => {
    const row = (await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1 AND personal_user_id=$2',
      [z.string().regex(/^cnv_[a-f0-9]{32}$/).parse(orderId), person.user_id])).rows[0];
    if (!row) throw new PaymentError(404, 'order_not_found', 'Order not found');
    return row;
  };

  app.post('/personal/api/conversion/orders/:id/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const row = await owned(person, (request.params as { id: string }).id);
    try { await applyOrder(row, await provider().getOrder(row.provider_order_id)); } catch (error) { providerError(error); }
    return publicOrder((await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [row.id])).rows[0]);
  });

  // The customer says they have paid; Fonbnk may ask for confirmation fields (e.g. a reference).
  app.post('/personal/api/conversion/orders/:id/confirm', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const row = await owned(person, (request.params as { id: string }).id);
    const { fields } = z.object({ fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(200)).default({}) }).strict().parse(request.body ?? {});
    try {
      await provider().confirmOrder(row.provider_order_id, fields);
      await applyOrder(row, await provider().getOrder(row.provider_order_id));
    } catch (error) { providerError(error); }
    return publicOrder((await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [row.id])).rows[0]);
  });

  // Signed status changes from Fonbnk; duplicates and out-of-order deliveries are expected.
  app.post('/personal/api/webhooks/fonbnk', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const secret = process.env.FONBNK_WEBHOOK_SECRET ?? '';
    if (!verifyFonbnkWebhook(request.rawBody, request.headers['x-signature'], secret))
      throw new PaymentError(401, 'invalid_signature', 'Invalid webhook signature');
    const event = z.object({ event: z.string(), data: z.object({ order: z.object({ _id: z.string(), status: z.string() }).passthrough() }).passthrough() })
      .passthrough().safeParse(request.body);
    if (event.success && event.data.event === 'order-status-change') {
      const order = event.data.data.order;
      const first = await pool.query('INSERT INTO fonbnk_webhook_events(body_hash,provider_order_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [createHash('sha256').update(request.rawBody).digest('hex'), order._id, order.status]);
      const row = (await pool.query('SELECT id FROM personal_conversion_orders WHERE provider_order_id=$1', [order._id])).rows[0];
      // Re-read the order rather than trust ordering; the webhook is a signal.
      if (first.rowCount && row) {
        try { await applyOrder(row, await provider().getOrder(order._id)); }
        catch { await applyOrder(row, order as FonbnkOrder); }
      }
    }
    reply.header('cache-control', 'no-store');
    return { ok: true };
  });
}

/** Worker job: refresh one open order every few minutes, for up to 14 days. */
export async function reconcileOneConversionOrder(client?: FonbnkClient) {
  if (!client && !FonbnkClient.configured()) return false;
  const provider = client ?? FonbnkClient.fromEnvironment();
  const row = (await pool.query(`UPDATE personal_conversion_orders SET last_checked_at=now()
    WHERE id=(SELECT id FROM personal_conversion_orders WHERE status <> ALL($1::text[])
      AND (last_checked_at IS NULL OR last_checked_at < now()-interval '3 minutes') AND created_at > now()-interval '14 days'
      ORDER BY last_checked_at NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, provider_order_id`, [[...FINAL_STATUSES]])).rows[0];
  if (!row) return false;
  await applyOrder(row, await provider.getOrder(row.provider_order_id));
  return true;
}
