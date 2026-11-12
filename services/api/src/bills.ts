import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress } from 'viem';
import { z } from 'zod';
import { id, pool } from '../../../packages/database/src/index.js';
import { PaymentError } from '../../../packages/payments/src/errors.js';
import { QUSDC_DECIMALS } from '../../../packages/qie/src/index.js';
import { approveSend, sendApprovalSchema } from './payment-auth.js';
import { managedTransfersEnabled, sendFromManagedWallet } from './managed-transfer.js';
import { configuredEscrow, type Escrow } from './escrow.js';

type Person = { user_id: string; account_id: string; email: string | null };

/**
 * Airtime, mobile data and gift cards (including subscription cards such as Netflix
 * and Spotify), paid in QUSDC from the account wallet. The customer's QUSDC goes to
 * the Microsendr treasury as an ordinary on-chain send; the provider order is placed
 * only once that payment is confirmed, with the Microsendr order id as the provider's
 * custom identifier so a retry can never buy twice.
 */
export type Operator = {
  id: number; name: string; countryCode: string; logo: string | null; data: boolean;
  currency: string; denomination: 'RANGE' | 'FIXED';
  min: number | null; max: number | null; fixed: number[];
  plans: { amount: number; description: string }[];
};
export type GiftCard = {
  id: number; name: string; brand: string; countryCode: string; logo: string | null;
  currency: string; denomination: 'RANGE' | 'FIXED'; fixed: number[]; min: number | null; max: number | null;
};
export type ProviderOrder = { transactionId: string; status: 'SUCCESSFUL' | 'PENDING' | 'FAILED'; details: Record<string, unknown> };
export interface BillsProvider {
  readonly sandbox: boolean;
  detectOperator(phone: string, countryCode: string): Promise<Operator | null>;
  operators(countryCode: string): Promise<Operator[]>;
  operator(operatorId: number): Promise<Operator>;
  /** What one top-up of `localAmount` (in the operator's currency) costs Microsendr, in US dollars. */
  topupCostUsd(operatorId: number, localAmount: number): Promise<number>;
  topup(input: { operatorId: number; localAmount: number; phone: string; countryCode: string; reference: string }): Promise<ProviderOrder>;
  findTopup(reference: string, transactionId?: string): Promise<ProviderOrder | null>;
  giftCards(countryCode: string): Promise<GiftCard[]>;
  giftCard(productId: number): Promise<GiftCard>;
  /** US-dollar cost of one card of `faceAmount` (in the card's currency). */
  giftCardCostUsd(productId: number, faceAmount: number): Promise<number>;
  orderGiftCard(input: { productId: number; countryCode: string; faceAmount: number; email: string; senderName: string; reference: string }): Promise<ProviderOrder>;
  findGiftCardOrder(reference: string, transactionId?: string): Promise<ProviderOrder | null>;
  giftCardCodes(transactionId: string): Promise<{ code: string; pin: string | null }[]>;
}
export class BillsProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly definite = false) { super(message); }
}

// Brands people subscribe to or top up regularly; the rest of the catalogue is left out.
const SUBSCRIPTION_BRANDS = /netflix|spotify|apple|itunes|google play|playstation|xbox|steam|amazon|youtube|disney|uber|nintendo|roblox/i;
/** Where customers pay: the MicrosendrPay escrow contract when configured, else the treasury. */
export const billsTreasury = () => {
  const escrow = configuredEscrow();
  if (escrow) return escrow.address;
  const address = process.env.BILLS_TREASURY_ADDRESS ?? '';
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? getAddress(address) : null;
};
const feeRate = () => Math.min(0.2, Math.max(0, Number(process.env.BILLS_FEE_PERCENT ?? '1.5') / 100));
/** Customer price in QUSDC base units: provider cost plus the Microsendr fee (at least 5 cents). */
export function priceOf(costUsd: number) {
  const fee = Math.max(0.05, Math.round(costUsd * feeRate() * 1e6) / 1e6);
  // Round up to the base unit without floating-point noise.
  const atomic = BigInt(Math.ceil(Math.round((costUsd + fee) * 10 ** (QUSDC_DECIMALS + 2)) / 100));
  return { feeUsd: fee, atomic };
}
const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'Enter a phone number with its country code').transform((v) => v.replace(/^\+/, ''));
const countrySchema = z.string().regex(/^[A-Z]{2}$/);
const FINAL = ['delivered', 'payment_failed', 'refund_due', 'refunded'];

