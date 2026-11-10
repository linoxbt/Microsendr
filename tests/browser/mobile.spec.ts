import { test, expect, type Page } from '@playwright/test';

const csrf = 'c'.repeat(64);
const addr = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const profile = {
  email: 'ada@example.test', email_verified_at: '2026-10-01T00:00:00Z', phone_verified_at: null, first_name: 'Adaobi',
  last_name: 'Okafor', username: 'adaobi_okafor', phone: '+2348012345678', residence_country: 'NG', nationality: 'NG',
  date_of_birth: '1995-05-12', address_line1: '14 Example Street', address_line2: '', city: 'Lagos', region: 'Lagos',
  postal_code: '100001', occupation: 'Designer', display_currency: 'USD', profile_version: 1, identity_status: 'Approved',
  identity_locked: true, has_password: true,
};
const activity = [1, 2, 3, 4, 5, 6].map((i) => ({
  id: `rcv_${String(i).repeat(32)}`, direction: i % 2 ? 'received' : 'sent', status: 'confirmed', from: addr, to: addr,
  amount_atomic: '2500000', asset: 'QUSDC', decimals: 6, network: 'qie-mainnet', created_at: `2026-11-0${i}T10:00:00Z`,
  tx_hash: '0x' + 'a'.repeat(64), explorer_url: null, confirmations: 12, required_confirmations: 12,
}));
const overview = {
  balances: [], total: null, activity,
  assets: [{ code: 'QIE', name: 'QIE', amount_atomic: '123456789012345678901234', decimals: 18, status: 'ready', source: 'wallet' }],
  wallet_value_usd: { amount_usd: '1234567.89', checked_at: '2026-11-09T10:00:00Z' },
  capabilities: Object.fromEntries(['fiat_deposit', 'crypto_deposit', 'withdrawal', 'transfer', 'conversion'].map((k) => [k, { available: false, reason: 'Not available yet.' }])),
};
async function signedIn(page: Page) {
  await page.route('**/personal/api/session', (r) => r.fulfill(json({ authenticated: true, csrf_token: csrf, email: profile.email })));
  await page.route('**/personal/api/profile', (r) => r.fulfill(json(profile)));
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pin_set: false, pin_locked_until: null, passkeys: [] }) }));
  await page.route('**/personal/api/overview', (r) => r.fulfill(json(overview)));
  await page.route('**/personal/api/kyc', (r) => r.fulfill(json({ email_verified: true, status: 'Approved', url: null, updated_at: null, configured: true })));
  await page.route('**/personal/api/wallets', (r) => r.fulfill(json({ data: [] })));
  await page.route('**/personal/api/payment-settings', (r) => r.fulfill(json({ username: 'adaobi_okafor', payable_by_username: false, receiving_address: null })));
}

for (const width of [360, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
    for (const path of ['/personal/home', '/personal/activity', '/personal/send', '/personal/deposit', '/personal/profile', '/personal/security']) {
      test(`${path} fits the screen with comfortable tap targets`, async ({ page }) => {
        await signedIn(page);
        await page.goto(path);
        await expect(page.locator('.fin-app')).toBeVisible();
        const problems = await page.evaluate((w) => {
          const out: string[] = [];
          if (document.documentElement.scrollWidth > w + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide`);
          for (const el of document.querySelectorAll<HTMLElement>('main button, main a, header button, footer button')) {
            const r = el.getBoundingClientRect();
            if (r.width && r.height && r.height < 40 && getComputedStyle(el).position !== 'absolute')
              out.push(`"${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" is ${Math.round(r.height)}px tall`);
          }
          return out;
        }, width);
        expect(problems).toEqual([]);
      });
    }
  });
}

test('the wallet value stays on one line and an opened receipt scrolls into view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await signedIn(page);
  await page.goto('/personal/home');
  const value = page.locator('.fin-wallet-amount strong');
  await expect(value).toHaveText('$1,234,567.89');
  const box = await value.boundingBox();
  const lineHeight = parseFloat(await value.evaluate((el) => getComputedStyle(el).lineHeight));
  expect(box!.height).toBeLessThan(lineHeight * 1.5);
  await page.goto('/personal/activity');
  await page.locator('.fin-transaction').last().click();
  await expect(page.locator('.fin-receipt')).toBeInViewport();
  await expect(page.locator('.theme-toggle')).toHaveAccessibleName(/Switch to dark theme/);
});
