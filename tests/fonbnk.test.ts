import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { id, pool } from '../packages/database/src/index.js';
import { hashKey } from '../packages/payments/src/auth.js';
import { FonbnkClient, verifyFonbnkWebhook } from '../connectors/fonbnk/src/index.js';
import { buildApi } from '../services/api/src/app.js';
import { reconcileOneConversionOrder } from '../services/api/src/conversion.js';

const secret = Buffer.from('fonbnk-signature-secret-for-tests').toString('base64');
const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
let nextOrderStatus = 'deposit_awaiting';
let failCreate: { status: number; body: unknown } | null = null;
const cashout = (amountBeforeFees: number, amountAfterFees: number, chargedFees: unknown[] = []) => ({
  amountBeforeFees, amountAfterFees, amountBeforeFeesUsd: 1, amountAfterFeesUsd: 1, exchangeRate: 1550, exchangeRateAfterFees: 1600,
  chargedFees, totalChargedFees: 0, totalChargedFeesUsd: 0.25,
});
const quote = {
  quoteId: 'quote_abc123', quoteExpiresAt: '2026-11-10T08:00:00.000Z',
  deposit: { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', cashout: cashout(10000, 9650, [
    { id: 'service_fee', type: 'percentage', recipient: 'platform', amount: 250 }, { id: 'merchant_fee', recipient: 'merchant', amount: 100 }]),
    fieldsToCreateOrder: [{ key: 'phoneNumber', label: 'Phone number', type: 'phone' }, { key: 'bankCode', label: 'Bank', type: 'select', options: [{ value: '058', label: 'GTBank' }] }, { key: 'bankAccountNumber', label: 'Account number', type: 'string' }] },
  payout: { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: 'POLYGON_USDC', cashout: cashout(6.2, 6.03, [{ id: 'gas', recipient: 'blockchain', amount: 0.17 }]),
    fieldsToCreateOrder: [{ key: 'blockchainWalletAddress', label: 'Wallet', type: 'string' }] },
};
let orderSeq = 0, lastOrderId = 'fon_order_0';
const order = (status: string, orderId = lastOrderId) => ({
  _id: orderId, status, expiresAt: '2026-11-10T09:00:00.000Z',
  deposit: { cashout: quote.deposit.cashout, transferInstructions: { type: 'manual', instructionsText: 'Transfer exactly the amount shown.', warningText: 'Use only your own bank account.',
    transferDetails: [{ id: 'recipientBankName', value: 'Sandbox Bank' }, { id: 'recipientBankAccountNumber', value: '0123456789' }, { id: 'recipientBankAccountName', value: 'Fonbnk' }, { id: 'amountToSend', value: 10000 }] } },
  payout: { cashout: quote.payout.cashout, transaction: { meta: status === 'payout_successful' ? { transactionHash: '0x' + 'e'.repeat(64) } : {} } },
});
const fake = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const headers = init?.headers as Record<string, string>;
  calls.push({ method: init?.method ?? 'GET', path: u.pathname + u.search, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (u.pathname === '/api/v2/quote') return Response.json(quote);
  if (u.pathname === '/api/v2/order' && init?.method === 'POST') {
    if (failCreate) return Response.json(failCreate.body, { status: failCreate.status });
    lastOrderId = `fon_order_${++orderSeq}_${Date.now()}`;
    return Response.json({ quoteUsed: true, order: order('deposit_awaiting', lastOrderId) });
  }
  if (u.pathname === '/api/v2/order') return Response.json(order(nextOrderStatus, u.searchParams.get('orderId') ?? lastOrderId));
  if (u.pathname === '/api/v2/order/confirm') return Response.json({ ok: true });
  return Response.json({ message: 'not found' }, { status: 404 });
}) as typeof fetch;
const client = new FonbnkClient({ clientId: 'client_test', signatureSecret: secret, baseUrl: 'https://sandbox-api.fonbnk.com', fetch: fake });
const app = await buildApi({ serveWeb: false, rateLimitMax: 10000, personal: { fonbnkClient: client } });
after(async () => { await app.close(); await pool.end(); });

