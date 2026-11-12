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
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pin_set: false, pin_locked_until: null, passkeys: [] }) }));
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
      : route.fulfill(json({ error: { code: 'recipient_unavailable', message: 'No Microsendr user can be paid at that username' } }, 404));
  });
  const posts: Record<string, string>[] = [];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill(json({ id: 'stl_' + 'e'.repeat(32), tx_hash: '0x' + 'f'.repeat(64), status: 'submitted', custody: 'managed' }));
  });
  await page.goto('/personal/send/address/qie');
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
  expect(posts).toEqual([{ to: payeeAddress, amount_atomic: '2000000000000000000', asset: 'QIE', password: 'my-account-password', recipient_username: 'ada_okafor' }]);
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
  await expect(panel).toContainText(`to ${payeeAddress.slice(0, 6)}…${payeeAddress.slice(-4)}`);
  expect(posts).toEqual([{ payable_by_username: true }]);
});

test('home is the balance card, shortcuts and activity; recent payees wait on the Microsendr user send page', async ({ page }) => {
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
  await expect(page.getByRole('region', { name: 'Your wallet overview' })).toContainText('$12.50');
  await expect(page.getByRole('group', { name: 'Money actions' }).getByRole('button')).toHaveText(['Add money', 'Send']);
  await expect(page.getByRole('navigation', { name: 'Shortcuts' }).getByRole('button')).toHaveText(['Receive', 'Convert', 'Assets', 'Withdraw']);
  const feed = page.getByRole('region', { name: 'Activity' });
  await expect(feed.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(feed).toContainText('To @ada_okafor');
  await expect(feed).toContainText('−1.5');
  await page.screenshot({ path: '/tmp/microsendr-home-phone.png', fullPage: true });
  // Send → Microsendr user lists people paid before; one entry per username, failed and address-only sends add nobody.
  await page.getByRole('group', { name: 'Money actions' }).getByRole('button', { name: 'Send' }).click();
  await expect(page).toHaveURL(/\/personal\/send$/);
  await page.getByRole('listitem').filter({ hasText: 'Microsendr user' }).click();
  await expect(page).toHaveURL(/\/personal\/send\/user$/);
  // The token is chosen from a list, not a toggle.
  await expect(page.getByRole('list', { name: 'Choose a token' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('list', { name: 'Choose a token' }).getByRole('listitem').filter({ hasText: 'QUSDC' }).click();
  await expect(page).toHaveURL(/\/personal\/send\/user\/qusdc$/);
  await expect(page.getByRole('heading', { name: 'Send QUSDC' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'People you paid recently' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Pay @ada_okafor again' }).click();
  await expect(page).toHaveURL(/\/personal\/send\/user\/qusdc\?to=%40ada_okafor$/);
  // Bank sends are shown as coming soon and cannot be opened.
  await page.goto('/personal/send');
  await expect(page.getByRole('listitem').filter({ hasText: 'Bank account' })).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/personal/home');
  await page.screenshot({ path: '/tmp/microsendr-home-desktop.png', fullPage: true });
});

test('with a payment PIN set, the review step asks for the PIN instead of the password', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill(json({ pin_set: true, pin_locked_until: null, passkeys: [] })));
  const limits = { per_transfer_wei: '1000000000000000000000', daily_wei: '5000000000000000000000', requires_identity_verification: false };
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({
    data: [{ id: 'privy_wallet_mock', address: accountAddress, network: 'qie-mainnet', managed: true, custody: 'managed', can_send: true }],
    managed_transfers: limits,
  })));
  const posts: Record<string, unknown>[] = [];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill(json({ id: 'stl_' + 'e'.repeat(32), tx_hash: '0x' + 'f'.repeat(64), status: 'submitted', custody: 'managed' }));
  });
  await page.goto('/personal/send/address/qie');
  const panel = page.getByRole('region', { name: 'QIE wallet' });
  await panel.getByLabel('Recipient').fill(payeeAddress);
  await panel.getByLabel('Amount').fill('3');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByLabel('Password')).toHaveCount(0);
  const pin = panel.getByLabel('Payment PIN');
  await pin.fill('402913');
  await expect(pin).toHaveValue('402913');
  await panel.getByRole('button', { name: /Confirm and send/ }).click();
  await expect(panel.getByRole('heading', { name: 'Sent' })).toBeVisible();
  expect(posts).toEqual([{ to: payeeAddress, amount_atomic: '3000000000000000000', asset: 'QIE', pin: '402913' }]);
});

