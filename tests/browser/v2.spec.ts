import { test, expect, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

test('landing presents Roots Personal and routes prompts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Money for');
  await expect(
    page.locator('.public-header').getByRole('img', { name: 'Roots', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveCount(0);
  await expect(page.locator('.lp-photo img')).toBeVisible();
  await page.locator('.lp-hero-actions').getByRole('button', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeEnabled();
  await expect(page.getByLabel('Password', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page).toHaveTitle('Sign in | Roots');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveCount(0);
  await expect(page.locator('.fin-auth-art')).toBeVisible();
  await page.goto('/business');
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.goto('/app/overview');
  await expect(page).toHaveURL(/\/personal\/login$/);
  for (const legacy of ['/sandbox', '/docs', '/ramp', '/connect', '/login']) {
    await page.goto(legacy);
    await expect(page).toHaveURL(/\/personal\/login$/);
  }
});

test('landing product tour, FAQs and mobile navigation work', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Roots | Money for the life you’re building.');
  await page.getByRole('tab', { name: 'Exchange', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Know what you’ll get.');
  await page.getByRole('tab', { name: 'Exchange', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Withdraw', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('From your screen to real life.');
  await page.getByText('What can I do on Roots today?', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText('native QIEV3 on QIE Mainnet');
  await expect(page.locator('#availability')).toContainText('Personal account & profile');
  await page.screenshot({ path: '/tmp/roots-landing-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'FAQs' })
    .click();
  await expect(page).toHaveURL(/#questions$/);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/roots-landing-phone.png', fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      String(width),
    ).toBeLessThanOrEqual(1);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.lp-floating')).toHaveCSS('animation-name', 'none');
});

test('phone pages fit without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/personal/login', '/business', '/app/overview']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

test('Personal sign-in keeps the form ahead of the photo on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/personal/login');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.fin-auth-form')).toBeVisible();
  await expect(page.locator('.fin-auth-story')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Talk to us' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to home' }).click();
  await expect(page).toHaveURL('/');
});

test('default theme uses a cream canvas across Roots Personal pages', async ({ page }) => {
  for (const [path, surface] of [
    ['/', '.ms-site'],
    ['/personal/login', '.fin-auth'],
  ]) {
    await page.goto(path);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 243, 233)');
    await expect(page.locator(surface)).toHaveCSS('background-color', 'rgb(247, 243, 233)');
  }
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Money for the life you’re building.' }),
  ).toBeVisible();
  await expect(page.locator('.lp-hero-actions .lp-button')).toHaveCSS(
    'background-color',
    'rgb(32, 55, 73)',
  );
  await page.evaluate(() => localStorage.setItem('roots-theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Business and developer links are absent from the public journey', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'For business' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open developer sandbox' })).toHaveCount(0);
  await expect(page.locator('form[name="business-call"]')).toHaveCount(0);
});

test('custom registration, optional identity, profile editing and mobile money navigation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const unique = Date.now().toString(36);
  const email = `browser_${unique}@example.test`,
    password = 'browser-only-strong-password';
  await page.goto('/personal/login');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('First name').fill('Ada');
  await page.getByLabel('Last name').fill('Okafor');
  await page.getByLabel('Username', { exact: true }).fill(`ada_${unique}`);
  await page.getByLabel('Phone number').fill('+2348000000000');
  await page.getByLabel('Date of birth').fill('1995-05-12');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Street address').fill('14 Example Street');
  await page.getByLabel('City', { exact: true }).fill('Lagos');
  await page.getByLabel('State / region').fill('Lagos');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re in, Ada.' })).toBeVisible();
  await page.getByRole('button', { name: 'Do this later' }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Ada$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your wallet overview' })).toContainText(`@ada_${unique}`);
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
  await expect(page.locator('.fin-asset-row')).toHaveCount(3);
  await expect(page.locator('.fin-asset-row')).toContainText(['QIE', 'QUSDC', 'NGN']);
  const olderOverview = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.assets;
    await route.fulfill({ response, body: JSON.stringify(body) });
  };
  await page.route('**/personal/api/overview', olderOverview);
  await page.reload();
  await expect(page.locator('.fin-asset-row')).toContainText(['QIE', 'QUSDC', 'NGN']);
  await page.unroute('**/personal/api/overview', olderOverview);
  const fundedOverview = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.assets = [
      { code: 'QIE', name: 'QIE', amount_atomic: '1250000000000000000', decimals: 18, status: 'ready', source: 'wallet' },
      { code: 'QUSDC', name: 'Digital dollars', amount_atomic: '2500000', decimals: 6, status: 'ready', source: 'wallet' },
      { code: 'NGN', name: 'Nigerian naira', amount_atomic: null, decimals: 2, status: 'unavailable', source: 'fiat' },
    ];
    body.wallet_value_usd = { amount_usd: '2.73', checked_at: '2026-10-21T10:00:00.000Z' };
    await route.fulfill({ response, body: JSON.stringify(body) });
  };
  await page.route('**/personal/api/overview', fundedOverview);
  await page.reload();
  await expect(page.locator('.fin-wallet-amount strong')).toHaveText('$2.73');
  await expect(page.getByRole('region', { name: 'Your wallet overview' })).not.toContainText('QIE');
  await expect(page.getByRole('region', { name: 'Your wallet overview' })).not.toContainText('QUSDC');
  await expect(page.locator('.fin-asset-row').first()).toContainText('1.25');
  await expect(page.locator('.fin-asset-row').nth(1)).toContainText('2.5');
  await expect(page.locator('.fin-asset-row').nth(2)).toContainText('Unavailable');
  expect(await page.locator('.fin-asset-icon img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.getByRole('button', { name: 'View QIE details' }).click();
  await expect(page).toHaveURL(/\/personal\/assets\/qie$/);
  await expect(page.getByRole('region', { name: 'QIE details' })).toContainText('1.25 QIE');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Receive QIE' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'QIE activity' })).toBeVisible();
  await page.screenshot({ path: '/tmp/roots-asset-qie-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'All assets' }).click();
  await page.getByRole('button', { name: 'View QUSDC details' }).click();
  await expect(page.getByRole('region', { name: 'QUSDC details' })).toContainText('2.5 QUSDC');
  await expect(page.getByRole('link', { name: 'View token contract' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send QIE' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All assets' }).click();
  await page.getByRole('button', { name: 'View NGN details' }).click();
  await expect(page.getByRole('region', { name: 'NGN details' })).toContainText('Unavailable');
  await page.getByRole('button', { name: 'All assets' }).click();
  await page.unroute('**/personal/api/overview', fundedOverview);
  await expect(page.getByRole('button', { name: 'Explore deposit' })).toHaveCount(0);
  await expect(page.getByText('Make your account yours')).toHaveCount(0);
  await expect(page.getByText('Money that goes')).toHaveCount(0);
  await expect(page.getByText('From digital to')).toHaveCount(0);
  await expect(page.getByText('sandbox', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'QIE wallet' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/roots-dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('.fin-app')).toHaveCSS('background-color', 'rgb(9, 9, 9)');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.getByRole('button', { name: 'Hide balance' }).click();
  await expect(page.getByRole('button', { name: 'Show balance' })).toBeVisible();
  await page.getByRole('button', { name: 'Open your profile' }).click();
  await expect(page.getByLabel('Date of birth')).toHaveValue('1995-05-12');
  await page.getByLabel('First name').fill('Amara');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('First name')).toHaveValue('Amara');
  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Amara$/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/roots-dashboard-phone.png', fullPage: true });
  for (const path of [
    'home',
    'assets/qie',
    'assets/qusdc',
    'assets/ngn',
    'payments',
    'deposit',
    'withdraw',
    'send',
    'convert',
    'activity',
    'profile',
    'identity',
    'security',
  ]) {
    await page.goto('/personal/' + path);
    await expect(page.locator('h1')).toBeVisible();
    if (path === 'assets/qie') await page.screenshot({ path: '/tmp/roots-asset-qie-phone.png', fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      path,
    ).toBeLessThanOrEqual(1);
  }
  await page.goto('/personal/convert');
  await expect(page.getByText('First, make it official.')).toHaveCount(0);
  await expect(page.getByLabel('You exchange', { exact: true })).toHaveCount(0);
  await expect(page.locator('.fin-method-detail')).toContainText('Not available');
  const wallet = privateKeyToAccount(generatePrivateKey());
  await page.route('**/personal/api/wallets', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      data: [{ id: 'wallet_browser_test', address: wallet.address, network: 'qie-mainnet', managed: true, label: 'Your wallet' }],
      provisioning_available: true,
    }),
  }));
  await page.route('**/personal/api/wallets/*/balance', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      balance_wei: '0', block_number: '100', asset: 'QIEV3',
      explorer_url: `https://mainnet.qie.digital/address/${wallet.address}`,
    }),
  }));
  await page.goto('/personal/deposit');
  // A managed (custodial) wallet cannot send yet, so it is never offered as a deposit address.
  await expect(page.getByRole('group', { name: 'Roots account wallet' })).toContainText('not open yet');
  await expect(page.getByRole('button', { name: 'Link QIE wallet' })).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code/ })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(wallet.address);
  expect(errors).toEqual([]);
});

// ---- Signed-in Personal flows with mocked API routes (independent of backend rollout) ----
const linkedAddress = privateKeyToAccount(generatePrivateKey()).address;
const managedAddress = privateKeyToAccount(generatePrivateKey()).address;
const recipient = privateKeyToAccount(generatePrivateKey()).address;
const csrf = 'csrf_browser_mock';
const profile = {
  email: 'mock@example.test', email_verified_at: null, phone_verified_at: null,
  first_name: 'Ada', last_name: 'Okafor', username: 'ada_mock', phone: '+2348000000000',
  residence_country: 'NG', nationality: null, date_of_birth: '1995-05-12',
  address_line1: '14 Example Street', address_line2: '', city: 'Lagos', region: 'Lagos',
  postal_code: '', occupation: '', display_currency: 'USD', profile_version: 1,
  identity_status: 'Not Started', identity_locked: false, has_password: true,
};
const overview = {
  balances: [], total: null,
  assets: [
    { code: 'QIE', name: 'QIE', amount_atomic: '1500000000000000000', decimals: 18, status: 'ready', source: 'wallet' },
    { code: 'QUSDC', name: 'Digital dollars', amount_atomic: null, decimals: 6, status: 'unavailable', source: 'wallet' },
    { code: 'NGN', name: 'Nigerian naira', amount_atomic: null, decimals: 2, status: 'unavailable', source: 'fiat' },
  ],
  wallet_value_usd: { amount_usd: null, checked_at: null },
  activity: [{
    id: 'cst_browser_mock', status: 'confirmed', to: recipient, amount_atomic: '250000000000000000',
    asset: 'QIEV3', decimals: null, network: 'qie-mainnet', created_at: '2026-10-20T10:00:00.000Z',
    tx_hash: null, explorer_url: null, confirmations: 12, required_confirmations: 12,
  }],
  capabilities: {
    fiat_deposit: { available: false, reason: 'Bank deposits are not available yet.' },
    crypto_deposit: { available: false, reason: 'Your deposit account is not available yet.' },
    withdrawal: { available: false, reason: 'Bank withdrawals are not available yet.' },
    transfer: { available: false, reason: 'Transfers from your Roots balance are not available yet.' },
    conversion: { available: false, reason: 'No exchange route is available for these currencies yet.' },
  },
};
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const expired = json({ error: { type: 'authentication_error', code: 'personal_login_required', message: 'Sign in to your Personal account' } }, 401);
async function signedIn(page: Page) {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/personal/api/')) calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route('**/personal/api/session', (route) => route.fulfill(json({ authenticated: true, csrf_token: csrf, email: profile.email })));
  await page.route('**/personal/api/profile', (route) => route.fulfill(json(profile)));
  await page.route('**/personal/api/overview', (route) => route.fulfill(json(overview)));
  await page.route('**/personal/api/kyc', (route) => route.fulfill(json({ email_verified: false, status: 'Not Started', url: null, updated_at: null, configured: false })));
  await page.route('**/personal/api/wallets/*/balance', (route) => route.fulfill(json({
    balance_wei: '1500000000000000000', block_number: '100', asset: 'QIEV3',
    explorer_url: `https://mainnet.qie.digital/address/${linkedAddress}`,
  })));
  return calls;
}
const managedRecord = { id: 'privy_wallet_mock', address: managedAddress, network: 'qie-mainnet', label: 'Your wallet', managed: true, custody: 'managed' };
const linkedRecord = { id: 'cwa_' + 'a'.repeat(32), address: linkedAddress, network: 'qie-mainnet', label: 'QIE wallet', managed: false };

test('Personal activity labels sends from data and the landing uses the Personal session', async ({ page }) => {
  const calls = await signedIn(page);
  await page.goto('/personal/activity');
  await expect(page.locator('.fin-transaction').first()).toContainText('Sent QIE');
  await expect(page.locator('.fin-transaction').first()).not.toContainText('Wallet transfer');
  await page.locator('.fin-transaction').first().click();
  await expect(page.locator('.fin-receipt')).toContainText('250000000000000000 base units of QIE');
  await page.goto('/personal/home');
  await expect(page.getByRole('button', { name: 'View QIE details, QIE, balance 1.5 QIE' })).toBeVisible();
  await page.getByRole('button', { name: /View QIE details/ }).click();
  await expect(page.getByRole('region', { name: 'QIE activity' })).toContainText('Sent QIE');
  await expect(page.getByRole('region', { name: 'QIE activity' })).toContainText('0.25');
  await page.goto('/');
  await expect(page.locator('.lp-signin')).toContainText('My account');
  expect(calls).toContain('GET /personal/api/session');
  expect(calls.some((call) => call.includes('/console/'))).toBe(false);
});

test('managed account wallet never shows a receive address or QR, and can be checked', async ({ page }) => {
  await signedIn(page);
  let managedCreated = false;
  const managedBodies: unknown[] = [];
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({ data: managedCreated ? [managedRecord] : [] })));
  await page.route('**/personal/api/wallets/managed', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-kora-csrf']).toBe(csrf);
    managedBodies.push(route.request().postDataJSON());
    managedCreated = true;
    return route.fulfill(json({ id: managedRecord.id, address: managedAddress, network: 'qie-mainnet', custody: 'managed' }));
  });
  await page.goto('/personal/deposit');
  const account = page.getByRole('group', { name: 'Roots account wallet' });
  await expect(account).toContainText("isn't set up yet");
  await account.getByRole('button', { name: 'Check wallet' }).click();
  await expect(account).toContainText("Roots manages this wallet's signing key");
  expect(managedBodies).toEqual([{}]);
  await expect(page.getByRole('img', { name: /QR code/ })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(managedAddress);
  await expect(page.locator('body')).not.toContainText(managedAddress.toLowerCase());
  await page.goto('/personal/send');
  await expect(page.getByLabel('Recipient', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Link QIE wallet' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(managedAddress);
});

test('links a self-custody wallet by signature, receives to it, and unlinks it', async ({ page }) => {
  await signedIn(page);
  await page.addInitScript(({ address }) => {
    const calls: string[] = [];
    (window as unknown as { ethereumCalls: string[] }).ethereumCalls = calls;
    (window as unknown as { ethereum: unknown }).ethereum = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        calls.push(method);
        if (method === 'eth_chainId') return '0x7c6';
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'personal_sign') {
          if (!String(params?.[0]).startsWith('Link this QIE wallet')) throw new Error('unexpected message');
          return '0x' + 'ab'.repeat(65);
        }
        throw new Error('unsupported ' + method);
      },
    };
  }, { address: linkedAddress });
  let linked = false;
  const posted: unknown[] = [];
  await page.route('**/personal/api/wallets', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['x-kora-csrf']).toBe(csrf);
      posted.push(route.request().postDataJSON());
      linked = true;
      return route.fulfill(json({ id: linkedRecord.id, address: linkedAddress, network: 'qie-mainnet' }));
    }
    return route.fulfill(json({ data: linked ? [managedRecord, linkedRecord] : [managedRecord] }));
  });
  await page.route('**/personal/api/wallets/challenge', (route) => {
    expect(route.request().postDataJSON()).toEqual({ address: linkedAddress });
    return route.fulfill(json({ challenge_id: 'cwc_' + 'b'.repeat(32), message: 'Link this QIE wallet to your Roots account', expires_at: '2026-10-21T10:05:00.000Z' }));
  });
  let deleted = '';
  await page.route('**/personal/api/wallets/cwa_*', (route) => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-kora-csrf']).toBe(csrf);
    deleted = new URL(route.request().url()).pathname;
    linked = false;
    return route.fulfill(json({ removed: true }));
  });
  await page.goto('/personal/deposit');
  await page.getByRole('button', { name: 'Link QIE wallet' }).click();
  await expect(page.getByText('QIE wallet linked to your account.')).toBeVisible();
  expect(posted).toEqual([{ challenge_id: 'cwc_' + 'b'.repeat(32), signature: '0x' + 'ab'.repeat(65) }]);
  expect(await page.evaluate(() => (window as unknown as { ethereumCalls: string[] }).ethereumCalls)).toContain('personal_sign');
  await expect(page.getByRole('img', { name: 'QR code for the QIE wallet address shown below' })).toBeVisible();
  await expect(page.locator('.fin-chain-receive code')).toHaveText(linkedAddress);
  await expect(page.locator('.fin-chain-receive')).not.toContainText('Roots manages');
  await expect(page.locator('body')).not.toContainText(managedAddress);
  await page.screenshot({ path: '/tmp/roots-linked-wallet-receive.png', fullPage: true });
  await page.goto('/personal/send');
  await expect(page.getByLabel('Recipient', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Unlink wallet' }).click();
  await page.getByRole('button', { name: 'Confirm unlink' }).click();
  await expect(page.getByRole('button', { name: 'Link QIE wallet' })).toBeVisible();
  expect(deleted).toBe(`/personal/api/wallets/${linkedRecord.id}`);
});

