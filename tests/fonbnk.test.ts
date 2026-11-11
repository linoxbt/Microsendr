import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { FonbnkClient, verifyFonbnkWebhook } from '../connectors/fonbnk/src/index.js';
import { buildApi } from '../services/api/src/app.js';
import { reconcileOneConversionOrder } from '../services/api/src/conversion.js';

// A fake Fonbnk that answers in the shapes the v2 merchant docs describe.
const secret = Buffer.from('fonbnk-signature-secret-for-tests').toString('base64');
const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
type Reply = { status: number; body: unknown } | 'network';
let createReply: Reply | null = null;
let lookupReply: Reply | null = null;
let nextOrderStatus = 'deposit_awaiting';
let totalOnlyFees = false;
const kycByEmail = new Map<string, Record<string, unknown>>();
const ordersByParams = new Map<string, string>();
const cashout = (amountBeforeFees: number, amountAfterFees: number, exchangeRate: number, chargedFees: unknown[] = [], totalChargedFees = 0) => ({
  amountBeforeFees, amountAfterFees, amountBeforeFeesUsd: 6.25, amountAfterFeesUsd: 6.03, exchangeRate, exchangeRateAfterFees: exchangeRate * 1.03,
  chargedFees, totalChargedFees, totalChargedFeesUsd: 0.22,
});
let quoteSeq = 0;
const quote = (amount: number) => ({
  quoteId: `quote_${++quoteSeq}_${randomBytes(4).toString('hex')}`, quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  // The naira-per-dollar rate is on the fiat (deposit) leg; the crypto leg's own rate is 1.
  deposit: { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', cashout: totalOnlyFees
    ? cashout(amount, amount - 350, 1600, [], 350)
    : cashout(amount, amount - 350, 1600, [{ id: 'service_fee', type: 'percentage', recipient: 'platform', amount: 250 }, { id: 'merchant_fee', recipient: 'merchant', amount: 100 }], 350),
    fieldsToCreateOrder: [{ key: 'phoneNumber', label: 'Phone number', type: 'phone' }, { key: 'bankCode', label: 'Bank', type: 'select', options: [{ value: '058', label: 'GTBank' }] }] },
  payout: { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: 'POLYGON_USDC', cashout: cashout(6.2, 6.03, 1, [{ id: 'gas', recipient: 'blockchain', amount: 0.17 }], 0.17),
    fieldsToCreateOrder: [{ key: 'blockchainWalletAddress', label: 'Wallet', type: 'string' }] },
});
const order = (status: string, orderId: string, params?: string) => ({
  _id: orderId, status, expiresAt: new Date(Date.now() + 3600_000).toISOString(), merchantOrderParams: params,
  deposit: { cashout: cashout(10000, 9650, 1600, [{ id: 'service_fee', recipient: 'platform', amount: 250 }]), transferInstructions: {
    type: 'manual', instructionsText: 'Transfer exactly the amount shown.', warningText: 'Use only your own bank account.',
    transferDetails: [{ id: 'recipientBankName', value: 'Sandbox Bank' }, { id: 'recipientBankAccountNumber', value: '0123456789' }, { id: 'amountToSend', value: 10000 }, { id: 'narration', value: 'FON123' }],
    fieldsToConfirmOrder: [{ key: 'senderName', label: 'Name on your bank account', type: 'string', required: true }] } },
  payout: { cashout: cashout(6.2, 6.03, 1), transaction: { meta: status === 'payout_successful' ? { transactionHash: '0x' + 'e'.repeat(64) } : {} } },
});
const answer = (reply: Reply) => reply === 'network' ? Promise.reject(new TypeError('fetch failed')) : Response.json(reply.body, { status: reply.status });
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, headers: init?.headers as Record<string, string>, body });
  if (u.pathname === '/api/v2/quote') return Response.json(quote(body.deposit.amount ?? 10000));
  if (u.pathname === '/api/v2/order-limits') return Response.json({ deposit: { min: 1000, max: 500000 }, payout: { min: 0.5, max: 300 }, supported: true });
  if (u.pathname === '/api/v2/user/kyc') return Response.json(kycByEmail.get(u.searchParams.get('userEmail')!) ?? { passedKycType: 'basic', requiredKycType: null });
  if (u.pathname === '/api/v2/order' && init?.method === 'POST') {
    // Order legs are strict: an unknown key such as transferType is refused.
    if ('transferType' in body.deposit || 'transferType' in body.payout) return Response.json({ message: 'transferType is not allowed', errorCode: 'VALIDATION_ERROR' }, { status: 400 });
    const orderId = `fon_${randomBytes(6).toString('hex')}`;
    ordersByParams.set(body.orderParams, orderId);
    if (createReply) return answer(createReply);
    return Response.json({ quoteUsed: true, order: order('deposit_awaiting', orderId, body.orderParams) });
  }
  if (u.pathname === '/api/v2/order') {
    if (lookupReply) return answer(lookupReply);
    const params = u.searchParams.get('orderParams');
    if (params) {
      const found = ordersByParams.get(params);
      return found ? Response.json(order(nextOrderStatus, found, params)) : Response.json({ message: 'Order not found', errorCode: 'ORDER_NOT_FOUND' }, { status: 404 });
    }
    return Response.json(order(nextOrderStatus, u.searchParams.get('orderId')!));
  }
  if (u.pathname === '/api/v2/order/confirm') return Response.json({ success: true });
  return Response.json({ message: 'not found' }, { status: 404 });
}) as typeof fetch;
const client = new FonbnkClient({ clientId: 'client_test', signatureSecret: secret, baseUrl: 'https://sandbox-api.fonbnk.com', fetch: fake });
const app = await buildApi({ serveWeb: false, rateLimitMax: 10000, personal: { fonbnkClient: client } });
after(async () => { await app.close(); await pool.end(); });
beforeEach(() => { createReply = null; lookupReply = null; nextOrderStatus = 'deposit_awaiting'; totalOnlyFees = false; });

