import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderError } from '../../../packages/provider-sdk/src/index.js';
export const wireMinor = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform(String);
export const wireId = wireMinor;
export function parseProviderJson(body: string): unknown {
  return JSON.parse(body, (_key, value, context?: { source: string }) => {
    if (typeof value === 'number' && Number.isInteger(value)) {
      if (context?.source && /^-?\d+$/.test(context.source))
        return BigInt(context.source).toString();
      if (!Number.isSafeInteger(value))
        throw new ProviderError('unknown', 'Provider JSON contains an unsafe numeric value', true);
      return String(value);
    }
    return value;
  });
}
export class PaystackApiError extends ProviderError {
  constructor(
    readonly status: number,
    readonly absent = false,
  ) {
    super(
      status === 429 || status >= 500 ? 'unavailable' : 'rejected',
      `Paystack request failed (${status})`,
      status >= 500,
    );
  }
}
export interface PaystackOptions {
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export class PaystackClient {
  readonly mode = 'test';
  readonly binding: string;
  constructor(private options: PaystackOptions) {
    if (!/^sk_test_[A-Za-z0-9]{8,}$/.test(options.secretKey))
      throw new ProviderError('rejected', 'Only Paystack test secret keys are accepted');
    this.binding = createHash('sha256').update(options.secretKey).digest('hex');
  }
  static configured() {
    return /^sk_test_[A-Za-z0-9]{8,}$/.test(process.env.PAYSTACK_SECRET_KEY ?? '');
  }
  static fromEnvironment() {
    return new PaystackClient({ secretKey: process.env.PAYSTACK_SECRET_KEY ?? '' });
  }
  verifySignature(raw: string, signature: unknown) {
    if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/.test(signature)) return false;
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      createHmac('sha512', this.options.secretKey).update(raw).digest(),
    );
  }
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!/^\/[a-z][a-z0-9_/?=&%.-]*$/i.test(path) || path.includes('..'))
      throw new ProviderError('rejected', 'Invalid provider path');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`https://api.paystack.co${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.secretKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000),
      });
    } catch {
      throw new ProviderError('timeout', 'Paystack acknowledgement is unavailable', true);
    }
    let envelope: ReturnType<typeof schema.parse>;
    const schema = z.object({
      status: z.boolean(),
      message: z.string().optional(),
      data: z.unknown().optional(),
      meta: z.unknown().optional(),
    });
    try {
      envelope = schema.parse(parseProviderJson(await response.text()));
    } catch {
      throw new ProviderError('unknown', 'Paystack returned an invalid response', true);
    }
    if (!response.ok || !envelope.status)
      throw new PaystackApiError(
        response.ok ? 400 : response.status,
        response.status === 404 ||
          (response.status === 400 &&
            !!envelope.message &&
            /^(transfer|transaction) (?:with .* )?(?:not found|was not found|does not exist)/i.test(
              envelope.message,
            )),
      );
    return envelope.data;
  }
  async resolveAccount(account_number: string, bank_code: string) {
    const data = z
      .object({ account_number: z.string(), account_name: z.string().min(1).max(200) })
      .parse(
        await this.request(
          'GET',
          `/bank/resolve?${new URLSearchParams({ account_number, bank_code })}`,
        ),
      );
    if (data.account_number !== account_number)
      throw new ProviderError('rejected', 'Resolved account does not match the request');
    return data;
  }
  async createRecipient(input: { account_number: string; bank_code: string; name: string }) {
    const result = z
      .object({
        recipient_code: z.string().regex(/^RCP_[A-Za-z0-9]+$/),
        domain: z.literal('test'),
        currency: z.literal('NGN'),
        type: z.literal('nuban'),
        active: z.literal(true),
        details: z.object({ account_number: z.string(), bank_code: z.string() }),
      })
      .parse(
        await this.request('POST', '/transferrecipient', {
          ...input,
          type: 'nuban',
          currency: 'NGN',
        }),
      );
    if (
      result.details.account_number !== input.account_number ||
      result.details.bank_code !== input.bank_code
    )
      throw new ProviderError('rejected', 'Recipient identity does not match name enquiry');
    return result;
  }
  async verifyTransfer(reference: string) {
    try {
      return await this.request('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    } catch (e) {
      if (e instanceof PaystackApiError && e.absent) return null;
      throw e;
    }
  }
  async verifyCollection(reference: string) {
    try {
      return await this.request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    } catch (e) {
      if (e instanceof PaystackApiError && e.absent) return null;
      throw e;
    }
  }
  async initializeCollection(input: { reference: string; amount: string; email: string; callbackUrl?: string }) {
    const { callbackUrl, ...payment } = input;
    const result = z
      .object({
        reference: z.string(),
        authorization_url: z.string().url(),
        access_code: z.string(),
      })
      .parse(await this.request('POST', '/transaction/initialize', { ...payment, currency: 'NGN', ...(callbackUrl ? { callback_url: callbackUrl } : {}) }));
    if (
      result.reference !== input.reference ||
      new URL(result.authorization_url).origin !== 'https://checkout.paystack.com'
    )
      throw new ProviderError('unknown', 'Provider checkout identity is invalid', true);
    return result;
  }
  async balances() {
    return z
      .array(z.object({ currency: z.string(), balance: wireMinor }))
      .parse(await this.request('GET', '/balance'));
  }
  async statement() {
    const line = z.object({
      id: wireId,
      domain: z.literal('test'),
      currency: z.string(),
      difference: z
        .union([z.string().regex(/^-?\d+$/), z.number().int().safe()])
        .transform(String),
      model_responsible: z.string(),
      model_row: wireId,
      createdAt: z.string(),
    });
    // The ledger endpoint is paginated; reconciliation must see every line, not page one.
    const perPage = 100,
      lines: z.infer<typeof line>[] = [];
    for (let page = 1; ; page++) {
      if (page > 100)
        throw new ProviderError('unknown', 'Provider statement exceeds the reconciliation limit', true);
      const batch = z
        .array(line)
        .max(perPage)
        .parse(await this.request('GET', `/balance/ledger?perPage=${perPage}&page=${page}`));
      lines.push(...batch);
      if (batch.length < perPage) return lines;
    }
  }
  async banks() {
    return z
      .array(
        z.object({ name: z.string(), code: z.string(), active: z.boolean(), currency: z.string() }),
      )
      .parse(await this.request('GET', '/bank?country=nigeria&currency=NGN'));
  }
}