test('Convert shows unavailable without calling the quote API', async ({ page }) => {
  const calls = await signedIn(page);
  await page.goto('/personal/convert');
  await expect(page.locator('.fin-method-detail')).toContainText('No exchange route is available');
  await expect(page.locator('.fin-method-detail')).toContainText('Not available');
  await expect(page.getByRole('main')).not.toContainText(/exchange rate|fees/i);
  await expect(page.getByRole('button', { name: /exchange availability/ })).toHaveCount(0);
  expect(calls.filter((call) => call.includes('conversion'))).toEqual([]);
});

test('a 401 during the overview poll clears the dashboard and routes to sign-in', async ({ page }) => {
  await page.clock.install();
  await signedIn(page);
  await page.goto('/personal/home');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Ada$/ })).toBeVisible();
  await page.route('**/personal/api/overview', (route) => route.fulfill(expired));
  await page.clock.fastForward(16_000);
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText('Your session has ended. Sign in again to continue.')).toBeVisible();
  await expect(page.getByText(/Good (morning|afternoon|evening), Ada/)).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('sign out clears local state even when the server call fails', async ({ page }) => {
  await signedIn(page);
  let logoutCalls = 0;
  await page.route('**/personal/api/logout', (route) => {
    logoutCalls++;
    return route.fulfill(json({ error: { code: 'internal_error', message: 'The request could not be completed' } }, 500));
  });
  await page.goto('/personal/profile');
  await expect(page.getByLabel('First name')).toHaveValue('Ada');
  await page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText('You are signed out on this device.')).toBeVisible();
  await expect(page.getByLabel('First name')).toHaveCount(0);
  expect(logoutCalls).toBe(1);
});

