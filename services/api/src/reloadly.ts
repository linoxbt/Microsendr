import { z } from 'zod';
import { BillsProviderError, setBillsProviderFactory, type BillsProvider, type GiftCard, type Operator, type ProviderOrder } from './bills.js';

/**
 * Reloadly (airtime, data bundles and gift cards). Server to server with OAuth client
 * credentials; one token per product audience, refreshed before it expires.
 * RELOADLY_ENVIRONMENT=production for live orders; anything else uses the sandbox.
 */
type Fetch = typeof fetch;
const num = z.coerce.number();
const operatorSchema = z.object({
  operatorId: z.number().optional(), id: z.number().optional(), name: z.string(),
  data: z.boolean().optional().default(false), bundle: z.boolean().optional().default(false),
  denominationType: z.enum(['RANGE', 'FIXED']),
  destinationCurrencyCode: z.string(),
  localMinAmount: num.nullable().optional(), localMaxAmount: num.nullable().optional(),
  localFixedAmounts: z.array(num).nullable().optional(),
  localFixedAmountsDescriptions: z.record(z.string(), z.string()).nullable().optional(),
  fixedAmountsDescriptions: z.record(z.string(), z.string()).nullable().optional(),
  logoUrls: z.array(z.string()).nullable().optional(),
  country: z.object({ isoName: z.string() }).passthrough().optional(),
  fx: z.object({ rate: num, currencyCode: z.string() }).passthrough().nullable().optional(),
}).passthrough();
const productSchema = z.object({
  productId: z.number(), productName: z.string(),
  brand: z.object({ brandName: z.string() }).passthrough().nullable().optional(),
  country: z.object({ isoName: z.string() }).passthrough().optional(),
  denominationType: z.enum(['RANGE', 'FIXED']),
  recipientCurrencyCode: z.string(),
  fixedRecipientDenominations: z.array(num).nullable().optional(),
  minRecipientDenomination: num.nullable().optional(), maxRecipientDenomination: num.nullable().optional(),
  fixedRecipientToSenderDenominationsMap: z.record(z.string(), num).nullable().optional(),
  senderFee: num.nullable().optional(), senderFeePercentage: num.nullable().optional(),
  recipientCurrencyToSenderCurrencyExchangeRate: num.nullable().optional(),
  logoUrls: z.array(z.string()).nullable().optional(),
}).passthrough();

function toOperator(raw: z.infer<typeof operatorSchema>): Operator {
  const descriptions = raw.localFixedAmountsDescriptions ?? {};
  const fixed = (raw.localFixedAmounts ?? []).filter((v) => v > 0);
  return {
    id: raw.operatorId ?? raw.id ?? 0, name: raw.name, countryCode: raw.country?.isoName ?? '', logo: raw.logoUrls?.[0] ?? null,
    data: !!(raw.data || raw.bundle), currency: raw.destinationCurrencyCode, denomination: raw.denominationType,
    min: raw.localMinAmount ?? null, max: raw.localMaxAmount ?? null, fixed,
    plans: fixed.map((amount) => ({ amount, description: descriptions[amount.toFixed(2)] ?? descriptions[String(amount)] ?? `${amount} ${raw.destinationCurrencyCode}` })),
  };
}
function toCard(raw: z.infer<typeof productSchema>): GiftCard {
  return {
    id: raw.productId, name: raw.productName, brand: raw.brand?.brandName ?? raw.productName, countryCode: raw.country?.isoName ?? '',
    logo: raw.logoUrls?.[0] ?? null, currency: raw.recipientCurrencyCode, denomination: raw.denominationType,
    fixed: (raw.fixedRecipientDenominations ?? []).filter((v) => v > 0),
    min: raw.minRecipientDenomination ?? null, max: raw.maxRecipientDenomination ?? null,
  };
}
// SUCCESSFUL is final; FAILED and REFUNDED mean nothing was delivered and the provider kept no
// funds; PENDING and PROCESSING are still in flight.
// Round up to the cent without floating-point noise (1.12 * 100 is 112.00000000000001).
const upToCent = (value: number) => Math.ceil(Math.round(value * 1e6) / 1e4) / 100;
const status = (value: unknown): ProviderOrder['status'] =>
  value === 'SUCCESSFUL' ? 'SUCCESSFUL' : value === 'FAILED' || value === 'REFUNDED' ? 'FAILED' : 'PENDING';