async function member({ verified = true } = {}) {
  const userId = id('usr'), accountId = id('acct'), token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO personal_users(id,email,email_verified_at) VALUES($1,$2,$3)', [userId, `${userId}@example.test`, verified ? new Date() : null]);
  await pool.query("INSERT INTO kora_accounts(id,owner_type,personal_user_id) VALUES($1,'personal',$2)", [accountId, userId]);
  await pool.query("INSERT INTO personal_sessions(token_hash,personal_user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [hashKey(token), userId, csrf]);
  const walletId = id('cwa'), address = `0x${randomBytes(20).toString('hex')}`;
  await pool.query("INSERT INTO personal_chain_wallets(id,personal_user_id,account_id,network,address) VALUES($1,$2,$3,'qie-mainnet',$4)", [walletId, userId, accountId, address]);
  return { userId, walletId, address, headers: { origin: 'http://127.0.0.1:4310', cookie: `kora_personal=${token}`, 'x-kora-csrf': csrf } };
}
const post = (who: { headers: Record<string, string> }, url: string, payload: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...who.headers, ...extra }, payload: payload as object });
const orderBody = (walletId: string) => ({ quote_id: 'quote_abc123', asset: 'POLYGON_USDC', amount: 10000, wallet_id: walletId,
  fields: { phoneNumber: '+2348012345678', bankCode: '058', bankAccountNumber: '0123456789', blockchainWalletAddress: '0x' + '9'.repeat(40) } });

