import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Fonbnk Merchant API v2 (server to server). Every request carries x-client-id,
 * x-timestamp (Unix ms) and x-signature = base64(HMAC-SHA256(base64decode(secret),
 * `${timestamp}:${path-with-query}`)). The body is not signed.
 */
export class FonbnkError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const fee = z.object({ id: z.string(), type: z.string().optional(), recipient: z.string(), amount: z.number() }).passthrough();
const cashout = z.object({
  amountBeforeFees: z.number(), amountAfterFees: z.number(),
  amountBeforeFeesUsd: z.number().optional(), amountAfterFeesUsd: z.number().optional(),
  exchangeRate: z.number(), exchangeRateAfterFees: z.number().optional(),
  chargedFees: z.array(fee).default([]), totalChargedFees: z.number().optional(), totalChargedFeesUsd: z.number().optional(),
}).passthrough();
const leg = z.object({
  paymentChannel: z.string(), currencyType: z.string(), currencyCode: z.string(),
  currencyDetails: z.record(z.string(), z.unknown()).optional(), cashout,
  fieldsToCreateOrder: z.array(z.unknown()).optional(),
}).passthrough();
export const quoteSchema = z.object({ quoteId: z.string(), quoteExpiresAt: z.string(), deposit: leg, payout: leg }).passthrough();
const transferDetail = z.object({ id: z.string(), value: z.unknown().optional(), label: z.string().optional() }).passthrough();
export const orderSchema = z.object({
  _id: z.string(), status: z.string(), expiresAt: z.string().optional().nullable(),
  deposit: z.object({
    transferInstructions: z.object({
      type: z.string(), transferDetails: z.array(transferDetail).default([]),
      instructionsText: z.string().optional().nullable(), warningText: z.string().optional().nullable(),
      fieldsToConfirmOrder: z.array(z.unknown()).optional(), paymentUrl: z.string().optional().nullable(),
    }).passthrough().optional(),
    cashout: cashout.optional(),
  }).passthrough().optional(),
  payout: z.object({ cashout: cashout.optional(), transaction: z.object({ meta: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();
export type FonbnkQuote = z.infer<typeof quoteSchema>;
export type FonbnkOrder = z.infer<typeof orderSchema>;

export interface LegRequest {
  paymentChannel: 'bank' | 'crypto';
  currencyType: 'fiat' | 'crypto';
  currencyCode: string;
  countryIsoCode?: string;
  amount?: number;
  transferType?: 'manual';
}

/** Order states Fonbnk documents as truly final. Expired/canceled can still turn into payment. */
export const FINAL_STATUSES = new Set(['payout_successful', 'refund_successful']);

export class FonbnkClient {
  constructor(private readonly options: { clientId: string; signatureSecret: string; baseUrl?: string; fetch?: typeof fetch }) {
    if (!options.clientId || !options.signatureSecret) throw new Error('Fonbnk client id and signature secret are required');
  }
  static configured() {
    return !!(process.env.FONBNK_CLIENT_ID && process.env.FONBNK_SIGNATURE_SECRET);
  }
  static fromEnvironment(request?: typeof fetch) {
    return new FonbnkClient({
      clientId: process.env.FONBNK_CLIENT_ID ?? '', signatureSecret: process.env.FONBNK_SIGNATURE_SECRET ?? '',
      baseUrl: process.env.FONBNK_BASE_URL || 'https://sandbox-api.fonbnk.com', fetch: request,
    });
  }
  get sandbox() { return (this.options.baseUrl ?? 'https://sandbox-api.fonbnk.com').includes('sandbox'); }

  /** Signs and sends one request. `path` includes the query string exactly as sent. */
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!/^\/api\/v2\/[A-Za-z0-9/_.\-?=&%]*$/.test(path)) throw new FonbnkError(400, 'invalid_path', 'Invalid provider path');
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', Buffer.from(this.options.signatureSecret, 'base64')).update(`${timestamp}:${path}`).digest('base64');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? 'https://sandbox-api.fonbnk.com'}${path}`, {
        method,
        headers: { 'x-client-id': this.options.clientId, 'x-timestamp': timestamp, 'x-signature': signature, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FonbnkError(503, 'provider_unavailable', 'The exchange provider is not responding. Try again.');
    }
    const data: any = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof data?.code === 'string' ? data.code : typeof data?.error?.code === 'string' ? data.error.code : `provider_${response.status}`;
      const message = typeof data?.message === 'string' ? data.message : typeof data?.error?.message === 'string' ? data.error.message : 'The exchange provider refused the request';
      throw new FonbnkError(response.status, code, message);
    }
    return data;
  }

  async quote(deposit: LegRequest, payout: LegRequest) {
    if ((deposit.amount === undefined) === (payout.amount === undefined)) throw new FonbnkError(400, 'invalid_quote', 'Set exactly one amount');
    return quoteSchema.parse(await this.request('POST', '/api/v2/quote', { deposit, payout }));
  }

  async limits(deposit: LegRequest, payout: LegRequest) {
    const query = new URLSearchParams({
      depositPaymentChannel: deposit.paymentChannel, depositCurrencyType: deposit.currencyType, depositCurrencyCode: deposit.currencyCode,
      payoutPaymentChannel: payout.paymentChannel, payoutCurrencyType: payout.currencyType, payoutCurrencyCode: payout.currencyCode,
    });
    if (deposit.countryIsoCode) query.set('depositCountryIsoCode', deposit.countryIsoCode);
    if (payout.countryIsoCode) query.set('payoutCountryIsoCode', payout.countryIsoCode);
    const side = z.object({ min: z.number(), max: z.number(), supportsDecimals: z.boolean().optional() }).passthrough();
    return z.object({ deposit: side, payout: side, supported: z.boolean() }).passthrough().parse(await this.request('GET', `/api/v2/order-limits?${query}`));
  }

  async createOrder(input: {
    quoteId: string; userEmail: string; userCountryIsoCode: string; userIp: string; deposit: LegRequest; payout: LegRequest;
    fieldsToCreateOrder: Record<string, string>; orderParams: string; webhookUrl?: string; callbackUrl?: string;
  }) {
    const result = z.object({ quoteUsed: z.boolean().optional(), order: orderSchema }).passthrough()
      .parse(await this.request('POST', '/api/v2/order', input));
    return result;
  }

  async getOrder(orderId: string) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId)) throw new FonbnkError(400, 'invalid_order', 'Invalid order id');
    return orderSchema.parse(await this.request('GET', `/api/v2/order?orderId=${encodeURIComponent(orderId)}`));
  }

  async confirmOrder(orderId: string, fieldsToConfirmOrder: Record<string, string>) {
    return this.request('POST', '/api/v2/order/confirm', { orderId, fieldsToConfirmOrder });
  }
}

/** Webhook signature: hex(SHA256(rawBody + hex(SHA256(secret)))), sent in x-signature. */
export function verifyFonbnkWebhook(rawBody: string, signature: unknown, secret: string) {
  if (!secret || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const expected = createHash('sha256').update(rawBody + secretHash).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.toLowerCase(), 'hex'));
}
