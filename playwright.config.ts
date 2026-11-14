import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:18801',
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'recovered-chromium',
      testDir: './tests/admin-browser',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4199',
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx tests/helpers/serve-console.ts',
      url: 'http://127.0.0.1:18801/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm exec tsx tests/admin-browser/server.ts',
      url: 'http://127.0.0.1:4199/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
