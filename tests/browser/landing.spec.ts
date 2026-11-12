import { test, expect } from '@playwright/test';

const sections = [
  ['Product', 'product', 'One account for everyday digital money.'],
  ['How it works', 'how-it-works', 'Up and running in three steps.'],
  ['Security', 'security', 'You stay in control of your money.'],
  ['FAQs', 'questions', 'Questions, answered.'],
] as const;

test('landing hero has one h1; Get started opens sign-up and Sign in opens sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Money for the life you’re building.');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('Microsendr is not a bank.');
  await expect(page.getByRole('figure', { name: 'Illustrative preview of the Microsendr app' })).toContainText(
    'Illustrative preview',
  );
  await page.locator('.lp-hero-actions').getByRole('button', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/personal\/register$/);
  await expect(page.getByRole('heading', { name: 'Make your next move.' })).toBeVisible();
  await page.goto('/');
  await page.locator('.lp-header-actions').getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
});

test('landing shows My account when a Personal session exists', async ({ page }) => {
  await page.route('**/personal/api/session', (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.goto('/');
  await expect(page.locator('.lp-signin')).toHaveText('My account');
  await expect(page.locator('.lp-hero-actions').getByRole('button', { name: 'Open your account' })).toBeVisible();
  await expect(page.locator('.lp-header-cta')).toHaveCount(0);
});

test('main navigation anchors scroll to their sections and the header condenses', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('.lp-header');
  await expect(header).not.toHaveClass(/is-condensed/);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  for (const [label, id, heading] of sections) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(page.locator(`#${id}`).getByRole('heading', { name: heading })).toBeInViewport();
  }
  await expect(header).toHaveClass(/is-condensed/);
  // The fixed header must not cover the section heading after a jump.
  const headerBottom = await header.evaluate((node) => node.getBoundingClientRect().bottom);
  const headingTop = await page
    .getByRole('heading', { name: 'Questions, answered.' })
    .evaluate((node) => node.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
});

test('mobile menu opens, moves focus, and closes with Escape or a link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();

  await toggle.click();
  const close = page.getByRole('button', { name: 'Close navigation' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Product' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await nav.getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/#security$/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('heading', { name: 'You stay in control of your money.' })).toBeInViewport();
});

test('landing has no horizontal overflow at common widths', async ({ page }) => {
  await page.goto('/');
  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `width ${width}`).toBeLessThanOrEqual(0);
  }
});

test('planned features are clearly labelled Coming soon', async ({ page }) => {
  await page.goto('/');
  const table = page.locator('#availability table');
  for (const feature of [
    'Bank deposits & withdrawals',
    'Buy digital dollars with naira',
    'P2P trading marketplace',
  ])
    await expect(table.getByRole('row', { name: new RegExp(feature) })).toContainText('Coming soon');
  for (const feature of [
    'Personal account & profile',
    'Microsendr account wallet',
    'Send and receive QIE and QUSDC',
    'Pay Microsendr users by @username',
  ])
    await expect(table.getByRole('row', { name: new RegExp(feature) })).toContainText('Available');

  for (const tab of ['Exchange', 'Withdraw']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Coming soon');
  }
  for (const tab of ['Send', 'Receive']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Available');
  }
});

test('reduced motion disables animation, reveal and smooth scrolling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.lp-site')).not.toHaveClass(/lp-motion/);
  await expect(page.locator('.lp-floating')).toHaveCSS('animation-name', 'none');
  const animated = await page
    .locator('.lp-float-card, .lp-hero-visual, .lp-kicker-dot')
    .evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) =>
            getComputedStyle(node).animationName !== 'none' ||
            getComputedStyle(node, '::after').animationName !== 'none',
        ).length,
    );
  expect(animated).toBe(0);
  const hidden = await page
    .locator('[data-reveal]')
    .evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).opacity !== '1').length);
  expect(hidden).toBe(0);
  await expect(page.locator('.lp-button').first()).toHaveCSS('transition-duration', '0s');

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'FAQs' }).click();
  // An instant jump: the section is in place on the very next check, without waiting.
  const top = await page.locator('#questions').evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(top)).toBeLessThan(200);

  // With motion allowed, reveal-on-scroll is active.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.lp-site')).toHaveClass(/lp-motion/);
});

test('Microsendr can be installed on a phone home screen', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'Microsendr', display: 'standalone', start_url: '/personal/home' });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
});