test('recovery code screen offers resend and a different email with neutral copy', async ({ page }) => {
  const starts: unknown[] = [];
  await page.route('**/personal/api/registration/config', (route) => route.fulfill(json({ method: 'password', email_verification_available: true })));
  await page.route('**/personal/api/auth/start', (route) => {
    starts.push(route.request().postDataJSON());
    return route.fulfill(json({ challenge_id: 'otp_' + String(starts.length).repeat(32) }));
  });
  await page.route('**/personal/api/auth/verify', (route) => route.fulfill(json({ error: { code: 'invalid_code', message: 'Code is invalid or expired' } }, 401)));
  await page.goto('/personal/login');
  await page.getByRole('button', { name: 'Forgot password or upgrading an existing account?' }).click();
  await page.getByLabel('Email address').fill('nobody@example.test');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByRole('status')).toContainText('If nobody@example.test belongs to a Roots account');
  const codeInput = page.getByLabel('Verification code');
  await expect(codeInput).toHaveAttribute('pattern', '[0-9]{6}');
  await codeInput.fill('12ab34');
  await expect(codeInput).toHaveValue('1234');
  await codeInput.fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('alert')).toContainText('Recovery only works for an existing Roots account');
  await expect(page).toHaveURL(/\/personal\/login$/);
  await page.getByRole('button', { name: 'Resend code' }).click();
  await expect.poll(() => starts.length).toBe(2);
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByLabel('Email address')).toHaveValue('nobody@example.test');
  await expect(page.getByLabel('Verification code')).toHaveCount(0);
});

