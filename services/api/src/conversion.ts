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
 * Buying stablecoins with naira (and sell quotes) through Fonbnk. The customer pays
 * Fonbnk's own bank instructions, so Microsendr never holds the naira, and coins are
 * delivered only to a self-custody wallet the customer linked.
 */
// US-dollar stablecoins on EVM networks only: the delivery address is an EVM wallet,
// and naira-pegged or other fiat tokens would amount to fiat-to-fiat exchange.
const ALLOWED_ASSETS = new Set(['POLYGON_USDC', 'POLYGON_USDT', 'BASE_USDC', 'CELO_USDT', 'CELO_USDC', 'ARBITRUM_USDC',
  'ARBITRUM_USDT', 'OPTIMISM_USDC', 'ETHEREUM_USDC', 'ETHEREUM_USDT', 'BNB_USDT']);
export const conversionAssets = () =>
  (process.env.FONBNK_ASSETS || 'POLYGON_USDC,BASE_USDC,CELO_USDT').split(',').map((v) => v.trim()).filter((v) => ALLOWED_ASSETS.has(v));
const networkNames: Record<string, string> = { POLYGON: 'Polygon', BASE: 'Base', CELO: 'Celo', ARBITRUM: 'Arbitrum', OPTIMISM: 'Optimism', ETHEREUM: 'Ethereum', BNB: 'BNB Chain' };
const describeAsset = (code: string) => {
  const [network, ...rest] = code.split('_');
  return { code, network: networkNames[network] ?? network, asset: rest.join('_') };
};
const feeLabels: Record<string, string> = {
  platform: 'Fonbnk service fee', provider: 'Payment provider fee', blockchain: 'Network fee', merchant: 'Microsendr fee',
};
const legs = (direction: 'buy' | 'sell', asset: string, amount: number): [LegRequest, LegRequest] => {
  const naira: LegRequest = { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', countryIsoCode: 'NG' };
  const coin: LegRequest = { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: asset };
  return direction === 'buy' ? [{ ...naira, amount, transferType: 'manual' }, coin] : [{ ...coin, amount }, naira];
};
// Naira amounts have kobo at most.
const nairaAmount = z.number().positive().max(100_000_000).refine((v) => Math.round(v * 100) === v * 100, 'Use at most two decimals');

type Cashout = NonNullable<FonbnkOrder['deposit']>['cashout'];
function feesOf(entries: [Cashout | undefined, string][]) {
  const fees: { id: string; recipient: string; label: string; amount: number; currency: string }[] = [];
  for (const [cashout, currency] of entries) {
    if (!cashout) continue;
    const listed = cashout.chargedFees.filter((f) => f.amount > 0);
    for (const f of listed) fees.push({ id: f.id, recipient: f.recipient, label: feeLabels[f.recipient] ?? f.id, amount: f.amount, currency });
    // Some corridors only report the total; never show a quote as fee-free when it is not.
    if (!listed.length && (cashout.totalChargedFees ?? 0) > 0)
      fees.push({ id: 'total', recipient: 'total', label: 'Fees', amount: cashout.totalChargedFees!, currency });
  }
  return fees;
}

function publicQuote(direction: 'buy' | 'sell', quote: FonbnkQuote, sandbox: boolean) {
  const pay = quote.deposit, receive = quote.payout;
  const fields = [...(pay.fieldsToCreateOrder ?? []), ...(receive.fieldsToCreateOrder ?? [])]
    .map((field) => z.object({ key: z.string() }).passthrough().safeParse(field))
    .flatMap((parsed) => parsed.success ? [parsed.data as Record<string, unknown> & { key: string }] : [])
    .filter((field) => !/^blockchain(WalletAddress|Memo)$/.test(field.key));
  // The naira-per-dollar rate lives on the fiat leg: the deposit for a buy, the payout for a sell.
  const fiat = direction === 'buy' ? pay : receive;
  return {
    quote_id: quote.quoteId, expires_at: quote.quoteExpiresAt, direction, environment: sandbox ? 'sandbox' : 'production',
    pay: { currency: pay.currencyCode, amount: pay.cashout.amountBeforeFees },
    receive: { currency: receive.currencyCode, amount: receive.cashout.amountAfterFees },
    rate: fiat.cashout.exchangeRate, rate_after_fees: fiat.cashout.exchangeRateAfterFees ?? null,
    fees: feesOf([[pay.cashout, pay.currencyCode], [receive.cashout, receive.currencyCode]]),
    total_fees_usd: (pay.cashout.totalChargedFeesUsd ?? 0) + (receive.cashout.totalChargedFeesUsd ?? 0),
    fields: direction === 'buy' ? fields : [],
  };
}

function publicOrder(row: Record<string, any>) {
  return {
    id: row.id, status: row.status, direction: row.direction, provider: row.provider, environment: row.provider_environment,
    pay: { currency: row.pay_currency, amount: Number(row.pay_amount) },
    receive: { ...describeAsset(row.receive_asset), amount: Number(row.receive_amount) },
    wallet_address: getAddress(row.wallet_address), fees: row.fees, transfer_instructions: row.transfer_instructions,
    quote_used: row.quote_used, expires_at: row.provider_expires_at, payout_tx_hash: row.payout_tx_hash,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// Fonbnk's documented error codes, in Microsendr words. Anything else is logged, not shown.
function providerError(error: unknown, log?: (detail: Record<string, unknown>) => void): never {
  if (error instanceof FonbnkError) {
    const min = error.details.min, max = error.details.max;
    const naira = (v: unknown) => (typeof v === 'number' ? `₦${v.toLocaleString('en-US')}` : 'the limit');
    const known: Record<string, [number, string]> = {
      AMOUNT_BELOW_MINIMUM: [422, `The minimum is ${naira(min)}.`],
      AMOUNT_ABOVE_MAXIMUM: [422, `The maximum is ${naira(max)}.`],
      AMOUNT_STEP_INVALID: [422, 'Try a rounder amount.'],
      AMOUNT_NOT_COVERED: [422, 'That amount is not available right now. Try a different amount.'],
      ROUTE_NOT_AVAILABLE: [503, 'Buying with naira is busy right now. Try again in a moment.'],
      QUOTE_REQUIRED: [409, 'Get a new quote and try again.'],
    };
    if (known[error.code]) throw new PaymentError(known[error.code][0], 'conversion_' + error.code.toLowerCase(), known[error.code][1]);
    if (error.status === 403) throw new PaymentError(503, 'conversion_unavailable', 'Buying with naira is not enabled for Microsendr yet.');
    if (error.status === 429) throw new PaymentError(503, 'conversion_busy', 'The exchange is busy. Try again in a moment.');
    log?.({ provider_status: error.status, provider_code: error.code, provider_message: error.message.slice(0, 200) });
    throw new PaymentError(error.status >= 500 ? 503 : 422, 'conversion_provider_error',
      error.status >= 500 ? 'The exchange provider is not available right now. Try again.' : 'The exchange could not do that. Check the details and try again.');
  }
  throw error;
}

// Status order. A status never moves back, and a final status never changes. Expired or
// canceled orders can still be paid late, so they rank below a successful deposit.
const RANK: Record<string, number> = {
  creating: 0, deposit_awaiting: 1, deposit_validating: 2, deposit_invalid: 2, deposit_canceled: 2, deposit_expired: 2,
  deposit_successful: 4, payout_pending: 5, payout_failed: 5, refund_initiated: 6, refund_pending: 6, refund_failed: 6,
  payout_successful: 10, refund_successful: 10,
};
async function applyOrder(row: { id: string }, order: FonbnkOrder, quoteUsed?: boolean) {
  const hash = order.payout?.transaction?.meta?.transactionHash;
  const deposit = order.deposit?.cashout, payout = order.payout?.cashout;
  await pool.query(`UPDATE personal_conversion_orders SET
      status=CASE WHEN status IN ('payout_successful','refund_successful') OR $3::int < COALESCE(($9::jsonb->>status)::int, 0) THEN status ELSE $2 END,
      provider_order_id=COALESCE(provider_order_id,$4), provider_expires_at=COALESCE($5,provider_expires_at),
      payout_tx_hash=COALESCE($6,payout_tx_hash), quote_used=COALESCE($7,quote_used),
      transfer_instructions=COALESCE($8,transfer_instructions),
      pay_amount=COALESCE($10,pay_amount), receive_amount=COALESCE($11,receive_amount),
      fees=CASE WHEN $12::jsonb='[]'::jsonb THEN fees ELSE $12::jsonb END,
      last_checked_at=now(),updated_at=now() WHERE id=$1`,
    [row.id, order.status, RANK[order.status] ?? 1, order._id, order.expiresAt ?? null, typeof hash === 'string' ? hash : null,
      quoteUsed ?? null, order.deposit?.transferInstructions ? JSON.stringify(order.deposit.transferInstructions) : null, JSON.stringify(RANK),
      deposit?.amountBeforeFees ?? null, payout?.amountAfterFees && payout.amountAfterFees > 0 ? payout.amountAfterFees : null,
      JSON.stringify(feesOf([[deposit, 'NGN'], [payout, '']]).map((f) => ({ ...f, currency: f.currency || undefined })))]);
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
    return { available: configured(), provider: 'fonbnk', environment: configured() && provider().sandbox ? 'sandbox' : 'production',
      pay_currency: 'NGN', assets: conversionAssets().map(describeAsset), sell_orders: false };
  });

  // Fonbnk's own min and max for buying this asset with naira.
  app.get('/personal/api/conversion/limits', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request);
    const { asset } = z.object({ asset: z.string().refine((v) => conversionAssets().includes(v), 'Unsupported asset') }).strict().parse(request.query);
    try {
      const limits = await provider().limits(...legs('buy', asset, 1).map(({ amount: _a, transferType: _t, ...leg }) => leg) as [LegRequest, LegRequest]);
      return { supported: limits.supported, min: limits.deposit.min, max: limits.deposit.max, currency: 'NGN' };
    } catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk limits failed')); }
  });

  // Whether Fonbnk needs the customer's BVN before a first naira purchase, and where to give it.
  app.get('/personal/api/conversion/kyc', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request);
    const owner = (await pool.query('SELECT email,email_verified_at FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    if (!owner?.email_verified_at || !owner.email) throw new PaymentError(403, 'verified_email_required', 'Verify your email before buying');
    try { return kycView(await provider().userKyc(owner.email)); }
    catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk kyc failed')); }
  });

  app.post('/personal/api/conversion/quote', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const input = z.object({
      direction: z.enum(['buy', 'sell']), asset: z.string().refine((v) => conversionAssets().includes(v), 'Unsupported asset'),
      amount: z.number().positive().max(100_000_000),
    }).strict().parse(request.body);
    if (input.direction === 'buy') nairaAmount.parse(input.amount);
    let quote;
    try { quote = await provider().quote(...legs(input.direction, input.asset, input.amount)); }
    catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk quote failed')); }
    const view = publicQuote(input.direction, quote, provider().sandbox);
    await pool.query(`INSERT INTO personal_conversion_quotes(quote_id,personal_user_id,direction,asset,amount,pay_amount,receive_amount,fees,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (quote_id) DO NOTHING`,
      [view.quote_id, person.user_id, input.direction, input.asset, input.amount, view.pay.amount, view.receive.amount, JSON.stringify(view.fees), view.expires_at]);
    return view;
  });

  app.get('/personal/api/conversion/orders', async (request) => {
    const person = await required(request);
    const rows = (await pool.query(`SELECT * FROM personal_conversion_orders WHERE personal_user_id=$1 AND status<>'create_failed'
      ORDER BY created_at DESC LIMIT 20`, [person.user_id])).rows;
    return { data: rows.map(publicOrder) };
  });

  app.post('/personal/api/conversion/orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
    const input = z.object({
      quote_id: z.string().min(1).max(200), asset: z.string().refine((v) => conversionAssets().includes(v), 'Unsupported asset'),
      amount: nairaAmount, wallet_id: z.string().regex(/^cwa_[a-f0-9]{32}$/),
      fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(120)).refine((f) => Object.keys(f).length <= 20),
    }).strict().parse(request.body);
    const fields = Object.fromEntries(Object.entries(input.fields).filter(([k]) => !/^blockchain(WalletAddress|Memo)$/.test(k)));
    // The key is bound to what was asked: the same key with other details is refused.
    const requestHash = createHash('sha256').update(JSON.stringify([input.quote_id, input.asset, input.amount, input.wallet_id, fields])).digest('hex');
    const previous = (await pool.query('SELECT * FROM personal_conversion_orders WHERE personal_user_id=$1 AND idempotency_key=$2', [person.user_id, key])).rows[0];
    if (previous) {
      if (previous.request_hash && previous.request_hash !== requestHash) throw new PaymentError(409, 'idempotency_conflict', 'This request key was used for another order');
      if (previous.status === 'create_failed') throw new PaymentError(409, 'order_failed', 'That order did not go through. Get a new quote and try again.');
      if (previous.status === 'creating') throw new PaymentError(409, 'order_in_progress', 'Your order is still being created. Check again in a moment.');
      return publicOrder(previous);
    }
    const owner = (await pool.query('SELECT email,email_verified_at FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    if (!owner?.email_verified_at || !owner.email) throw new PaymentError(403, 'verified_email_required', 'Verify your email before buying');
    // Coins go only to a wallet the customer controls on every EVM network.
    const wallet = (await pool.query(`SELECT address FROM personal_chain_wallets WHERE id=$1 AND personal_user_id=$2 AND account_id=$3 AND status='active'`,
      [input.wallet_id, person.user_id, person.account_id])).rows[0];
    if (!wallet) throw new PaymentError(403, 'wallet_not_linked', 'Choose one of your linked wallets');
    // Only a quote this customer received, still valid, for this asset and amount.
    const quote = (await pool.query(`SELECT * FROM personal_conversion_quotes WHERE quote_id=$1 AND personal_user_id=$2 AND direction='buy'`,
      [input.quote_id, person.user_id])).rows[0];
    if (!quote || quote.asset !== input.asset || Number(quote.amount) !== input.amount)
      throw new PaymentError(409, 'quote_mismatch', 'Get a new quote for this amount and try again.');
    if (new Date(quote.expires_at) <= new Date()) throw new PaymentError(409, 'quote_expired', 'This quote has expired. Get a new quote to see the current price.');
    // Fonbnk needs a verified BVN before the first naira purchase.
    let kyc;
    try { kyc = kycView(await provider().userKyc(owner.email)); }
    catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk kyc failed')); }
    if (!kyc.ready) throw new PaymentError(409, kyc.support_required ? 'provider_kyc_support' : 'provider_kyc_required',
      kyc.support_required ? 'Fonbnk needs to check your BVN. Contact Fonbnk support to continue.' : 'Verify your BVN with Fonbnk before your first naira purchase.');

    // Record the order first: if Fonbnk times out after creating it, the reference finds it.
    const orderId = id('cnv');
    const inserted = (await pool.query(`INSERT INTO personal_conversion_orders(id,personal_user_id,account_id,provider,provider_environment,
      direction,quote_id,idempotency_key,request_hash,pay_currency,pay_amount,receive_asset,receive_amount,wallet_address,fees,status)
      VALUES($1,$2,$3,'fonbnk',$4,'buy',$5,$6,$7,'NGN',$8,$9,$10,$11,$12,'creating')
      ON CONFLICT (personal_user_id, idempotency_key) DO NOTHING RETURNING id`,
      [orderId, person.user_id, person.account_id, provider().sandbox ? 'sandbox' : 'production', input.quote_id, key, requestHash,
        quote.pay_amount, input.asset, quote.receive_amount, wallet.address, JSON.stringify(quote.fees)])).rowCount;
    if (!inserted) throw new PaymentError(409, 'order_in_progress', 'Your order is still being created. Check again in a moment.');
    const publicApi = process.env.KORA_PUBLIC_API_URL;
    const [deposit, payout] = legs('buy', input.asset, input.amount);
    try {
      const created = await provider().createOrder({
        quoteId: input.quote_id, userEmail: owner.email, userCountryIsoCode: 'NG', userIp: request.clientIp || request.ip,
        deposit, payout, fieldsToCreateOrder: { ...fields, blockchainWalletAddress: getAddress(wallet.address) }, orderParams: orderId,
        ...(publicApi ? { webhookUrl: `${publicApi}/personal/api/webhooks/fonbnk` } : {}),
      });
      await applyOrder({ id: orderId }, created.order, created.quoteUsed ?? true);
    } catch (error) {
      // An unclear failure may still have created the order: look it up by our reference.
      const unclear = !(error instanceof FonbnkError) || error.status >= 500;
      const found = unclear ? await provider().findOrderByParams(orderId).catch(() => undefined) : null;
      if (found) await applyOrder({ id: orderId }, found);
      else {
        if (found === null || !unclear)
          await pool.query("UPDATE personal_conversion_orders SET status='create_failed',updated_at=now() WHERE id=$1 AND status='creating'", [orderId]);
        // Still unknown (lookup failed too): the worker resolves it by reference.
        providerError(error, (d) => request.log.warn(d, 'fonbnk order failed'));
      }
    }
    return publicOrder((await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [orderId])).rows[0]);
  });

  const owned = async (person: Person, orderId: string) => {
    const row = (await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1 AND personal_user_id=$2',
      [z.string().regex(/^cnv_[a-f0-9]{32}$/).parse(orderId), person.user_id])).rows[0];
    if (!row || !row.provider_order_id) throw new PaymentError(404, 'order_not_found', 'Order not found');
    return row;
  };

  app.post('/personal/api/conversion/orders/:id/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const row = await owned(person, (request.params as { id: string }).id);
    try { await applyOrder(row, await provider().getOrder(row.provider_order_id)); }
    catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk refresh failed')); }
    return publicOrder((await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [row.id])).rows[0]);
  });

  // The customer says they have paid, with any confirmation fields Fonbnk asks for.
  app.post('/personal/api/conversion/orders/:id/confirm', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const row = await owned(person, (request.params as { id: string }).id);
    const { fields } = z.object({ fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(200)).default({}) }).strict().parse(request.body ?? {});
    if (row.status !== 'deposit_awaiting') throw new PaymentError(409, 'order_not_awaiting_payment', 'This order is no longer waiting for your payment.');
    try {
      await provider().confirmOrder(row.provider_order_id, fields);
      await applyOrder(row, await provider().getOrder(row.provider_order_id));
    } catch (error) { providerError(error, (d) => request.log.warn(d, 'fonbnk confirm failed')); }
    return publicOrder((await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [row.id])).rows[0]);
  });

  // Signed status changes from Fonbnk; duplicates and out-of-order deliveries are expected.
  // A delivery is recorded only once applied; anything unresolved answers non-2xx so Fonbnk retries.
  app.post('/personal/api/webhooks/fonbnk', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const secret = process.env.FONBNK_WEBHOOK_SECRET ?? '';
    if (!verifyFonbnkWebhook(request.rawBody, request.headers['x-signature'], secret))
      throw new PaymentError(401, 'invalid_signature', 'Invalid webhook signature');
    reply.header('cache-control', 'no-store');
    const event = z.object({ event: z.string(), data: z.object({ order: z.object({ _id: z.string(), status: z.string(),
      merchantOrderParams: z.string().optional() }).passthrough() }).passthrough() }).passthrough().safeParse(request.body);
    if (!event.success || event.data.event !== 'order-status-change') return { ok: true };
    const bodyHash = createHash('sha256').update(request.rawBody).digest('hex');
    if ((await pool.query('SELECT 1 FROM fonbnk_webhook_events WHERE body_hash=$1', [bodyHash])).rowCount) return { ok: true };
    const order = event.data.data.order;
    const row = (await pool.query('SELECT id FROM personal_conversion_orders WHERE provider_order_id=$1 OR id=$2',
      [order._id, order.merchantOrderParams ?? ''])).rows[0];
    if (!row) throw new PaymentError(404, 'order_not_found', 'Order not known yet');
    // Re-read the order rather than trust delivery order; the webhook is a signal.
    let fresh;
    try { fresh = await provider().getOrder(order._id); }
    catch { throw new PaymentError(503, 'provider_unavailable', 'Order could not be read; retry'); }
    await applyOrder(row, fresh);
    await pool.query('INSERT INTO fonbnk_webhook_events(body_hash,provider_order_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [bodyHash, order._id, order.status]);
    return { ok: true };
  });
}

