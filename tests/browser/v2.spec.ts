import { test, expect } from '@playwright/test';

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
  await expect(page.locator('details[open]')).toContainText('not yet enabled');
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
  await expect(page.getByText('sandbox', { exact: false })).toHaveCount(0);
  await expect(page.getByText('QIE', { exact: false })).toHaveCount(0);
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
  await page.getByLabel('You exchange', { exact: true }).fill('100.00');
  await page.getByRole('button', { name: 'Check exchange availability' }).click();
  await expect(page.getByRole('alert')).toContainText('No funds have been moved');
  await page.getByRole('button', { name: 'Reverse conversion' }).click();
  await expect(page.getByLabel('Source currency')).toHaveValue('NGN');
  await page.getByRole('button', { name: 'Check exchange availability' }).click();
  await expect(page.getByRole('alert')).toContainText('No funds have been moved');
  await page.goto('/personal/deposit');
  await page.getByRole('button', { name: 'Crypto transfer', exact: true }).click();
  await expect(
    page.getByText('Do not send funds until an address and supported network are displayed.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