test('requests are signed as Fonbnk documents: HMAC-SHA256 of timestamp:path with the base64 secret', async () => {
  calls.length = 0;
  await client.quote({ paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', countryIsoCode: 'NG', amount: 10000, transferType: 'manual' },
    { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: 'POLYGON_USDC' });
  const { headers, path } = calls[0];
  assert.equal(headers['x-client-id'], 'client_test');
  assert.match(headers['x-timestamp'], /^\d{13}$/);
  const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${headers['x-timestamp']}:${path}`).digest('base64');
  assert.equal(headers['x-signature'], expected);
  assert.equal(path, '/api/v2/quote');
});

test('a buy quote shows the rate, every fee and the amount received; Roots fills the wallet', async () => {
  const who = await member();
  const res = await post(who, '/personal/api/conversion/quote', { direction: 'buy', asset: 'POLYGON_USDC', amount: 10000 });
  assert.equal(res.statusCode, 200, res.body);
  const q = res.json();
  assert.deepEqual([q.quote_id, q.pay, q.receive, q.rate], ['quote_abc123', { currency: 'NGN', amount: 10000 }, { currency: 'POLYGON_USDC', amount: 6.03 }, 1550]);
  assert.deepEqual(q.fees.map((f: { label: string; amount: number }) => [f.label, f.amount]),
    [['Fonbnk service fee', 250], ['Roots fee', 100], ['Network fee', 0.17]]);
  assert.deepEqual(q.fields.map((f: { key: string }) => f.key), ['phoneNumber', 'bankCode', 'bankAccountNumber']);
  const sent = calls.at(-1)!.body;
  assert.deepEqual(sent.deposit, { paymentChannel: 'bank', currencyType: 'fiat', currencyCode: 'NGN', countryIsoCode: 'NG', amount: 10000, transferType: 'manual' });
  assert.equal((await post(who, '/personal/api/conversion/quote', { direction: 'buy', asset: 'QIE_USDC', amount: 1 })).statusCode, 400);
  const sell = await post(who, '/personal/api/conversion/quote', { direction: 'sell', asset: 'POLYGON_USDC', amount: 6 });
  assert.equal(sell.statusCode, 200);
  assert.deepEqual(calls.at(-1)!.body.deposit, { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: 'POLYGON_USDC', amount: 6 });
  assert.deepEqual(sell.json().fields, []);
});

test('an order pays to the customer\'s own linked wallet, is idempotent and returns bank instructions', async () => {
  failCreate = null;
  const who = await member();
  const key = id('key');
  const res = await post(who, '/personal/api/conversion/orders', orderBody(who.walletId), { 'idempotency-key': key });
  assert.equal(res.statusCode, 200, res.body);
  const created = calls.filter((c) => c.path === '/api/v2/order' && c.method === 'POST').at(-1)!.body;
  assert.equal(created.fieldsToCreateOrder.blockchainWalletAddress.toLowerCase(), who.address);
  assert.equal(created.userEmail, `${who.userId}@example.test`);
  assert.equal(created.quoteId, 'quote_abc123');
  assert.match(created.orderParams, /^cnv_[a-f0-9]{32}$/);
  const body = res.json();
  assert.equal(body.status, 'deposit_awaiting');
  assert.equal(body.transfer_instructions.transferDetails[1].value, '0123456789');
  assert.deepEqual(body.receive, { code: 'POLYGON_USDC', network: 'Polygon', asset: 'USDC', amount: 6.03 });
  const creates = calls.filter((c) => c.path === '/api/v2/order' && c.method === 'POST').length;
  assert.equal((await post(who, '/personal/api/conversion/orders', orderBody(who.walletId), { 'idempotency-key': key })).json().id, body.id);
  assert.equal(calls.filter((c) => c.path === '/api/v2/order' && c.method === 'POST').length, creates);
  const listed = (await app.inject({ url: '/personal/api/conversion/orders', headers: who.headers })).json();
  assert.equal(listed.data[0].id, body.id);
});

test('orders need a verified email and a linked wallet; Fonbnk BVN checks are explained', async () => {
  const unverified = await member({ verified: false });
  assert.equal((await post(unverified, '/personal/api/conversion/orders', orderBody(unverified.walletId), { 'idempotency-key': id('key') })).json().error.code, 'verified_email_required');
  const who = await member(), other = await member();
  const foreign = await post(who, '/personal/api/conversion/orders', orderBody(other.walletId), { 'idempotency-key': id('key') });
  assert.deepEqual([foreign.statusCode, foreign.json().error.code], [403, 'wallet_not_linked']);
  failCreate = { status: 403, body: { code: 'NG_BVN_REQUIRED', message: 'BVN required' } };
  const kyc = await post(who, '/personal/api/conversion/orders', orderBody(who.walletId), { 'idempotency-key': id('key') });
  assert.deepEqual([kyc.statusCode, kyc.json().error.code], [409, 'provider_kyc_required']);
  failCreate = { status: 403, body: { message: 'This feature is not available for this merchant, please contact support' } };
  assert.equal((await post(who, '/personal/api/conversion/orders', orderBody(who.walletId), { 'idempotency-key': id('key') })).json().error.code, 'conversion_unavailable');
  failCreate = null;
});

test('signed webhooks and the worker move an order to delivered', async () => {
  failCreate = null;
  const who = await member();
  const created = (await post(who, '/personal/api/conversion/orders', orderBody(who.walletId), { 'idempotency-key': id('key') })).json();
  const webhookSecret = 'fonbnk-webhook-secret';
  process.env.FONBNK_WEBHOOK_SECRET = webhookSecret;
  try {
    const providerId = (await pool.query('SELECT provider_order_id FROM personal_conversion_orders WHERE id=$1', [created.id])).rows[0].provider_order_id;
    const raw = JSON.stringify({ event: 'order-status-change', data: { order: { _id: providerId, status: 'deposit_successful' }, userKyc: {} } });
    const sign = (body: string) => createHash('sha256').update(body + createHash('sha256').update(webhookSecret).digest('hex')).digest('hex');
    assert.equal(verifyFonbnkWebhook(raw, sign(raw), webhookSecret), true);
    assert.equal(verifyFonbnkWebhook(raw, sign(raw + ' '), webhookSecret), false);
    const send = (sig: string) => app.inject({ method: 'POST', url: '/personal/api/webhooks/fonbnk', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: raw });
    assert.equal((await send('0'.repeat(64))).statusCode, 401);
    nextOrderStatus = 'payout_pending';
    assert.equal((await send(sign(raw))).statusCode, 200);
    let row = (await pool.query('SELECT status FROM personal_conversion_orders WHERE id=$1', [created.id])).rows[0];
    assert.equal(row.status, 'payout_pending');
    nextOrderStatus = 'payout_successful';
    await pool.query("UPDATE personal_conversion_orders SET last_checked_at=now()-interval '1 hour' WHERE id=$1", [created.id]);
    while (await reconcileOneConversionOrder(client)) { /* drain due orders */ }
    row = (await pool.query('SELECT status,payout_tx_hash FROM personal_conversion_orders WHERE id=$1', [created.id])).rows[0];
    assert.deepEqual(row, { status: 'payout_successful', payout_tx_hash: '0x' + 'e'.repeat(64) });
  } finally { delete process.env.FONBNK_WEBHOOK_SECRET; nextOrderStatus = 'deposit_awaiting'; }
});
