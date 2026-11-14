import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('browser session, persistent settings, diagnostics, recovery and mobile layout', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/console/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveTitle('Sign in · miniflux-ai');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Admin token')).toBeFocused();
  await page.screenshot({
    path: 'artifacts/admin-browser/login-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'artifacts/admin-browser/login-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Admin token').fill('incorrect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid admin token.');
  await page.getByLabel('Admin token').fill('test-admin-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('cell', { name: 'Cloudflare Blog', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link'),
  ).toHaveText([
    'Overview',
    'Entries',
    'Tasks',
    'Models',
    'Processing rules',
    'System',
  ]);
  await page.screenshot({
    path: 'artifacts/admin-browser/overview-desktop.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookie: '' });
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await page.getByLabel('Model').fill('browser-tested-model');
  await page.getByLabel('API Key').fill('browser-test-only-secret');
  await page.getByLabel('Timeout (s)').fill('65');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#notice')).toContainText('Settings saved.');
  await page.reload();
  await expect(page.getByLabel('Model')).toHaveValue('browser-tested-model');
  await expect(page.getByLabel('API Key')).toHaveValue('');
  await expect(page.getByLabel('Timeout (s)')).toHaveValue('65');
  expect(await page.content()).not.toContain('browser-test-only-secret');
  await page.getByRole('button', { name: 'Add provider' }).click();
  const backup = page.locator('[data-provider]').last();
  await backup.getByLabel('Provider ID').fill('backup');
  await backup.getByLabel('Priority').fill('50');
  await backup.getByLabel('API Base URL').fill('https://backup.test/v1');
  await backup.getByLabel('Model').fill('backup-model');
  await backup.getByLabel('API Key').fill('browser-backup-secret');
  await page.getByLabel('Failure threshold').fill('1');
  await page.getByLabel('Cooldown').fill('2m');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#notice')).toContainText('Settings saved.');
  await page.reload();
  await expect(page.locator('[data-provider]')).toHaveCount(2);
  await expect(page.getByLabel('Model').nth(1)).toHaveValue('backup-model');
  await expect(page.getByLabel('API Key').nth(1)).toHaveValue('');
  await expect(page.getByLabel('Failure threshold')).toHaveValue('1');
  await expect(page.getByLabel('Cooldown')).toHaveValue('2m');
  expect(await page.content()).not.toContain('browser-backup-secret');
  // A second browser editor commits first; this page must not overwrite it.
  const before = await (await page.request.get('/admin/model')).json();
  const providers = before.providers.map(
    ({ health, api_key_configured, ...provider }: Record<string, unknown>) => {
      void health;
      void api_key_configured;
      return provider;
    },
  );
  const competing = await page.request.put('/admin/model', {
    headers: { Origin: 'http://127.0.0.1:4199' },
    data: {
      revision: before.revision,
      failover: { ...before.failover, cooldown: '3m' },
      providers,
    },
  });
  expect(competing.status()).toBe(200);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#notice')).toContainText(
    'Configuration changed. Refresh before saving.',
  );
  await page.reload();
  await expect(page.getByLabel('Cooldown')).toHaveValue('3m');
  await page.screenshot({
    path: 'artifacts/admin-browser/model-desktop.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Entries', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Entries', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'artifacts/admin-browser/entries-desktop.png',
    fullPage: true,
  });
  await page.getByRole('searchbox').fill('no-matching-fixture-entry');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(
    page.getByText('No matching entries.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('searchbox').fill('untrusted');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('button', { name: '<img src=x' })).toBeVisible();
  expect(await page.evaluate(() => 'injected' in window)).toBe(false);
  await page.getByRole('button', { name: 'View entry 6' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retranslate', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Regenerate summary', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'artifacts/admin-browser/entry-details.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption('dead');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.locator('.task-error').first()).toBeVisible();
  await page.screenshot({
    path: 'artifacts/admin-browser/tasks-desktop.png',
    fullPage: true,
  });
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toBe(
      'Retry this task? This may call a model or write to Miniflux.',
    );
    await dialog.accept();
  });
  await page
    .getByRole('button', { name: 'Retry', exact: true })
    .first()
    .click();
  await expect(page.locator('#notice')).toContainText('Task queued.');
  await page.getByRole('link', { name: 'System', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'System', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Diagnostics', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Configuration', exact: false }),
  ).toBeVisible();
  await expect(page).toHaveTitle('System · miniflux-ai');
  await page.screenshot({
    path: 'artifacts/admin-browser/system-desktop.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'artifacts/admin-browser/overview-mobile.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByLabel('API Base URL').first()).toBeVisible();
  await page.screenshot({
    path: 'artifacts/admin-browser/model-mobile.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Remove backup', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(page.locator('[data-provider]')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Sign in · miniflux-ai');
  expect((await page.request.get('/admin/stats')).status()).toBe(401);
  expect(errors).toEqual([]);
  await testInfo.attach('verification-context', {
    body: JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        command: 'pnpm test:admin',
        upstream:
          'in-process Miniflux / AI fixtures; real HTTP + browser + SQLite',
        browser: 'Chromium',
        assertions:
          'English login and console, redaction, YAML multi-provider persistence, concurrent-save conflict, provider removal, stats, XSS text, entry actions, task requeue confirmation, system diagnostics, logout, 390px layout',
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
