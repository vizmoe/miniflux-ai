import { test, expect } from '@playwright/test';
import { adminToken } from '../helpers/harness.js';

test('authenticates, saves model and scope settings, and signs out', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/console/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Admin token').fill(adminToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('overview.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await page.getByLabel('Priority', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Settings saved.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Priority', { exact: true })).toHaveValue('7');
  await page.reload();
  await expect(page.getByLabel('Priority', { exact: true })).toHaveValue('7');
  await expect(
    page.getByPlaceholder('Leave blank to keep current key'),
  ).toHaveValue('');
  await page
    .getByRole('link', { name: 'Processing rules', exact: true })
    .click();
  await page.locator('input[name=fallback_action][value=deny]').check();
  await page
    .getByRole('button', { name: 'Edit allowlist', exact: true })
    .click();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page.locator('dialog input[name=feed_ids][value="1"]').check();
  await page
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText('Rules saved and applied.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(
    page.locator('input[name=fallback_action][value=deny]'),
  ).toBeChecked();
  await expect(
    page.getByRole('region', { name: 'Allowlist', exact: true }),
  ).toContainText('Example feed');
  await page.screenshot({
    path: testInfo.outputPath('rules.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(errors).toEqual([]);
});