test('incoming wallet transfers show as received in activity, receipts and asset detail', async ({ page }) => {
  const sender = '0x' + '4'.repeat(40);
  const incoming = {
    id: 'rcv_browser_mock', direction: 'received', status: 'confirmed', from: sender, to: linkedAddress,
    amount_atomic: '2500000', asset: 'QUSDC', decimals: 6, network: 'qie-mainnet',
    created_at: '2026-10-21T10:00:00.000Z', tx_hash: '0x' + 'c'.repeat(64),
    explorer_url: 'https://mainnet.qie.digital/tx/0x' + 'c'.repeat(64),
  };
  await signedIn(page);
  await page.route('**/personal/api/overview', (route) => route.fulfill(json({ ...overview, activity: [incoming, ...overview.activity] })));
  await page.goto('/personal/activity');
  const row = page.locator('.fin-transaction').first();
  await expect(row).toContainText('Received QUSDC');
  await expect(row).toContainText('From 0x4444…4444');
  await expect(row.locator('.fin-tx-icon-in')).toBeVisible();
  await row.click();
  await expect(page.locator('.fin-receipt')).toContainText('2.50 QUSDC');
  await expect(page.locator('.fin-receipt')).toContainText(sender);
  await expect(page.locator('.fin-receipt')).not.toContainText('Confirmations');
  await page.goto('/personal/assets/qusdc');
  await expect(page.getByRole('region', { name: 'QUSDC activity' })).toContainText('Received QUSDC');
  await expect(page.getByRole('region', { name: 'QUSDC activity' })).toContainText('+');
});

