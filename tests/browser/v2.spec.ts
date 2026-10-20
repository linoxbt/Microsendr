import { test, expect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

test('landing presents Microsendr Personal and routes prompts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Money for');
  await expect(
    page.locator('.public-header').getByRole('img', { name: 'Microsendr', exact: true }),
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
  await expect(page).toHaveTitle('Sign in | Microsendr');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveCount(0);
  await expect(page.locator('.fin-auth-art')).toBeVisible();
  await page.goto('/business');
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await page.goto('/app/overview');
  await expect(page).toHaveURL(/\/personal\/login$/);
});

test('landing product tour, FAQs and mobile navigation work', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Microsendr | Money for the life you’re building.');
  await page.getByRole('tab', { name: 'Exchange', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Know what you’ll get.');
  await page.getByRole('tab', { name: 'Exchange', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Withdraw', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('From your screen to real life.');
  await page.getByText('What can I do on Microsendr today?', { exact: true }).click();
  await expect(page.locator('details[open]')).toContainText('native QIEV3 on QIE Mainnet');
  await expect(page.locator('#availability')).toContainText('Personal account & profile');
  await page.screenshot({ path: '/tmp/microsendr-landing-desktop.png', fullPage: true });
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
  await page.screenshot({ path: '/tmp/microsendr-landing-phone.png', fullPage: true });
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

test('default theme uses a cream canvas across Microsendr Personal pages', async ({ page }) => {
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
  await expect(page.locator('.lp-button').first()).toHaveCSS(
    'background-color',
    'rgb(70, 130, 180)',
  );
  await page.evaluate(() => localStorage.setItem('microsendr-theme', 'dark'));
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
  await expect(page.getByRole('heading', { name: 'Hello, Ada.' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'View QUSDC details' }).click();
  await expect(page.getByRole('region', { name: 'QUSDC details' })).toContainText('2.5 QUSDC');
  await expect(page.getByText('0x3F43…5DA5')).toBeVisible();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'View NGN details' }).click();
  await expect(page.getByRole('region', { name: 'NGN details' })).toContainText('Unavailable');
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.unroute('**/personal/api/overview', fundedOverview);
  await expect(page.getByRole('button', { name: 'Explore deposit' })).toHaveCount(0);
  await expect(page.getByText('Make your account yours')).toHaveCount(0);
  await expect(page.getByText('Money that goes')).toHaveCount(0);
  await expect(page.getByText('From digital to')).toHaveCount(0);
  await expect(page.getByText('sandbox', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'QIE wallet' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/microsendr-dashboard-desktop.png', fullPage: true });
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
  await expect(page.getByRole('heading', { name: 'Hello, Amara.' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/microsendr-dashboard-phone.png', fullPage: true });
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
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      path,
    ).toBeLessThanOrEqual(1);
  }
  await page.goto('/personal/convert');
  await expect(page.getByText('First, make it official.')).toHaveCount(0);
  await expect(page.getByText('You’re in control')).toHaveCount(0);
  await page.getByLabel('You exchange', { exact: true }).fill('100.00');
  await page.getByRole('button', { name: 'Check exchange availability' }).click();
  await expect(page.getByRole('alert')).toContainText('No funds have been moved');
  await page.getByRole('button', { name: 'Reverse conversion' }).click();
  await expect(page.getByLabel('Source currency')).toHaveValue('NGN');
  await page.getByRole('button', { name: 'Check exchange availability' }).click();
  await expect(page.getByRole('alert')).toContainText('No funds have been moved');
  await page.goto('/personal/deposit');
  await page.getByRole('button', { name: 'Crypto transfer', exact: true }).click();
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
  await page.reload();
  await page.getByRole('button', { name: 'Crypto transfer', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR code for the QIE wallet address shown below' })).toBeVisible();
  await expect(page.locator('.fin-chain-receive code')).toHaveText(wallet.address);
  expect(errors).toEqual([]);
});
