import { test, expect } from '@playwright/test';

test('landing presents Microsendr Personal and routes prompts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Money moves');
  await expect(page.locator('.public-header .logo')).toHaveText('microsendr');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveCount(0);
  await expect(page.locator('.ms-hero-visual img')).toBeVisible();
  await page.locator('.ms-hero-actions').getByRole('button', { name: 'Get started' }).click();
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Personal.' })).toBeVisible();
  await expect(page.getByText('Sign-in is being set up. Please check back soon.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue with email' })).toBeDisabled();
  await expect(page).toHaveTitle('Sign in to Personal | Microsendr');
  await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toHaveCount(0);
  await expect(page.locator('.ms-personal-login-visual img')).toBeVisible();
  await page.goto('/business');
  await expect(page).toHaveURL(/\/personal\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Personal.' })).toBeVisible();
  await page.goto('/app/overview');
  await expect(page).toHaveURL(/\/personal\/login$/);
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
  await expect(page.getByRole('heading', { name: 'Sign in to Personal.' })).toBeVisible();
  const form = await page.locator('.ms-personal-login-panel').boundingBox();
  const photo = await page.locator('.ms-personal-login-visual').boundingBox();
  expect(form).not.toBeNull();
  expect(photo).not.toBeNull();
  expect(form!.y).toBeLessThan(photo!.y);
  await expect(page.getByRole('button', { name: 'Talk to us' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to home' }).click();
  await expect(page).toHaveURL('/');
});

test('default theme uses a cream canvas across Microsendr Personal pages', async ({ page }) => {
  for (const [path, surface] of [['/', '.ms-site'], ['/personal/login', '.personal-auth']]) {
    await page.goto(path);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 243, 233)');
    await expect(page.locator(surface)).toHaveCSS('background-color', 'rgb(247, 243, 233)');
  }
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Money moves with you.' })).toBeVisible();
  await expect(page.locator('.ms-button').first()).toHaveCSS('background-color', 'rgb(70, 130, 180)');
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
