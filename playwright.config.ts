import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use a preinstalled Chromium when the Playwright-managed build is not present (e.g. sandboxed dev containers).
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--no-sandbox'], ...(executablePath ? { executablePath } : {}) },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'exec node --import tsx scripts/browser-server.ts',
    url: 'http://127.0.0.1:4310/health',
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