test('Security sets a payment PIN with the password', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/payment-settings', (route) => route.fulfill(json({ username: 'tobi_mock', payable_by_username: false, receiving_address: null })));
  let pinSet = false;
  const bodies: unknown[] = [];
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill(json({ pin_set: pinSet, pin_locked_until: null, passkeys: [] })));
  await page.route('**/personal/api/payment-auth/pin', (route) => {
    bodies.push(route.request().postDataJSON());
    pinSet = true;
    return route.fulfill(json({ pin_set: true }));
  });
  await page.goto('/personal/security');
  const section = page.getByRole('region', { name: 'Payment approval' });
  await expect(section).toContainText('Not set');
  await section.getByRole('button', { name: 'Set PIN' }).click();
  await section.getByLabel('New PIN').fill('402913');
  await section.getByLabel('Confirm PIN').fill('402914');
  await section.getByLabel('Password').fill('my-account-password');
  await section.getByRole('button', { name: 'Save PIN' }).click();
  await expect(section.getByRole('alert')).toContainText('The PINs do not match.');
  await section.getByLabel('Confirm PIN').fill('402913');
  await section.getByRole('button', { name: 'Save PIN' }).click();
  await expect(page.getByText('Payment PIN saved.')).toBeVisible();
  await expect(section).toContainText('On');
  expect(bodies).toEqual([{ pin: '402913', password: 'my-account-password' }]);
});

test('a new account sees a simple empty activity state', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/payment-settings', (route) => route.fulfill(json({ username: 'tobi_mock', payable_by_username: false, receiving_address: null })));
  await page.goto('/personal/home');
  const feed = page.getByRole('region', { name: 'Activity' });
  await expect(feed).toContainText('No transactions');
  await page.getByRole('navigation', { name: 'Shortcuts' }).getByRole('button', { name: 'Receive' }).click();
  await expect(page).toHaveURL(/\/personal\/deposit\/crypto$/);
  await expect(page.getByRole('list', { name: 'Choose a token' }).getByRole('listitem')).toHaveCount(2);
});

test('each token has its own receive screen, and QUSDC sends from the Microsendr wallet as QUSDC', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill(json({ pin_set: true, pin_locked_until: null, passkeys: [] })));
  await page.route('**/personal/api/overview', (route) => route.fulfill(json({ ...overview, assets: [
    { code: 'QIE', name: 'QIE', amount_atomic: '1000000000000000000', decimals: 18, status: 'ready', source: 'wallet' },
    { code: 'QUSDC', name: 'Digital dollars', amount_atomic: '5000000', decimals: 6, status: 'ready', source: 'wallet' }] })));
  const limits = { per_transfer_wei: '1000000000000000000000', daily_wei: '5000000000000000000000', qusdc_per_transfer_atomic: '1000000000', qusdc_daily_atomic: '5000000000', requires_identity_verification: false };
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({
    data: [{ id: 'privy_wallet_mock', address: accountAddress, network: 'qie-mainnet', managed: true, custody: 'managed', can_send: true }],
    managed_transfers: limits,
  })));
  const posts: Record<string, unknown>[] = [];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill(json({ id: 'stl_' + 'e'.repeat(32), tx_hash: '0x' + 'f'.repeat(64), status: 'submitted', custody: 'managed' }));
  });
  // From the QUSDC page, Receive opens the address screen on QUSDC.
  await page.goto('/personal/assets/qusdc');
  await page.getByRole('button', { name: 'Receive QUSDC' }).click();
  await expect(page.getByRole('heading', { name: 'Receive QUSDC' })).toBeVisible();
  await expect(page.getByText('Only send QUSDC on QIE Mainnet.')).toBeVisible();
  await expect(page.locator('.fin-chain-receive code')).toHaveText(accountAddress);
  await page.goto('/personal/deposit/crypto/qie');
  await expect(page.getByText('Only send QIE on QIE Mainnet.')).toBeVisible();
  await expect(page.locator('.fin-chain-receive code')).toHaveText(accountAddress);
  // Sending QUSDC uses six decimals and names the asset.
  await page.goto('/personal/assets/qusdc');
  await page.getByRole('button', { name: 'Send QUSDC' }).click();
  const panel = page.getByRole('region', { name: 'QIE wallet' });
  await panel.getByLabel('Recipient').fill(payeeAddress);
  await panel.getByLabel('Amount').fill('2.5');
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByRole('form', { name: 'Review payment' })).toContainText('2.5 QUSDC');
  await panel.getByLabel('Payment PIN').fill('402913');
  await panel.getByRole('button', { name: /Confirm and send/ }).click();
  await expect(panel).toContainText('2.5 QUSDC to');
  expect(posts).toEqual([{ to: payeeAddress, amount_atomic: '2500000', asset: 'QUSDC', pin: '402913' }]);
});

