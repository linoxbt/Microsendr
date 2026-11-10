import { test, expect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const csrf = 'c'.repeat(64);
const linked = privateKeyToAccount(generatePrivateKey()).address;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const profile = {
  email: 'ada@example.test', email_verified_at: '2026-10-01T00:00:00Z', phone_verified_at: null, first_name: 'Ada', last_name: 'Okafor',
  username: 'ada_okafor', phone: '+2348012345678', residence_country: 'NG', nationality: 'NG', date_of_birth: '1995-05-12',
  address_line1: '14 Example Street', address_line2: '', city: 'Lagos', region: 'Lagos', postal_code: '100001', occupation: 'Designer',
  display_currency: 'USD', profile_version: 1, identity_status: 'Approved', identity_locked: true, has_password: true,
};
const capabilities = Object.fromEntries(['fiat_deposit', 'crypto_deposit', 'withdrawal', 'transfer'].map((k) => [k, { available: false, reason: 'Not yet.' }]));
const quote = {
  quote_id: 'quote_abc123', expires_at: '2026-11-10T08:00:00.000Z', direction: 'buy', pay: { currency: 'NGN', amount: 10000 },
  receive: { currency: 'POLYGON_USDC', amount: 6.03 }, rate: 1550,
  fees: [{ id: 'service_fee', label: 'Fonbnk service fee', amount: 250, currency: 'NGN' }, { id: 'gas', label: 'Network fee', amount: 0.17, currency: 'POLYGON_USDC' }],
  fields: [{ key: 'phoneNumber', label: 'Phone number', type: 'phone' }, { key: 'bankCode', label: 'Bank', options: [{ value: '058', label: 'GTBank' }] }],
};
const order = (status: string) => ({
  id: 'cnv_' + 'a'.repeat(32), status, pay: { currency: 'NGN', amount: 10000 }, receive: { code: 'POLYGON_USDC', network: 'Polygon', asset: 'USDC', amount: 6.03 },
  wallet_address: linked, created_at: '2026-11-10T07:00:00Z', payout_tx_hash: null,
  transfer_instructions: { instructionsText: 'Transfer exactly the amount shown.', warningText: 'Use only your own bank account.',
    transferDetails: [{ id: 'recipientBankName', value: 'Sandbox Bank' }, { id: 'recipientBankAccountNumber', value: '0123456789' }, { id: 'amountToSend', value: 10000 }] },
});

test('buying digital dollars with naira shows every fee, then Fonbnk bank instructions', async ({ page }) => {
  await page.route('**/personal/api/session', (r) => r.fulfill(json({ authenticated: true, csrf_token: csrf, email: profile.email })));
  await page.route('**/personal/api/profile', (r) => r.fulfill(json(profile)));
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pin_set: false, pin_locked_until: null, passkeys: [] }) }));
  await page.route('**/personal/api/kyc', (r) => r.fulfill(json({ email_verified: true, status: 'Approved', url: null, updated_at: null, configured: true })));
  await page.route('**/personal/api/overview', (r) => r.fulfill(json({ balances: [], total: null, assets: [], activity: [], wallet_value_usd: { amount_usd: null, checked_at: null },
    capabilities: { ...capabilities, conversion: { available: true, reason: 'Buy digital dollars with naira through Fonbnk.' } } })));
  await page.route('**/personal/api/conversion/config', (r) => r.fulfill(json({ available: true, assets: [{ code: 'POLYGON_USDC', network: 'Polygon', asset: 'USDC' }] })));
  await page.route('**/personal/api/wallets', (r) => r.fulfill(json({ data: [
    { id: 'privy_wallet_x', address: linked, managed: true, custody: 'managed' },
    { id: 'cwa_' + 'b'.repeat(32), address: linked, managed: false }] })));
  await page.route('**/personal/api/conversion/orders', (r) => r.request().method() === 'POST'
    ? (orderPosts.push(r.request().postDataJSON()), r.fulfill(json(order('deposit_awaiting'))))
    : r.fulfill(json({ data: [] })));
  await page.route('**/personal/api/conversion/quote', (r) => r.fulfill(json(quote)));
  await page.route('**/personal/api/conversion/orders/*/confirm', (r) => r.fulfill(json(order('deposit_validating'))));
  const orderPosts: Record<string, unknown>[] = [];
  await page.goto('/personal/convert');
  await page.getByLabel('Amount in naira (NGN)').fill('10000');
  await page.getByRole('button', { name: 'Get quote' }).click();
  const breakdown = page.getByRole('region', { name: 'Quote' });
  await expect(breakdown).toContainText('Fonbnk service fee');
  await expect(breakdown).toContainText('₦250');
  await expect(breakdown).toContainText('Network fee');
  await expect(breakdown).toContainText('6.03 USDC');
  await expect(breakdown).toContainText('1 USDC = ₦1,550');
  // Only the self-custody wallet is offered for delivery.
  await expect(page.getByLabel('Deliver to wallet').locator('option')).toHaveCount(1);
  await page.getByLabel('Phone number').fill('+2348012345678');
  await page.getByLabel('Bank').selectOption('058');
  await page.getByRole('button', { name: /Buy now/ }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for your bank transfer' })).toBeVisible();
  await expect(page.getByLabel('Bank transfer details')).toContainText('0123456789');
  await expect(page.getByRole('note')).toContainText('Use only your own bank account.');
  expect(orderPosts[0]).toMatchObject({ quote_id: 'quote_abc123', asset: 'POLYGON_USDC', amount: 10000, wallet_id: 'cwa_' + 'b'.repeat(32),
    fields: { phoneNumber: '+2348012345678', bankCode: '058' } });
  await page.getByRole('button', { name: /I've sent the payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Checking your payment' })).toBeVisible();
});