function kycView(kyc: import('../../../connectors/fonbnk/src/index.js').FonbnkKyc) {
  const blocked = !!kyc.requiredKycType || !!kyc.isNgBvnBlocked;
  return {
    ready: !blocked, passed: kyc.passedKycType ?? null, status: kyc.currentKycStatus ?? null,
    support_required: blocked && !!kyc.isNgBvnSupportLocked, limit_reached: !!kyc.reachedKycLimit,
    kyc_url: blocked && !kyc.isNgBvnSupportLocked ? kyc.kycUrls?.basic ?? null : null,
  };
}

// Back off by status and age: quick while a payment is expected, slow once it settles or
// stalls, and stop polling unpaid orders after three days.
function nextCheckSeconds(status: string, ageHours: number, checks: number) {
  if (['deposit_awaiting', 'deposit_expired', 'deposit_canceled', 'deposit_invalid'].includes(status) && ageHours > 72) return null;
  if (['payout_failed', 'refund_failed'].includes(status)) return 6 * 3600;
  if (ageHours < 1) return 180;
  return Math.min(6 * 3600, 600 * 2 ** Math.min(checks, 6));
}

/** Worker job: refresh one due open order, resolving orders whose creation was unclear. */
export async function reconcileOneConversionOrder(client?: FonbnkClient) {
  if (!client && !FonbnkClient.configured()) return false;
  const provider = client ?? FonbnkClient.fromEnvironment();
  const environment = provider.sandbox ? 'sandbox' : 'production';
  const row = (await pool.query(`UPDATE personal_conversion_orders SET next_check_at=now()+interval '5 minutes',last_checked_at=now()
    WHERE id=(SELECT id FROM personal_conversion_orders WHERE status <> ALL($1::text[]) AND provider_environment=$2 AND next_check_at<=now()
      ORDER BY next_check_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, provider_order_id, status, created_at, check_count`, [[...FINAL_STATUSES, 'create_failed'], environment])).rows[0];
  if (!row) return false;
  try {
    const order = row.provider_order_id ? await provider.getOrder(row.provider_order_id) : await provider.findOrderByParams(row.id);
    if (!order) {
      // Never created at Fonbnk: close it after a few minutes of grace.
      if (Date.now() - new Date(row.created_at).getTime() > 10 * 60_000)
        await pool.query("UPDATE personal_conversion_orders SET status='create_failed',updated_at=now() WHERE id=$1 AND status='creating'", [row.id]);
      return true;
    }
    await applyOrder(row, order);
    const current = (await pool.query('SELECT status FROM personal_conversion_orders WHERE id=$1', [row.id])).rows[0].status;
    const next = nextCheckSeconds(current, (Date.now() - new Date(row.created_at).getTime()) / 3_600_000, row.check_count);
    await pool.query(`UPDATE personal_conversion_orders SET check_count=check_count+1,
      next_check_at=CASE WHEN $2::int IS NULL THEN 'infinity'::timestamptz ELSE now()+($2::int*interval '1 second') END WHERE id=$1`, [row.id, next]);
  } catch (error) {
    const wait = error instanceof FonbnkError && error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 900;
    await pool.query("UPDATE personal_conversion_orders SET next_check_at=now()+($2::int*interval '1 second') WHERE id=$1", [row.id, wait]);
    throw error;
  }
  return true;
}