test('a failed or expired account-wallet send is never shown as sent, and a clear failure gets a fresh key', async ({ page }) => {
  await signedIn(page);
  await page.route('**/personal/api/payment-auth', (route) => route.fulfill(json({ pin_set: true, pin_locked_until: null, passkeys: [] })));
  const limits = { per_transfer_wei: '1000000000000000000000', daily_wei: '5000000000000000000000', requires_identity_verification: false };
  await page.route('**/personal/api/wallets', (route) => route.fulfill(json({
    data: [{ id: 'privy_wallet_mock', address: accountAddress, network: 'qie-mainnet', managed: true, custody: 'managed', can_send: true }],
    managed_transfers: limits,
  })));
  const keys: string[] = [];
  const replies = [
    { status: 503, body: { error: { code: 'transfer_unavailable', message: 'Your transfer could not be sent. Nothing was moved; try again.' } } },
    { status: 200, body: { id: 'stl_' + 'e'.repeat(32), tx_hash: null, status: 'expired', custody: 'managed' } },
    { status: 409, body: { error: { code: 'transfer_failed', message: 'That attempt did not go through and nothing was sent. Try again.' } } },
    { status: 200, body: { id: 'stl_' + 'f'.repeat(32), tx_hash: '0x' + 'f'.repeat(64), status: 'submitted', custody: 'managed' } },
  ];
  await page.route('**/personal/api/wallets/managed/transfers', (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const reply = replies.shift()!;
    return route.fulfill(json(reply.body, reply.status));
  });
  await page.goto('/personal/send/address/qie');
  const panel = page.getByRole('region', { name: 'QIE wallet' });
  await panel.getByLabel('Recipient').fill(payeeAddress);
  await panel.getByLabel('Amount').fill('1');
  await panel.getByRole('button', { name: 'Continue' }).click();
  const confirm = async () => {
    await panel.getByLabel('Payment PIN').fill('402913');
    await panel.getByRole('button', { name: /Confirm and send/ }).click();
  };
  await confirm();
  await expect(panel.getByRole('alert')).toContainText('Nothing was moved');
  await expect(panel.getByRole('heading', { name: 'Sent' })).toHaveCount(0);
  await confirm();
  await expect(panel.getByRole('alert')).toContainText('did not go through');
  await expect(panel.getByRole('heading', { name: 'Sent' })).toHaveCount(0);
  await confirm();
  await expect(panel.getByRole('alert')).toContainText('did not go through');
  await confirm();
  await expect(panel.getByRole('heading', { name: 'Sent' })).toBeVisible();
  // The unclear 503 kept its key; the expired record and the 409 each got a fresh one.
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
  expect(keys[3]).not.toBe(keys[2]);
});

test('if balances fail to load the rest of the app still works, with a retry', async ({ page }) => {
  await signedIn(page);
  let fail = true;
  await page.route('**/personal/api/overview', (route) => fail
    ? route.fulfill(json({ error: { code: 'qie_unavailable', message: 'QIE is temporarily unavailable.' } }, 503))
    : route.fulfill(json(overview)));
  await page.goto('/personal/home');
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Balances could not load');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/personal/profile');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
});
