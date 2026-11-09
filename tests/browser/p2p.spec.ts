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
  const panel = page.getByRole('group', { name: 'Roots account wallet' });
  const recipient = panel.getByLabel('Recipient');
  await recipient.fill('@nobody_here');
  await expect(panel.getByRole('alert')).toContainText('No Roots user can be paid at that username');
  await recipient.fill('@Ada_Okafor');
  await expect(panel.getByRole('status').filter({ hasText: 'Paying' })).toContainText('Ada O. (@ada_okafor)');
  expect(lookups).toContain('ada_okafor');
  await panel.getByLabel('Amount in QIEV3').fill('2');
  await panel.getByLabel('Password').fill('my-account-password');
  await panel.getByRole('button', { name: /Confirm and send/ }).click();
  await expect(panel).toContainText('Broadcast to QIE Mainnet');
  expect(posts).toEqual([{ to: payeeAddress, amount_atomic: '2000000000000000000', password: 'my-account-password' }]);
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
