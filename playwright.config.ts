import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  testIgnore: [
    '**/product.spec.ts',
    '**/rail.spec.ts',
    '**/stellar.spec.ts',
    '**/controls.spec.ts',
    '**/network.spec.ts',
    '**/auth.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--no-sandbox'] },
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
