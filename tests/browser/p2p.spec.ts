import { test, expect, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const csrf = 'csrf_browser_mock';
const payeeAddress = privateKeyToAccount(generatePrivateKey()).address;
const accountAddress = privateKeyToAccount(generatePrivateKey()).address;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const profile = {
  email: 'mock@example.test', email_verified_at: '2026-10-01T00:00:00Z', phone_verified_at: null,
  first_name: 'Tobi', last_name: 'Adeyemi', username: 'tobi_mock', phone: '+2348000000000',
  residence_country: 'NG', nationality: null, date_of_birth: '1995-05-12',
  address_line1: '14 Example Street', address_line2: '', city: 'Lagos', region: 'Lagos',
  postal_code: '', occupation: '', display_currency: 'USD', profile_version: 1,
  identity_status: 'Approved', identity_locked: true, has_password: true,
};
const overview = {
  balances: [], total: null, assets: [], wallet_value_usd: { amount_usd: null, checked_at: null }, activity: [],
  capabilities: {
    fiat_deposit: { available: false, reason: 'Bank deposits are not available yet.' },
    crypto_deposit: { available: false, reason: 'Not available.' },
    withdrawal: { available: false, reason: 'Bank withdrawals are not available yet.' },
    transfer: { available: false, reason: 'Not available.' },
    conversion: { available: false, reason: 'Not available.' },
  },
};

async function signedIn(page: Page) {
  await page.route('**/personal/api/session', (route) => route.fulfill(json({ authenticated: true, csrf_token: csrf, email: profile.email })));
  await page.route('**/personal/api/profile', (route) => route.fulfill(json(profile)));
  await page.route('**/personal/api/overview', (route) => route.fulfill(json(overview)));
  await page.route('**/personal/api/kyc', (route) => route.fulfill(json({ email_verified: true, status: 'Approved', url: null, updated_at: null, configured: true })));
}

test('paying @username resolves the recipient and sends to their address', async ({ page }) => {
  await signedIn(page);
  const limits = { per_transfer_wei: '1000000000000000000000', daily_wei: '5000000000000000000000', requires_identity_verification: true };
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({
    data: [{ id: 'privy_wallet_mock', address: accountAddress, network: 'qie-mainnet', managed: true, custody: 'managed', can_send: true }],
    managed_transfers: limits,
  })));
  await page.route('**/personal/api/wallets/*/balance', (route) => route.fulfill(json({ balance_wei: '5000000000000000000' })));
  const lookups: string[] = [];
  await page.route('**/personal/api/recipients/*', (route) => {
    const name = route.request().url().split('/').pop()!;
    lookups.push(name);
    return name === 'ada_okafor'
      ? route.fulfill(json({ username: 'ada_okafor', display_name: 'Ada O.', address: payeeAddress, network: 'qie-mainnet', asset: 'QIEV3' }))
      : route.fulfill(json({ error: { code: 'recipient_unavailable', message: 'No Roots user can be paid at that username' } }, 404));
  });
  const posts: Record<string, string>[] = [];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill(json({ id: 'stl_' + 'e'.repeat(32), tx_hash: '0x' + 'f'.repeat(64), status: 'submitted', custody: 'managed' }));
  });
  await page.goto('/personal/send');
  const panel = page.getByRole('region', { name: 'QIE wallet' });
  const recipient = panel.getByLabel('Recipient');
  await recipient.fill('@nobody_here');
  await expect(panel.getByRole('alert')).toContainText("@nobody_here can't receive by username yet.");
  await recipient.fill('@Ada_Okafor');
  await expect(panel.getByRole('status').filter({ hasText: 'Paying' })).toContainText('Ada O. (@ada_okafor)');
  expect(lookups).toContain('ada_okafor');
  await panel.getByLabel('Amount').fill('2');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByRole('form', { name: 'Review payment' })).toContainText('Ada O. (@ada_okafor)');
  await panel.getByLabel('Password').fill('my-account-password');
  await panel.getByRole('button', { name: /Confirm and send/ }).click();
  await expect(panel.getByRole('heading', { name: 'Sent' })).toBeVisible();
  await expect(panel).toContainText('2 QIE to @ada_okafor');
  expect(posts).toEqual([{ to: payeeAddress, amount_atomic: '2000000000000000000', password: 'my-account-password', recipient_username: 'ada_okafor' }]);
});

test('being payable by username is an explicit opt-in on the Security page', async ({ page }) => {
  await signedIn(page);
  let state = { username: 'tobi_mock', payable_by_username: false, receiving_address: null as string | null };
  const posts: unknown[] = [];
  await page.route('**/personal/api/payment-settings', (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON());
      expect(route.request().headers()['x-kora-csrf']).toBe(csrf);
      state = { ...state, payable_by_username: true, receiving_address: payeeAddress };
    }
    return route.fulfill(json(state));
  });
  await page.goto('/personal/security');
  const panel = page.getByRole('region', { name: 'Payments by username' });
  await expect(panel).toContainText('@tobi_mock');
  const toggle = panel.getByRole('checkbox');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(panel).toContainText(`Payments go to ${payeeAddress.slice(0, 8)}`);
  expect(posts).toEqual([{ payable_by_username: true }]);
});

test('home leads with paying people: recent payees come from real sends and prefill the send form', async ({ page }) => {
  const now = new Date().toISOString();
  const sent = (id: string, to_username: string | null, status = 'confirmed') => ({
    id: 'stl_' + id.repeat(32), direction: 'sent', status, from: accountAddress, to: payeeAddress, to_username,
    amount_atomic: '1500000000000000000', asset: 'QIEV3', decimals: 18, network: 'qie-mainnet',
    created_at: now, tx_hash: null, explorer_url: null,
  });
  await signedIn(page);
  await page.route('**/personal/api/overview', (route) => route.fulfill(json({
    ...overview,
    wallet_value_usd: { amount_usd: '12.50', checked_at: now },
    activity: [sent('a', 'ada_okafor'), sent('b', 'ada_okafor'), sent('c', null), sent('d', 'kemi_b', 'failed')],
  })));
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({ data: [], managed_transfers: null })));
  await page.route('**/personal/api/recipients/*', (route) =>
    route.fulfill(json({ username: 'ada_okafor', display_name: 'Ada O.', address: payeeAddress, network: 'qie-mainnet', asset: 'QIEV3' })));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/personal/home');
  const card = page.getByRole('region', { name: 'Pay anyone on Roots' });
  await expect(card).toBeVisible();
  // One entry per username; failed sends and address-only sends add nobody.
  await expect(page.getByRole('list', { name: 'People you paid recently' }).getByRole('listitem')).toHaveCount(1);
  const feed = page.getByRole('region', { name: 'Activity' });
  await expect(feed.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(feed).toContainText('To @ada_okafor');
  await expect(feed).toContainText('−1.5');
  await expect(page.getByRole('region', { name: 'Your wallet overview' })).toContainText('$12.50');
  await page.screenshot({ path: '/tmp/roots-home-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Pay @ada_okafor again' }).click();
  await expect(page).toHaveURL(/\/personal\/send\?to=%40ada_okafor$/);
  await page.goto('/personal/home');
  await card.getByLabel('Pay a Roots @username or QIE address').fill('not a name!');
  await card.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(page).toHaveURL(/\/personal\/send$/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/personal/home');
  await expect(card).toBeVisible();
  await page.screenshot({ path: '/tmp/roots-home-desktop.png', fullPage: true });
});
