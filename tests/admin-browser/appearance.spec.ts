import { expect, test } from '@playwright/test';

test('device color scheme applies immediately and preserves the session and form', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/console/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  const darkBackground = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByLabel('Admin token').fill('unsaved-token');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('body')).not.toHaveCSS(
    'background-color',
    darkBackground,
  );
  await expect(page.getByLabel('Admin token')).toHaveValue('unsaved-token');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS(
    'background-color',
    darkBackground,
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid admin token.');
  await page.screenshot({
    path: testInfo.outputPath('login-dark.png'),
    fullPage: true,
  });
  await page.getByLabel('Admin token').fill('test-admin-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('overview-dark.png'),
    fullPage: true,
  });

  await page.getByRole('link', { name: 'Models', exact: true }).click();
  const model = page.getByLabel('Model').first();
  await model.fill('unsaved-theme-check');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(model).toHaveValue('unsaved-theme-check');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(model).toHaveValue('unsaved-theme-check');
  const saved = await page.request.get('/admin/model');
  expect(saved.status()).toBe(200);
  expect((await saved.json()).providers[0].model).not.toBe(
    'unsaved-theme-check',
  );
  await page.screenshot({
    path: testInfo.outputPath('models-dark.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('models-dark-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('overview-dark-mobile.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Entries', exact: true }).click();
  await page.getByRole('button', { name: 'View entry 6', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByText('Source HTML', { exact: true }).click();
  await expect(page.locator('pre.source')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('entry-dark.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});