async function member({ verified = true } = {}) {
  const userId = id('usr'), accountId = id('acct'), token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  const email = `${userId}@example.test`;
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,$3)', [userId, email, verified ? new Date() : null]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), userId, csrf]);
  const walletId = id('cwa'), address = `0x${randomBytes(20).toString('hex')}`;
  await pool.query("INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address) VALUES($1,$2,$3,'qie-mainnet',$4)", [walletId, userId, accountId, address]);
  return { userId, email, walletId, address, headers: { origin: 'http://127.0.0.1:4310', cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf } };
}
type Member = Awaited<ReturnType<typeof member>>;
const post = (who: Member, url: string, payload: unknown, extra: Record<string, string> = {}) =>
  // A fresh address per call keeps the per-route rate limits out of the way.
  app.inject({ method: 'POST', url, headers: { ...who.headers, ...extra }, payload: payload as object, remoteAddress: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const getQuote = async (who: Member, amount = 10000) => {
  const res = await post(who, '/personal/api/conversion/quote', { direction: 'buy', asset: 'POLYGON_USDC', amount });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};
const orderBody = (who: Member, quoteId: string, amount = 10000) => ({ quote_id: quoteId, asset: 'POLYGON_USDC', amount, wallet_id: who.walletId,
  fields: { phoneNumber: '+2348012345678', bankCode: '058', blockchainWalletAddress: '0x' + '9'.repeat(40) } });
const placeOrder = async (who: Member, key = id('key')) => {
  const q = await getQuote(who);
  return post(who, '/personal/api/conversion/orders', orderBody(who, q.quote_id), { 'idempotency-key': key });
};
const creates = () => calls.filter((c) => c.path === '/api/v2/order' && c.method === 'POST').length;
const row = async (orderId: string) => (await pool.query('SELECT * FROM personal_conversion_orders WHERE id=$1', [orderId])).rows[0];

test('requests are signed as Fonbnk documents: HMAC-SHA256 of timestamp:path with the base64 secret', async () => {
  calls.length = 0;
  await client.userKyc('someone@example.test');
  const { headers, path } = calls[0];
  assert.equal(headers['x-client-id'], 'client_test');
  assert.match(headers['x-timestamp'], /^\d{13}$/);
  assert.equal(path, '/api/v2/user/kyc?userEmail=someone%40example.test&countryIsoCode=NG');
  const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${headers['x-timestamp']}:${path}`).digest('base64');
  assert.equal(headers['x-signature'], expected);
});

test('a buy quote takes the naira rate from the deposit leg, lists every fee and is stored for its owner', async () => {
  const who = await member();
  const q = await getQuote(who);
  assert.deepEqual([q.pay, q.receive, q.rate, q.environment], [{ currency: 'NGN', amount: 10000 }, { currency: 'POLYGON_USDC', amount: 6.03 }, 1600, 'sandbox']);
  assert.deepEqual(q.fees.map((f: { label: string; amount: number }) => [f.label, f.amount]), [['Fonbnk service fee', 250], ['Roots fee', 100], ['Network fee', 0.17]]);
  assert.deepEqual(q.fields.map((f: { key: string }) => f.key), ['phoneNumber', 'bankCode']);
  // transferType is allowed on the quote's deposit leg only.
  assert.deepEqual(calls.at(-1)!.body.deposit, { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', countryIsoCode: 'NG', amount: 10000, transferType: 'manual' });
  const stored = (await pool.query('SELECT personal_user_id, asset, amount FROM personal_conversion_quotes WHERE quote_id=$1', [q.quote_id])).rows[0];
  assert.deepEqual([stored.personal_user_id, stored.asset, Number(stored.amount)], [who.userId, 'POLYGON_USDC', 10000]);
  totalOnlyFees = true;
  const total = await getQuote(who);
  assert.deepEqual(total.fees.map((f: { label: string; amount: number }) => [f.label, f.amount]), [['Fees', 350], ['Network fee', 0.17]]);
  assert.equal((await post(who, '/personal/api/conversion/quote', { direction: 'buy', asset: 'QIE_USDC', amount: 1 })).statusCode, 400);
  assert.equal((await post(who, '/personal/api/conversion/quote', { direction: 'buy', asset: 'POLYGON_USDC', amount: 10.005 })).statusCode, 400);
  const sell = await post(who, '/personal/api/conversion/quote', { direction: 'sell', asset: 'POLYGON_USDC', amount: 6 });
  assert.equal(sell.statusCode, 200);
  assert.deepEqual(calls.at(-1)!.body.deposit, { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: 'POLYGON_USDC', amount: 6 });
});

test('limits come from Fonbnk', async () => {
  const who = await member();
  const res = await app.inject({ url: '/personal/api/conversion/limits?asset=POLYGON_USDC', headers: who.headers });
  assert.deepEqual(res.json(), { supported: true, min: 1000, max: 500000, currency: 'NGN' });
  assert.match(calls.at(-1)!.path, /^\/api\/v2\/order-limits\?depositPaymentChannel=bank&/);
});

test('an order goes to the customer\'s own wallet with strict order legs, and the key is bound to the request', async () => {
  const who = await member();
  const key = id('key');
  const res = await placeOrder(who, key);
  assert.equal(res.statusCode, 200, res.body);
  const sent = calls.filter((c) => c.path === '/api/v2/order' && c.method === 'POST').at(-1)!.body;
  assert.equal(sent.fieldsToCreateOrder.blockchainWalletAddress.toLowerCase(), who.address);
  assert.equal('transferType' in sent.deposit, false);
  assert.equal(sent.userEmail, who.email);
  const body = res.json();
  assert.equal(sent.orderParams, body.id);
  assert.equal(body.status, 'deposit_awaiting');
  assert.equal(body.transfer_instructions.fieldsToConfirmOrder[0].key, 'senderName');
  assert.deepEqual(body.receive, { code: 'POLYGON_USDC', network: 'Polygon', asset: 'USDC', amount: 6.03 });
  const before = creates();
  const quoteId = (await row(body.id)).quote_id;
  assert.equal((await post(who, '/personal/api/conversion/orders', orderBody(who, quoteId), { 'idempotency-key': key })).json().id, body.id);
  const other = await post(who, '/personal/api/conversion/orders', { ...orderBody(who, quoteId), fields: { phoneNumber: '+2348000000000', bankCode: '058' } }, { 'idempotency-key': key });
  assert.deepEqual([other.statusCode, other.json().error.code], [409, 'idempotency_conflict']);
  assert.equal(creates(), before);
  assert.equal((await app.inject({ url: '/personal/api/conversion/orders', headers: who.headers })).json().data[0].id, body.id);
});

test('an order needs this customer\'s unexpired quote for the same amount', async () => {
  const who = await member(), other = await member();
  const q = await getQuote(who);
  const differentAmount = await post(who, '/personal/api/conversion/orders', orderBody(who, q.quote_id, 20000), { 'idempotency-key': id('key') });
  assert.equal(differentAmount.json().error.code, 'quote_mismatch');
  const someoneElses = await post(other, '/personal/api/conversion/orders', orderBody(other, q.quote_id), { 'idempotency-key': id('key') });
  assert.equal(someoneElses.json().error.code, 'quote_mismatch');
  await pool.query("UPDATE personal_conversion_quotes SET expires_at=now()-interval '1 second' WHERE quote_id=$1", [q.quote_id]);
  const expired = await post(who, '/personal/api/conversion/orders', orderBody(who, q.quote_id), { 'idempotency-key': id('key') });
  assert.deepEqual([expired.statusCode, expired.json().error.code], [409, 'quote_expired']);
});

test('orders need a verified email, a linked wallet and Fonbnk BVN verification', async () => {
  const unverified = await member({ verified: false });
  const q0 = await getQuote(unverified);
  assert.equal((await post(unverified, '/personal/api/conversion/orders', orderBody(unverified, q0.quote_id), { 'idempotency-key': id('key') })).json().error.code, 'verified_email_required');
  const who = await member(), other = await member();
  const q = await getQuote(who);
  const foreign = await post(who, '/personal/api/conversion/orders', { ...orderBody(who, q.quote_id), wallet_id: other.walletId }, { 'idempotency-key': id('key') });
  assert.deepEqual([foreign.statusCode, foreign.json().error.code], [403, 'wallet_not_linked']);
  kycByEmail.set(who.email, { passedKycType: null, requiredKycType: 'basic', isNgBvnBlocked: false, kycUrls: { basic: 'https://kyc.fonbnk.com/basic/abc' } });
  const before = creates();
  const kyc = await post(who, '/personal/api/conversion/orders', orderBody(who, q.quote_id), { 'idempotency-key': id('key') });
  assert.deepEqual([kyc.statusCode, kyc.json().error.code], [409, 'provider_kyc_required']);
  assert.equal(creates(), before);
  assert.deepEqual((await app.inject({ url: '/personal/api/conversion/kyc', headers: who.headers })).json(),
    { ready: false, passed: null, status: null, support_required: false, limit_reached: false, kyc_url: 'https://kyc.fonbnk.com/basic/abc' });
  kycByEmail.set(who.email, { requiredKycType: 'basic', isNgBvnBlocked: true, isNgBvnSupportLocked: true, kycUrls: { basic: 'https://kyc.fonbnk.com/basic/abc' } });
  const locked = (await app.inject({ url: '/personal/api/conversion/kyc', headers: who.headers })).json();
  assert.deepEqual([locked.ready, locked.support_required, locked.kyc_url], [false, true, null]);
  assert.equal((await post(who, '/personal/api/conversion/orders', orderBody(who, q.quote_id), { 'idempotency-key': id('key') })).json().error.code, 'provider_kyc_support');
  kycByEmail.delete(who.email);
});

test('Fonbnk error codes are shown in Roots words, and unknown ones are not passed through', async () => {
  const who = await member();
  createReply = { status: 400, body: { message: 'Amount too low', errorCode: 'AMOUNT_BELOW_MINIMUM', details: { min: 1000 } } };
  const low = await placeOrder(who);
  assert.deepEqual([low.statusCode, low.json().error.code, low.json().error.message], [422, 'conversion_amount_below_minimum', 'The minimum is ₦1,000.']);
  createReply = { status: 403, body: { message: 'This feature is not available for this merchant, please contact support' } };
  assert.equal((await placeOrder(who)).json().error.code, 'conversion_unavailable');
  createReply = { status: 400, body: { message: 'internal detail: bad field x', errorCode: 'SOMETHING_NEW' } };
  const unknown = await placeOrder(who);
  assert.equal(unknown.json().error.code, 'conversion_provider_error');
  assert.doesNotMatch(unknown.json().error.message, /internal detail/);
  // A clear refusal leaves no order behind.
  const left = (await pool.query("SELECT status FROM personal_conversion_orders WHERE personal_user_id=$1", [who.userId])).rows.map((r) => r.status);
  assert.deepEqual([...new Set(left)], ['create_failed']);
  assert.equal((await app.inject({ url: '/personal/api/conversion/orders', headers: who.headers })).json().data.length, 0);
});

test('an unclear failure is resolved by looking the order up by its Roots reference', async () => {
  const who = await member();
  // Fonbnk created the order but the reply was lost: the lookup finds it.
  createReply = { status: 502, body: { message: 'Bad gateway' } };
  const recovered = await placeOrder(who);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().status, 'deposit_awaiting');
  assert.match((await row(recovered.json().id)).provider_order_id, /^fon_/);
  // Both the create and the lookup fail: the order waits, and the worker resolves it.
  createReply = 'network';
  lookupReply = 'network';
  const key = id('key');
  const pending = await placeOrder(who, key);
  assert.equal(pending.statusCode, 503);
  const waiting = (await pool.query("SELECT id FROM personal_conversion_orders WHERE personal_user_id=$1 AND idempotency_key=$2", [who.userId, key])).rows[0];
  assert.equal((await row(waiting.id)).status, 'creating');
  const retry = await post(who, '/personal/api/conversion/orders', orderBody(who, (await row(waiting.id)).quote_id), { 'idempotency-key': key });
  assert.equal(retry.json().error.code, 'order_in_progress');
  createReply = null; lookupReply = null;
  ordersByParams.delete(waiting.id); // Fonbnk never got it
  await pool.query("UPDATE personal_conversion_orders SET next_check_at=now(), created_at=now()-interval '11 minutes' WHERE id=$1", [waiting.id]);
  while (await reconcileOneConversionOrder(client)) { /* drain due orders */ }
  assert.equal((await row(waiting.id)).status, 'create_failed');
});

test('signed webhooks apply before they are recorded, unknown orders are retried, and status never moves back', async () => {
  const who = await member();
  const created = (await placeOrder(who)).json();
  const webhookSecret = 'fonbnk-webhook-secret';
  process.env.FONBNK_WEBHOOK_SECRET = webhookSecret;
  try {
    const providerId = (await row(created.id)).provider_order_id;
    const sign = (body: string) => createHash('sha256').update(body + createHash('sha256').update(webhookSecret).digest('hex')).digest('hex');
    const send = (raw: string, sig = sign(raw)) => app.inject({ method: 'POST', url: '/personal/api/webhooks/fonbnk', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: raw });
    const event = (orderId: string, status: string, params?: string) => JSON.stringify({ event: 'order-status-change', data: { order: { _id: orderId, status, merchantOrderParams: params }, userKyc: {} } });
    const raw = event(providerId, 'deposit_successful');
    assert.equal(verifyFonbnkWebhook(raw, sign(raw + ' '), webhookSecret), false);
    assert.equal((await send(raw, '0'.repeat(64))).statusCode, 401);
    assert.equal((await send(event('fon_unknown', 'deposit_successful', 'cnv_' + '0'.repeat(32)))).statusCode, 404);
    // The order cannot be read: answer non-2xx and do not record the delivery, so Fonbnk retries it.
    lookupReply = { status: 500, body: { message: 'down' } };
    assert.equal((await send(raw)).statusCode, 503);
    assert.equal((await pool.query('SELECT 1 FROM fonbnk_webhook_events WHERE provider_order_id=$1', [providerId])).rowCount, 0);
    lookupReply = null;
    nextOrderStatus = 'payout_pending';
    assert.equal((await send(raw)).statusCode, 200);
    assert.equal((await row(created.id)).status, 'payout_pending');
    // Matched by our reference too.
    nextOrderStatus = 'payout_successful';
    assert.equal((await send(event('fon_other_id', 'payout_successful', created.id))).statusCode, 200);
    let current = await row(created.id);
    assert.deepEqual([current.status, current.payout_tx_hash], ['payout_successful', '0x' + 'e'.repeat(64)]);
    // A late, older status does not undo delivery.
    nextOrderStatus = 'deposit_awaiting';
    assert.equal((await send(event(providerId, 'deposit_awaiting'))).statusCode, 200);
    assert.equal((await row(created.id)).status, 'payout_successful');
  } finally { delete process.env.FONBNK_WEBHOOK_SECRET; }
});

test('the worker backs off and confirm sends the fields Fonbnk asks for', async () => {
  const who = await member();
  const created = (await placeOrder(who)).json();
  const confirm = await post(who, `/personal/api/conversion/orders/${created.id}/confirm`, { fields: { senderName: 'Ada Obi' } });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.deepEqual(calls.filter((c) => c.path === '/api/v2/order/confirm').at(-1)!.body, { orderId: (await row(created.id)).provider_order_id, fieldsToConfirmOrder: { senderName: 'Ada Obi' } });
  nextOrderStatus = 'deposit_validating';
  await pool.query('UPDATE personal_conversion_orders SET next_check_at=now() WHERE id=$1', [created.id]);
  while (await reconcileOneConversionOrder(client)) { /* drain due orders */ }
  const after1 = await row(created.id);
  assert.equal(after1.status, 'deposit_validating');
  assert.equal(after1.check_count, 1);
  assert.ok(new Date(after1.next_check_at).getTime() > Date.now() + 60_000);
  // A production worker leaves sandbox orders alone.
  const production = new FonbnkClient({ clientId: 'client_test', signatureSecret: secret, baseUrl: 'https://api.fonbnk.com', fetch: fake });
  await pool.query('UPDATE personal_conversion_orders SET next_check_at=now() WHERE id=$1', [created.id]);
  while (await reconcileOneConversionOrder(production)) { /* nothing for production */ }
  assert.equal((await row(created.id)).check_count, 1);
  await pool.query("UPDATE personal_conversion_orders SET next_check_at='infinity' WHERE id=$1", [created.id]);
});