function publicOrder(row: Record<string, any>, codes?: { code: string; pin: string | null }[]) {
  return {
    id: row.id, kind: row.kind, status: row.status, product_name: row.product_name, country_code: row.country_code,
    recipient: row.recipient_phone ? `+${row.recipient_phone}` : row.recipient_email,
    face: { amount: Number(row.face_amount), currency: row.face_currency },
    price_atomic: String(row.price_atomic), fee_usd: Number(row.fee_usd), settlement_id: row.settlement_id,
    environment: row.provider_environment, created_at: row.created_at, updated_at: row.updated_at,
    escrow: row.escrow_state ? { state: row.escrow_state, hold_tx: row.escrow_hold_tx, final_tx: row.escrow_final_tx } : null,
    ...(codes ? { codes } : {}),
  };
}

export function registerBills(app: FastifyInstance, required: (request: FastifyRequest, write?: boolean) => Promise<Person>, providerOverride?: BillsProvider,
  pay: (input: Parameters<typeof sendFromManagedWallet>[0]) => Promise<{ id: string }> = (input) => sendFromManagedWallet(input)) {
  const provider = () => {
    if (providerOverride) return providerOverride;
    const configured = billsProvider();
    if (!configured) throw new PaymentError(503, 'bills_unavailable', 'Airtime and gift cards are not available yet.');
    return configured;
  };
  const available = () => (!!providerOverride || !!billsProvider()) && !!billsTreasury() && managedTransfersEnabled();
  const fail = (error: unknown): never => {
    if (error instanceof BillsProviderError)
      throw new PaymentError(error.status >= 500 ? 503 : 422, 'bills_' + error.code.toLowerCase(),
        error.status >= 500 ? 'The provider is not responding. Try again in a moment.' : error.message);
    throw error;
  };

  app.get('/personal/api/bills/config', async (request) => {
    await required(request);
    return { available: available(), environment: available() && provider().sandbox ? 'sandbox' : 'production', countries: ['NG'],
      giftcard_countries: ['US', 'GB', 'NG'], kinds: ['airtime', 'data', 'giftcard'] };
  });

  // The phone's network, with the amounts and data plans it offers.
  app.get('/personal/api/bills/operator', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request);
    const q = z.object({ phone: phoneSchema, country: countrySchema.default('NG'), kind: z.enum(['airtime', 'data']).default('airtime') }).parse(request.query);
    try {
      const detected = await provider().detectOperator(q.phone, q.country);
      if (!detected) throw new PaymentError(404, 'operator_not_found', 'We could not find the network for this number.');
      if (q.kind === 'airtime') return { operator: detected };
      // Data plans are sold through the network's data operator.
      const network = detected.name.split(/\s+/)[0].toLowerCase();
      const data = (await provider().operators(q.country)).find((o) => o.data && o.name.toLowerCase().startsWith(network));
      if (!data || !data.plans.length) throw new PaymentError(404, 'data_not_available', `Data plans for ${detected.name} are not available yet.`);
      return { operator: data };
    } catch (error) { return fail(error); }
  });

  app.get('/personal/api/bills/giftcards', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request);
    const { country } = z.object({ country: countrySchema.default('US') }).parse(request.query);
    try {
      const cards = (await provider().giftCards(country)).filter((card) => SUBSCRIPTION_BRANDS.test(`${card.brand} ${card.name}`));
      return { data: cards };
    } catch (error) { return fail(error); }
  });

  const purchase = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('airtime'), country: countrySchema, phone: phoneSchema, operator_id: z.number().int().positive(), amount: z.number().positive().max(1_000_000) }),
    z.object({ kind: z.literal('data'), country: countrySchema, phone: phoneSchema, operator_id: z.number().int().positive(), amount: z.number().positive().max(1_000_000) }),
    z.object({ kind: z.literal('giftcard'), country: countrySchema, product_id: z.number().int().positive(), amount: z.number().positive().max(10_000), email: z.string().email().max(254).optional() }),
  ]);
  type Purchase = z.infer<typeof purchase>;

  /** What the customer is buying and what it costs, checked against the provider's own catalogue. */
  async function price(input: Purchase) {
    const p = provider();
    if (input.kind === 'giftcard') {
      const card = await p.giftCard(input.product_id);
      if (!SUBSCRIPTION_BRANDS.test(`${card.brand} ${card.name}`)) throw new PaymentError(422, 'product_unavailable', 'This card is not offered.');
      const allowed = card.denomination === 'FIXED' ? card.fixed.includes(input.amount)
        : card.min !== null && card.max !== null && input.amount >= card.min && input.amount <= card.max;
      if (!allowed) throw new PaymentError(422, 'amount_not_offered', 'Choose one of the amounts offered for this card.');
      const cost = await p.giftCardCostUsd(card.id, input.amount);
      return { name: card.name, currency: card.currency, cost, operatorId: null, productId: card.id };
    }
    const operator = await p.operator(input.operator_id);
    if (operator.data !== (input.kind === 'data')) throw new PaymentError(422, 'operator_mismatch', 'Choose the network again.');
    const allowed = operator.denomination === 'FIXED' ? operator.fixed.includes(input.amount)
      : operator.min !== null && operator.max !== null && input.amount >= operator.min && input.amount <= operator.max;
    if (!allowed) throw new PaymentError(422, 'amount_not_offered', operator.min !== null
      ? `Choose an amount between ${operator.min} and ${operator.max} ${operator.currency}.` : 'Choose one of the amounts offered.');
    const plan = operator.plans.find((p2) => p2.amount === input.amount);
    const cost = await p.topupCostUsd(operator.id, input.amount);
    return { name: input.kind === 'data' && plan ? `${operator.name} · ${plan.description}` : `${operator.name} airtime`,
      currency: operator.currency, cost, operatorId: operator.id, productId: null };
  }

  app.post('/personal/api/bills/quote', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    await required(request, true);
    const input = purchase.parse(request.body);
    const treasury = billsTreasury();
    if (!treasury || !available()) throw new PaymentError(503, 'bills_unavailable', 'Airtime and gift cards are not available yet.');
    try {
      const quoted = await price(input);
      const { feeUsd, atomic } = priceOf(quoted.cost);
      return { product_name: quoted.name, face: { amount: input.amount, currency: quoted.currency },
        cost_usd: quoted.cost, fee_usd: feeUsd, price_atomic: atomic.toString(), pay_to: treasury, asset: 'QUSDC' };
    } catch (error) { return fail(error); }
  });

  app.post('/personal/api/bills/orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const person = await required(request, true);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(key)) throw new PaymentError(400, 'idempotency_key_required', 'Send a valid Idempotency-Key header');
    const body = z.object({ max_price_atomic: z.string().regex(/^[1-9][0-9]{0,30}$/) }).passthrough().parse(request.body);
    const { max_price_atomic, pin, password, passkey, ...rest } = body as Record<string, unknown>;
    const input = purchase.parse(rest);
    const approval = sendApprovalSchema.parse(Object.fromEntries(Object.entries({ pin, password, passkey }).filter(([, v]) => v !== undefined)));
    const treasury = billsTreasury();
    if (!treasury || !available()) throw new PaymentError(503, 'bills_unavailable', 'Airtime and gift cards are not available yet.');
    const requestHash = createHash('sha256').update(JSON.stringify([input, max_price_atomic])).digest('hex');
    const previous = (await pool.query('SELECT * FROM personal_bill_orders WHERE personal_user_id=$1 AND idempotency_key=$2', [person.user_id, key])).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash) throw new PaymentError(409, 'idempotency_conflict', 'This request key was used for another purchase');
      return publicOrder(previous);
    }
    let quoted;
    try { quoted = await price(input); } catch (error) { return fail(error); }
    const { feeUsd, atomic } = priceOf(quoted.cost);
    // The price may move between the quote and now; never charge more than the customer saw.
    if (atomic > BigInt(max_price_atomic as string)) throw new PaymentError(409, 'price_changed', 'The price changed. Check the new price and try again.');
    // The approval names the treasury, the asset and this exact amount.
    await approveSend(request, person, approval, { to: treasury, amountAtomic: atomic.toString(), asset: 'QUSDC' });
    const orderId = id('bil');
    const owner = (await pool.query('SELECT email FROM personal_users WHERE id=$1', [person.user_id])).rows[0];
    const inserted = await pool.query(`INSERT INTO personal_bill_orders(id,personal_user_id,account_id,kind,provider_environment,idempotency_key,request_hash,
        country_code,operator_id,product_id,recipient_phone,recipient_email,product_name,face_amount,face_currency,cost_usd,fee_usd,price_atomic)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (personal_user_id,idempotency_key) DO NOTHING`,
      [orderId, person.user_id, person.account_id, input.kind, provider().sandbox ? 'sandbox' : 'production', key, requestHash, input.country,
        quoted.operatorId, quoted.productId, input.kind === 'giftcard' ? null : input.phone,
        input.kind === 'giftcard' ? (input.email ?? owner?.email ?? null) : null,
        quoted.name, input.amount, quoted.currency, quoted.cost, feeUsd, atomic.toString()]);
    if (!inserted.rowCount) return publicOrder((await pool.query('SELECT * FROM personal_bill_orders WHERE personal_user_id=$1 AND idempotency_key=$2', [person.user_id, key])).rows[0]);
    if (input.kind === 'giftcard' && !(input.email ?? owner?.email))
      throw new PaymentError(422, 'email_required', 'Add an email address to receive the card.');
    try {
      // Pay the treasury from the account wallet: limits, identity, holds and nonce safety all apply.
      const settlement = await pay({ userId: person.user_id, accountId: person.account_id, to: treasury,
        amountAtomic: atomic.toString(), asset: 'QUSDC', idempotencyKey: `bill:${orderId}` });
      await pool.query("UPDATE personal_bill_orders SET settlement_id=$2,status='paid',updated_at=now() WHERE id=$1", [orderId, settlement.id]);
    } catch (error) {
      await pool.query("UPDATE personal_bill_orders SET status='payment_failed',error=$2,updated_at=now() WHERE id=$1",
        [orderId, (error as { code?: string }).code ?? 'payment_failed']);
      throw error;
    }
    return publicOrder((await pool.query('SELECT * FROM personal_bill_orders WHERE id=$1', [orderId])).rows[0]);
  });

  app.get('/personal/api/bills/orders', async (request) => {
    const person = await required(request);
    const rows = (await pool.query('SELECT * FROM personal_bill_orders WHERE personal_user_id=$1 ORDER BY created_at DESC LIMIT 30', [person.user_id])).rows;
    return { data: rows.map((row) => publicOrder(row)) };
  });

  // One order; a delivered gift card shows its code, read from the provider rather than stored here.
  app.get('/personal/api/bills/orders/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const person = await required(request);
    const orderId = z.string().regex(/^bil_[a-f0-9]{32}$/).parse((request.params as { id: string }).id);
    const row = (await pool.query('SELECT * FROM personal_bill_orders WHERE id=$1 AND personal_user_id=$2', [orderId, person.user_id])).rows[0];
    if (!row) throw new PaymentError(404, 'order_not_found', 'Order not found');
    reply.header('cache-control', 'no-store');
    if (row.kind === 'giftcard' && row.status === 'delivered' && row.provider_transaction_id) {
      try { return publicOrder(row, await provider().giftCardCodes(row.provider_transaction_id)); }
      catch { return { ...publicOrder(row), codes_unavailable: true }; }
    }
    return publicOrder(row);
  });
}