test('when account wallet sends are enabled it can receive and send with the password', async ({ page }) => {
  await signedIn(page);
  const limits = { per_transfer_wei: '1000000000000000000000', daily_wei: '5000000000000000000000', requires_identity_verification: true };
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({ data: [{ ...managedRecord, can_send: true }], managed_transfers: limits })));
  const posts: { body: Record<string, string>; key: string | undefined }[] = [];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    posts.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    return route.fulfill(json({ id: 'stl_' + 'b'.repeat(32), tx_hash: '0x' + 'd'.repeat(64), status: 'submitted', custody: 'managed' }));
  });
  await page.goto('/personal/deposit');
  const panel = page.getByRole('group', { name: 'Roots account wallet' });
  await expect(panel.locator('code')).toHaveText(managedAddress);
  await expect(panel.getByAltText(/QR code for your account wallet/)).toBeVisible();
  await page.goto('/personal/send');
  const send = page.getByRole('region', { name: 'QIE wallet' });
  // The password belongs to the review step, not the form.
  await expect(send.getByLabel('Password')).toHaveCount(0);
  await send.getByLabel('Recipient', { exact: true }).fill(recipient);
  await send.getByLabel('Amount').fill('1.5');
  await send.getByRole('button', { name: 'Continue' }).click();
  const review = page.getByRole('form', { name: 'Review payment' });
  await expect(review).toContainText('1.5');
  await review.getByLabel('Password').fill('my-account-password');
  await review.getByRole('button', { name: /Confirm and send/ }).click();
  await expect(send.getByRole('heading', { name: 'Sent' })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ to: recipient, amount_atomic: '1500000000000000000', password: 'my-account-password' });
  expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/);
});
