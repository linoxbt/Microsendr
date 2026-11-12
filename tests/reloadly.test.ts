import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReloadlyClient } from '../services/api/src/reloadly.js';

// A Reloadly stand-in answering in the shapes its API documents.
function server() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body });
    if (u.host === 'auth.reloadly.com') return Response.json({ access_token: `tok-${body.audience}`, expires_in: 86400, token_type: 'Bearer' });
    if (u.pathname === '/operators/auto-detect/phone/999/countries/NG') return Response.json({ errorCode: 'COULD_NOT_AUTO_DETECT_OPERATOR' }, { status: 404 });
    if (u.pathname.startsWith('/operators/auto-detect')) return Response.json({ operatorId: 341, name: 'MTN Nigeria', data: false, bundle: false,
      denominationType: 'RANGE', destinationCurrencyCode: 'NGN', localMinAmount: 50, localMaxAmount: 50000, logoUrls: ['https://cdn/mtn.png'], country: { isoName: 'NG' } });
    if (u.pathname === '/operators/fx-rate') return Response.json({ id: 341, name: 'MTN Nigeria', fxRate: 1600, currencyCode: 'NGN' });
    if (u.pathname === '/operators/341') return Response.json({ operatorId: 341, name: 'MTN Nigeria', denominationType: 'RANGE', destinationCurrencyCode: 'NGN',
      fees: { international: 0.1, internationalPercentage: 2 } });
    if (u.pathname === '/topups') return Response.json({ transactionId: 9001, status: 'SUCCESSFUL', deliveredAmount: 1000, deliveredAmountCurrencyCode: 'NGN', customIdentifier: body.customIdentifier });
    if (u.pathname === '/products/18') return Response.json({ productId: 18, productName: 'Netflix US', brand: { brandName: 'Netflix' }, denominationType: 'FIXED',
      recipientCurrencyCode: 'USD', fixedRecipientDenominations: [25], fixedRecipientToSenderDenominationsMap: { '25.0': 25.4 }, senderFee: 0.5, senderFeePercentage: 0 });
    if (u.pathname === '/orders') return Response.json({ transactionId: 77, status: 'SUCCESSFUL', product: { productName: 'Netflix US' } });
    if (u.pathname === '/orders/transactions/77/cards') return Response.json([{ cardNumber: 'ABCD-1234', pinCode: '9999' }]);
    if (u.pathname === '/topups/reports/transactions') return Response.json({ content: [] });
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch;
  return { calls, client: new ReloadlyClient({ clientId: 'id', clientSecret: 'secret', production: false, fetch: fetchFake }) };
}

test('sandbox requests use the right audiences, bearer tokens and Accept headers', async () => {
  const { calls, client } = server();
  const operator = await client.detectOperator('2348031234567', 'NG');
  assert.equal(operator?.name, 'MTN Nigeria');
  assert.equal(calls[0].body.audience, 'https://topups-sandbox.reloadly.com');
  assert.equal(calls[0].body.grant_type, 'client_credentials');
  assert.equal(calls[1].headers.authorization, 'Bearer tok-https://topups-sandbox.reloadly.com');
  assert.equal(calls[1].headers.accept, 'application/com.reloadly.topups-v1+json');
  await client.giftCard(18);
  const auth = calls.filter((c) => c.url.includes('auth.reloadly.com'));
  assert.deepEqual(auth.map((c) => c.body.audience), ['https://topups-sandbox.reloadly.com', 'https://giftcards-sandbox.reloadly.com']);
  // One token per audience, reused.
  await client.giftCard(18);
  assert.equal(calls.filter((c) => c.url.includes('auth.reloadly.com')).length, 2);
});

test('costs include the operator and card fees; orders carry our reference', async () => {
  const { calls, client } = server();
  // 1600 NGN at 1600/USD = $1.00, plus $0.10 and 2% = $1.12.
  assert.equal(await client.topupCostUsd(341, 1600), 1.12);
  // $25 Netflix card: $25.40 plus the $0.50 sender fee.
  assert.equal(await client.giftCardCostUsd(18, 25), 25.9);
  const topup = await client.topup({ operatorId: 341, localAmount: 1000, phone: '2348031234567', countryCode: 'NG', reference: 'bil_x' });
  assert.deepEqual(topup, { transactionId: '9001', status: 'SUCCESSFUL', details: { delivered: 1000, currency: 'NGN', operatorReference: undefined } });
  const sent = calls.find((c) => c.url.endsWith('/topups'))!.body;
  assert.deepEqual(sent, { operatorId: 341, amount: 1000, useLocalAmount: true, customIdentifier: 'bil_x', recipientPhone: { countryCode: 'NG', number: '2348031234567' } });
  await client.orderGiftCard({ productId: 18, countryCode: 'US', faceAmount: 25, email: 'a@example.test', senderName: 'Microsendr', reference: 'bil_y' });
  const order = calls.find((c) => c.url.endsWith('/orders'))!.body;
  assert.deepEqual(order, { productId: 18, quantity: 1, unitPrice: 25, customIdentifier: 'bil_y', senderName: 'Microsendr', recipientEmail: 'a@example.test' });
  assert.deepEqual(await client.giftCardCodes('77'), [{ code: 'ABCD-1234', pin: '9999' }]);
  assert.equal(await client.findTopup('bil_unknown'), null);
  assert.equal(await client.detectOperator('999', 'NG'), null);
});