export class ReloadlyClient implements BillsProvider {
  private tokens = new Map<string, { token: string; until: number }>();
  constructor(private readonly options: { clientId: string; clientSecret: string; production: boolean; fetch?: Fetch }) {}
  get sandbox() { return !this.options.production; }
  private base(product: 'topups' | 'giftcards') {
    return `https://${product}${this.options.production ? '' : '-sandbox'}.reloadly.com`;
  }
  private async token(product: 'topups' | 'giftcards') {
    const cached = this.tokens.get(product);
    if (cached && cached.until > Date.now() + 60_000) return cached.token;
    const response = await this.send('https://auth.reloadly.com/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.options.clientId, client_secret: this.options.clientSecret, grant_type: 'client_credentials', audience: this.base(product) }),
    });
    const body = z.object({ access_token: z.string(), expires_in: num }).passthrough().parse(response);
    this.tokens.set(product, { token: body.access_token, until: Date.now() + body.expires_in * 1000 });
    return body.access_token;
  }
  private async send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new BillsProviderError(503, 'PROVIDER_UNAVAILABLE', 'The provider is not responding.'); }
    const data: any = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof data?.errorCode === 'string' ? data.errorCode : `HTTP_${response.status}`;
      // A 4xx with a provider error code is a definite refusal; anything else may have gone through.
      throw new BillsProviderError(response.status, code, typeof data?.message === 'string' ? data.message : 'The provider refused the request.',
        response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429);
    }
    return data;
  }
  private async call(product: 'topups' | 'giftcards', path: string, init: RequestInit = {}) {
    const accept = product === 'topups' ? 'application/com.reloadly.topups-v1+json' : 'application/com.reloadly.giftcards-v1+json';
    return this.send(this.base(product) + path, { ...init, headers: { authorization: `Bearer ${await this.token(product)}`, accept, 'content-type': 'application/json' } });
  }

  async detectOperator(phone: string, countryCode: string) {
    try {
      const raw = await this.call('topups', `/operators/auto-detect/phone/${encodeURIComponent(phone)}/countries/${countryCode}?suggestedAmountsMap=true`);
      return toOperator(operatorSchema.parse(raw));
    } catch (error) {
      if (error instanceof BillsProviderError && error.status === 404) return null;
      throw error;
    }
  }
  async operators(countryCode: string) {
    const raw = await this.call('topups', `/operators/countries/${countryCode}?includeBundles=true&includeData=true&suggestedAmountsMap=true`);
    return z.array(operatorSchema).parse(raw).map(toOperator);
  }
  async operator(operatorId: number) {
    return toOperator(operatorSchema.parse(await this.call('topups', `/operators/${operatorId}`)));
  }
  async topupCostUsd(operatorId: number, localAmount: number) {
    // fx-rate gives local units per one sender-currency unit for this operator.
    const raw = z.object({ fxRate: num, currencyCode: z.string() }).passthrough()
      .parse(await this.call('topups', '/operators/fx-rate', { method: 'POST', body: JSON.stringify({ operatorId, amount: 1 }) }));
    if (!(raw.fxRate > 0)) throw new BillsProviderError(502, 'BAD_RATE', 'The provider sent no rate.');
    const base = localAmount / raw.fxRate;
    // The operator's international fee (fixed and percentage) is charged on top.
    const fees = z.object({ fees: z.object({ international: num.nullable().optional(), internationalPercentage: num.nullable().optional() })
      .passthrough().nullable().optional() }).passthrough().parse(await this.call('topups', `/operators/${operatorId}`)).fees;
    const fee = (fees?.international ?? 0) + base * ((fees?.internationalPercentage ?? 0) / 100);
    return upToCent(base + fee);
  }
  async topup(input: { operatorId: number; localAmount: number; phone: string; countryCode: string; reference: string }) {
    const raw: any = await this.call('topups', '/topups', { method: 'POST', body: JSON.stringify({
      operatorId: input.operatorId, amount: input.localAmount, useLocalAmount: true, customIdentifier: input.reference,
      recipientPhone: { countryCode: input.countryCode, number: input.phone },
    }) });
    return { transactionId: String(raw?.transactionId ?? ''), status: status(raw?.status ?? 'SUCCESSFUL'),
      details: { delivered: raw?.deliveredAmount, currency: raw?.deliveredAmountCurrencyCode, operatorReference: raw?.operatorTransactionId } };
  }
  async findTopup(reference: string, transactionId?: string) {
    if (transactionId) {
      const t: any = await this.call('topups', `/topups/reports/transactions/${encodeURIComponent(transactionId)}`);
      return { transactionId, status: status(t?.status ?? 'SUCCESSFUL'), details: { delivered: t?.deliveredAmount, currency: t?.deliveredAmountCurrencyCode } };
    }
    const raw: any = await this.call('topups', `/topups/reports/transactions?customIdentifier=${encodeURIComponent(reference)}&size=1`);
    const found = (raw?.content ?? []).find((t: any) => t?.customIdentifier === reference);
    return found ? { transactionId: String(found.transactionId), status: status(found.status ?? 'SUCCESSFUL'),
      details: { delivered: found.deliveredAmount, currency: found.deliveredAmountCurrencyCode } } : null;
  }
  async giftCards(countryCode: string) {
    const raw = await this.call('giftcards', `/countries/${countryCode}/products`);
    return z.array(productSchema).parse(raw).map(toCard);
  }
  async giftCard(productId: number) {
    return toCard(productSchema.parse(await this.call('giftcards', `/products/${productId}`)));
  }
  async giftCardCostUsd(productId: number, faceAmount: number) {
    const raw = productSchema.parse(await this.call('giftcards', `/products/${productId}`));
    const mapped = raw.fixedRecipientToSenderDenominationsMap?.[faceAmount.toFixed(1)] ?? raw.fixedRecipientToSenderDenominationsMap?.[String(faceAmount)];
    const base = mapped ?? (raw.recipientCurrencyToSenderCurrencyExchangeRate ? faceAmount * raw.recipientCurrencyToSenderCurrencyExchangeRate : null);
    if (base === null || !(base > 0)) throw new BillsProviderError(502, 'BAD_PRICE', 'The provider sent no price for this card.');
    const fee = (raw.senderFee ?? 0) + base * ((raw.senderFeePercentage ?? 0) / 100);
    return upToCent(base + fee);
  }
  async orderGiftCard(input: { productId: number; countryCode: string; faceAmount: number; email: string; senderName: string; reference: string }) {
    const raw: any = await this.call('giftcards', '/orders', { method: 'POST', body: JSON.stringify({
      productId: input.productId, quantity: 1, unitPrice: input.faceAmount,
      customIdentifier: input.reference, senderName: input.senderName, recipientEmail: input.email,
    }) });
    return { transactionId: String(raw?.transactionId ?? ''), status: status(raw?.status), details: { product: raw?.product?.productName } };
  }
  async findGiftCardOrder(reference: string, transactionId?: string) {
    if (transactionId) {
      const t: any = await this.call('giftcards', `/reports/transactions/${encodeURIComponent(transactionId)}`);
      return { transactionId, status: status(t?.status), details: {} };
    }
    // Listing by reference is not documented for gift cards; an unsupported query finds nothing.
    try {
      const raw: any = await this.call('giftcards', `/reports/transactions?customIdentifier=${encodeURIComponent(reference)}&size=1`);
      const found = (raw?.content ?? []).find((t: any) => t?.customIdentifier === reference);
      return found ? { transactionId: String(found.transactionId), status: status(found.status), details: {} } : null;
    } catch (error) {
      if (error instanceof BillsProviderError && error.status >= 400 && error.status < 500) return null;
      throw error;
    }
  }
  async giftCardCodes(transactionId: string) {
    const raw = await this.call('giftcards', `/orders/transactions/${encodeURIComponent(transactionId)}/cards`);
    return z.array(z.object({ cardNumber: z.union([z.string(), z.number()]).nullable().optional(), pinCode: z.union([z.string(), z.number()]).nullable().optional() }).passthrough())
      .parse(raw).map((c) => ({ code: String(c.cardNumber ?? c.pinCode ?? ''), pin: c.cardNumber && c.pinCode ? String(c.pinCode) : null }));
  }
}

setBillsProviderFactory(() => {
  const clientId = process.env.RELOADLY_CLIENT_ID, clientSecret = process.env.RELOADLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new ReloadlyClient({ clientId, clientSecret, production: process.env.RELOADLY_ENVIRONMENT === 'production' });
});
