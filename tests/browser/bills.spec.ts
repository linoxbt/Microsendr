import { test, expect } from '@playwright/test';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const csrf = 'c'.repeat(64);
const treasury = '0x' + '7'.repeat(40);
const profile = {
  email: 'ada@example.test', email_verified_at: '2026-10-01T00:00:00Z', phone_verified_at: null, first_name: 'Ada', last_name: 'Okafor',
  username: 'ada_okafor', phone: '+2348031234567', residence_country: 'NG', nationality: 'NG', date_of_birth: '1995-05-12',
  address_line1: '1 St', address_line2: '', city: 'Lagos', region: 'Lagos', postal_code: '', occupation: '', display_currency: 'USD',
  profile_version: 1, identity_status: 'Approved', identity_locked: true, has_password: true,
};
async function signedIn(page: import('@playwright/test').Page) {
  await page.route('**/personal/api/session', (r) => r.fulfill(json({ authenticated: true, csrf_token: csrf, email: profile.email })));
  await page.route('**/personal/api/profile', (r) => r.fulfill(json(profile)));
  await page.route('**/personal/api/payment-auth', (r) => r.fulfill(json({ pin_set: true, pin_locked_until: null, passkeys: [] })));
  await page.route('**/personal/api/overview', (r) => r.fulfill(json({ balances: [], total: null, activity: [], wallet_value_usd: { amount_usd: '20.00', checked_at: null }, assets: [],
    capabilities: Object.fromEntries(['fiat_deposit', 'crypto_deposit', 'withdrawal', 'transfer', 'conversion'].map((k) => [k, { available: false, reason: '' }])) })));
  await page.route('**/personal/api/bills/config', (r) => r.fulfill(json({ available: true, environment: 'sandbox', countries: ['NG'], giftcard_countries: ['US', 'GB', 'NG'], kinds: [] })));
}

test('airtime: the network is found from the number, the price is shown in QUSDC, and the PIN pays', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/bills/operator*', (r) => r.fulfill(json({ operator: { id: 341, name: 'MTN Nigeria', logo: null, currency: 'NGN',
    denomination: 'RANGE', min: 50, max: 50000, fixed: [], plans: [] } })));
  const quotes: unknown[] = [], orders: unknown[] = [];
  await page.route('**/personal/api/bills/quote', (r) => (quotes.push(r.request().postDataJSON()), r.fulfill(json({ product_name: 'MTN Nigeria airtime',
    face: { amount: 1000, currency: 'NGN' }, cost_usd: 0.63, fee_usd: 0.05, price_atomic: '680000', pay_to: treasury, asset: 'QUSDC' }))));
  let status = 'paid';
  const order = () => ({ id: 'bil_' + 'a'.repeat(32), kind: 'airtime', status, product_name: 'MTN Nigeria airtime', recipient: '+2348031234567',
    face: { amount: 1000, currency: 'NGN' }, price_atomic: '680000', environment: 'sandbox', created_at: new Date().toISOString() });
  await page.route('**/personal/api/bills/orders', (r) => (orders.push({ body: r.request().postDataJSON(), key: r.request().headers()['idempotency-key'] }), r.fulfill(json(order()))));
  await page.route('**/personal/api/bills/orders/bil_*', (r) => r.fulfill(json(order())));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/personal/home');
  await page.getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: 'Airtime' }).click();
  await expect(page).toHaveURL(/\/personal\/airtime$/);
  await expect(page.getByLabel('Phone number')).toHaveValue('+2348031234567');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('MTN Nigeria')).toBeVisible();
  await page.getByRole('group', { name: 'Amount' }).getByRole('button', { name: '₦1,000' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const review = page.getByRole('form', { name: 'Review purchase' });
  await expect(review).toContainText('0.68 QUSDC');
  await expect(review).toContainText('₦1,000');
  expect(quotes).toEqual([{ kind: 'airtime', country: 'NG', phone: '+2348031234567', operator_id: 341, amount: 1000 }]);
  await review.getByLabel('Payment PIN').fill('402913');
  await review.getByRole('button', { name: /Pay 0.68 QUSDC/ }).click();
  await expect(page).toHaveURL(/\/personal\/bills\/bil_a+$/);
  await expect(page.getByRole('heading', { name: 'Payment confirming' })).toBeVisible();
  expect(orders).toHaveLength(1);
  expect((orders[0] as { body: Record<string, unknown> }).body).toMatchObject({ kind: 'airtime', operator_id: 341, amount: 1000, max_price_atomic: '680000', pin: '402913' });
  expect((orders[0] as { key: string }).key).toMatch(/^[0-9a-f-]{36}$/);
  status = 'delivered';
  await expect(page.getByRole('heading', { name: 'Delivered' })).toBeVisible({ timeout: 10_000 });
});

test('subscriptions: a card, an amount and the code after delivery', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/bills/giftcards*', (r) => r.fulfill(json({ data: [
    { id: 18, name: 'Netflix US', brand: 'Netflix', logo: null, currency: 'USD', denomination: 'FIXED', fixed: [25, 50], min: null, max: null },
    { id: 21, name: 'Spotify US', brand: 'Spotify', logo: null, currency: 'USD', denomination: 'FIXED', fixed: [10], min: null, max: null }] })));
  await page.route('**/personal/api/bills/quote', (r) => r.fulfill(json({ product_name: 'Netflix US', face: { amount: 25, currency: 'USD' },
    cost_usd: 25.9, fee_usd: 0.39, price_atomic: '26290000', pay_to: treasury, asset: 'QUSDC' })));
  const delivered = { id: 'bil_' + 'b'.repeat(32), kind: 'giftcard', status: 'delivered', product_name: 'Netflix US', recipient: 'ada@example.test',
    face: { amount: 25, currency: 'USD' }, price_atomic: '26290000', environment: 'sandbox', created_at: new Date().toISOString(), codes: [{ code: 'NFLX-1234-5678', pin: null }] };
  await page.route('**/personal/api/bills/orders', (r) => r.fulfill(json({ ...delivered, status: 'paid', codes: undefined })));
  await page.route('**/personal/api/bills/orders/bil_*', (r) => r.fulfill(json(delivered)));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/personal/giftcards');
  await expect(page.getByRole('list', { name: 'Cards' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('listitem').filter({ hasText: 'Netflix' }).click();
  await page.getByRole('group', { name: 'Amount' }).getByRole('button', { name: '25 USD' }).click();
  await expect(page.getByLabel('Send the code to')).toHaveValue('ada@example.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Payment PIN').fill('402913');
  await page.getByRole('button', { name: /Pay 26.29 QUSDC/ }).click();
  await expect(page.getByRole('heading', { name: 'Delivered' })).toBeVisible();
  await expect(page.getByText('NFLX-1234-5678')).toBeVisible();
});

test('when not configured, the bills pages say coming soon', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/bills/config', (r) => r.fulfill(json({ available: false, environment: '', countries: [], giftcard_countries: [], kinds: [] })));
  await page.goto('/personal/data');
  await expect(page.getByText('Coming soon')).toBeVisible();
});