let cached: { key: string; provider: BillsProvider } | null = null;
let factory: (() => BillsProvider | null) | null = null;
/** The configured provider (set by the connector at startup), or null when not configured. */
export function billsProvider(): BillsProvider | null {
  if (!factory) return null;
  const key = `${process.env.RELOADLY_CLIENT_ID}|${process.env.RELOADLY_ENVIRONMENT}`;
  if (cached?.key === key) return cached.provider;
  const made = factory();
  cached = made ? { key, provider: made } : null;
  return made;
}
export function setBillsProviderFactory(make: () => BillsProvider | null) { factory = make; cached = null; }

/**
 * Worker job: move one due order along. A confirmed payment is fulfilled with the order id
 * as the provider reference (looked up first, so a retry never buys twice); a payment that
 * failed on chain closes the order; a definite provider refusal marks it for refund.
 */
export async function reconcileOneBillOrder(override?: BillsProvider, escrowOverride?: Escrow | null) {
  const provider = override ?? billsProvider();
  const escrow = escrowOverride === undefined ? configuredEscrow() : escrowOverride;
  const row = (await pool.query(`UPDATE personal_bill_orders SET next_check_at=now()+interval '1 minute',attempts=attempts+1,updated_at=now()
    WHERE id=(SELECT id FROM personal_bill_orders WHERE (status IN ('paid','fulfilling') OR (escrow_state='held' AND status IN ('delivered','refund_due')))
      AND next_check_at<=now() ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
  if (!row) return false;
  const settlement = (await pool.query('SELECT status,source_address,destination_address FROM chain_settlements WHERE id=$1', [row.settlement_id])).rows[0];
  // Paid into the escrow contract: the operator records it, then settles or refunds it on chain.
  const escrowed = !!escrow && !!settlement && settlement.destination_address?.toLowerCase() === escrow.address.toLowerCase();
  if (row.escrow_state === 'held' && ['delivered', 'refund_due'].includes(row.status)) {
    if (!escrow || !escrowed) return true;
    const onChain = await escrow.state(row.id);
    const delivered = row.status === 'delivered';
    const tx = onChain === 'held' ? await (delivered ? escrow.settle(row.id) : escrow.refund(row.id)) : null;
    const final = onChain === 'held' ? (delivered ? 'settled' : 'refunded') : onChain;
    await pool.query(`UPDATE personal_bill_orders SET escrow_state=$2,escrow_final_tx=COALESCE($3,escrow_final_tx),
      status=CASE WHEN $2='refunded' THEN 'refunded' ELSE status END,updated_at=now() WHERE id=$1`, [row.id, final, tx]);
    return true;
  }
  if (!settlement || ['failed', 'expired', 'mismatched'].includes(settlement.status)) {
    await pool.query("UPDATE personal_bill_orders SET status='payment_failed',error='payment_not_confirmed',updated_at=now() WHERE id=$1 AND status IN ('paid','fulfilling')", [row.id]);
    return true;
  }
  if (settlement.status !== 'confirmed') {
    await pool.query("UPDATE personal_bill_orders SET next_check_at=now()+interval '15 seconds' WHERE id=$1", [row.id]);
    return true;
  }
  if (escrowed && !row.escrow_state) {
    // Record the confirmed payment against this order before anything is bought with it.
    const onChain = await escrow!.state(row.id);
    const tx = onChain === 'none' ? await escrow!.hold(row.id, settlement.source_address, BigInt(row.price_atomic)) : null;
    await pool.query("UPDATE personal_bill_orders SET escrow_state=$2,escrow_hold_tx=COALESCE($3,escrow_hold_tx),next_check_at=now(),updated_at=now() WHERE id=$1",
      [row.id, onChain === 'none' ? 'held' : onChain, tx]);
    return true;
  }
  if (!provider || (provider.sandbox ? 'sandbox' : 'production') !== row.provider_environment) {
    await pool.query("UPDATE personal_bill_orders SET next_check_at=now()+interval '10 minutes' WHERE id=$1", [row.id]);
    return true;
  }
  const finish = async (order: ProviderOrder) => {
    if (order.status === 'SUCCESSFUL')
      await pool.query("UPDATE personal_bill_orders SET status='delivered',provider_transaction_id=$2,delivery=$3,error=NULL,next_check_at=now(),updated_at=now() WHERE id=$1",
        [row.id, order.transactionId, JSON.stringify(order.details)]);
    else if (order.status === 'FAILED')
      await pool.query("UPDATE personal_bill_orders SET status='refund_due',provider_transaction_id=$2,error='provider_failed',next_check_at=now(),updated_at=now() WHERE id=$1",
        [row.id, order.transactionId]);
    else
      await pool.query("UPDATE personal_bill_orders SET status='fulfilling',provider_transaction_id=$2,next_check_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
        [row.id, order.transactionId]);
  };
  try {
    // An order is placed at most once. Once an attempt was made ('fulfilling'), only read it back:
    // by its provider transaction id when known, else by our reference.
    if (row.status === 'fulfilling') {
      const txId = row.provider_transaction_id ?? undefined;
      const existing = row.kind === 'giftcard' ? await provider.findGiftCardOrder(row.id, txId) : await provider.findTopup(row.id, txId);
      if (existing) { await finish(existing); return true; }
      // No trace of it after repeated checks: hold it for a refund rather than risk buying twice.
      if (row.attempts > 20) await pool.query("UPDATE personal_bill_orders SET status='refund_due',error='not_confirmed_by_provider',next_check_at=now(),updated_at=now() WHERE id=$1", [row.id]);
      else await pool.query("UPDATE personal_bill_orders SET next_check_at=now()+interval '1 minute' WHERE id=$1", [row.id]);
      return true;
    }
    const claimed = await pool.query("UPDATE personal_bill_orders SET status='fulfilling',updated_at=now() WHERE id=$1 AND status='paid'", [row.id]);
    if (!claimed.rowCount) return true;
    const placed = row.kind === 'giftcard'
      ? await provider.orderGiftCard({ productId: Number(row.product_id), countryCode: row.country_code, faceAmount: Number(row.face_amount),
        email: row.recipient_email, senderName: 'Microsendr', reference: row.id })
      : await provider.topup({ operatorId: Number(row.operator_id), localAmount: Number(row.face_amount), phone: row.recipient_phone,
        countryCode: row.country_code, reference: row.id });
    await finish(placed);
  } catch (error) {
    if (error instanceof BillsProviderError && error.definite) {
      await pool.query("UPDATE personal_bill_orders SET status='refund_due',error=$2,next_check_at=now(),updated_at=now() WHERE id=$1", [row.id, error.code]);
      return true;
    }
    // Unclear (timeout, 5xx): the next pass looks the reference up before trying again.
    await pool.query("UPDATE personal_bill_orders SET next_check_at=now()+interval '2 minutes',error=$2 WHERE id=$1",
      [row.id, error instanceof BillsProviderError ? error.code : 'provider_unavailable']);
    throw error;
  }
  return true;
}
export const billFinalStatuses = FINAL;
