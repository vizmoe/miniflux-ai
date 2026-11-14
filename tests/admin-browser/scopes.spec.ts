import { expect, test, type Page } from '@playwright/test';

const emptyList = { feed_ids: [], category_ids: [] };
const defaultPolicy = {
  fallback_action: 'allow',
  allowlist: emptyList,
  blocklist: emptyList,
};

test('administrator limits processing with both lists and sees blocklist priority before saving', async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole('heading', { name: 'Processing rules', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page
    .getByRole('radio', { name: 'Selected feeds', exact: false })
    .check();
  await expect(
    page.getByText(
      'Nothing is included. Add feeds or categories to the allowlist.',
    ),
  ).toBeVisible();
  await selectItems(page, 'allowlist', ['News (category 7)']);
  await selectItems(page, 'blocklist', ['Cloudflare Blog (feed 1)']);
  await expect(page.getByLabel('Scope preview')).toContainText('1 included');
  await expect(page.getByLabel('Scope preview')).toContainText('1 excluded');
  await expect(
    page.getByText('1 allowlisted feed is blocked. Blocklist takes priority.'),
  ).toBeVisible();
  // Drafts survive Feature switches, in-app navigation and a data refresh.
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: /Translation/, exact: false }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page
    .getByRole('link', { name: 'Processing rules', exact: true })
    .click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expandSelected(page, 'Blocklist');
  await expect(
    page.getByRole('radio', { name: 'Selected feeds', exact: false }),
  ).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Remove Cloudflare Blog from blocklist' }),
  ).toBeVisible();
  await expect(
    page.getByText('Unsaved changes', { exact: true }),
  ).toBeVisible();
  await saveRules(page);
  const saved = await (await page.request.get('/admin/scopes')).json();
  expect(
    saved.targets.find((t: { id: string }) => t.id === 'translation'),
  ).toMatchObject({
    fallback_action: 'deny',
    allowlist: { feed_ids: [], category_ids: [7] },
    blocklist: { feed_ids: [1], category_ids: [] },
    applied: true,
  });
  expect(
    (await (await page.request.get('/admin/config')).json()).restart_required,
  ).toBe(false);
  await page.reload();
  await expandSelected(page, 'Blocklist');
  await expandSelected(page, 'Allowlist');
  await expect(
    page.getByRole('button', { name: 'Remove Cloudflare Blog from blocklist' }),
  ).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: `artifacts/admin-browser/processing-rules-${colorScheme}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'artifacts/admin-browser/processing-rules-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

async function signIn(page: Page) {
  await page.goto('/console/#scopes');
  await page.getByLabel('Admin token').fill('test-admin-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Blocklist', exact: true }),
  ).toBeVisible();
  // Reset through the real API so each journey is independent of previous saves.
  const response = await page.request.get('/admin/scopes');
  expect(response.status()).toBe(200);
  const initial = await response.json();
  let revision = initial.revision;
  for (const target of initial.targets) {
    const result = await page.request.put('/admin/scopes', {
      headers: { Origin: 'http://127.0.0.1:4199' },
      data: { revision, target: target.id, ...defaultPolicy },
    });
    expect(result.status()).toBe(200);
    revision = (await result.json()).revision;
  }
  await page.reload();
}

async function selectItems(
  page: Page,
  list: 'allowlist' | 'blocklist',
  names: string[],
) {
  await page.getByRole('button', { name: `Edit ${list}`, exact: true }).click();
  const picker = page.getByRole('dialog', {
    name: `Edit ${list}`,
    exact: true,
  });
  for (const name of names) {
    await picker
      .getByRole('searchbox')
      .fill(name.replace(/ \((feed|category) \d+\)$/, ''));
    await picker.getByRole('checkbox', { name, exact: true }).check();
  }
  await picker
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await expandSelected(page, list === 'allowlist' ? 'Allowlist' : 'Blocklist');
}

async function expandSelected(page: Page, list: 'Allowlist' | 'Blocklist') {
  const region = page.getByRole('region', { name: list, exact: true });
  await expect(region).toBeVisible();
  for (const summary of await region
    .locator('details:not([open]) > summary')
    .all())
    await summary.click();
}

async function saveRules(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/admin/scopes') && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('#notice')).toContainText(
    'Rules saved and applied.',
  );
}

test('picker supports search, keyboard cancellation, reset and independent Digest rules', async ({
  page,
}) => {
  await signIn(page);
  const edit = page.getByRole('button', {
    name: 'Edit blocklist',
    exact: true,
  });
  await edit.click();
  const picker = page.getByRole('dialog', {
    name: 'Edit blocklist',
    exact: true,
  });
  await expect(picker.getByRole('searchbox')).toBeFocused();
  await picker.getByRole('searchbox').fill('engineering');
  await expect(picker.getByRole('checkbox')).toHaveCount(2);
  await expect(
    picker.getByRole('region', { name: 'News', exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole('checkbox', { name: 'Cloudflare Blog (feed 1)' }),
  ).not.toBeVisible();
  await picker
    .getByRole('checkbox', { name: 'Engineering Notes (feed 2)' })
    .check();
  await picker.getByRole('searchbox').fill('missing');
  await expect(picker.getByText('No matching subscriptions.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await selectItems(page, 'blocklist', ['Engineering Notes (feed 2)']);
  await page
    .getByRole('button', { name: 'Reset changes', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Remove Engineering Notes from blocklist',
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Digest · daily', exact: true })
    .click();
  await page
    .getByRole('radio', { name: 'Selected feeds', exact: false })
    .check();
  await selectItems(page, 'allowlist', ['Engineering Notes (feed 2)']);
  await saveRules(page);
  const current = await (await page.request.get('/admin/scopes')).json();
  expect(
    current.targets.find((t: { id: string }) => t.id === 'translation'),
  ).toMatchObject(defaultPolicy);
  expect(
    current.targets.find((t: { id: string }) => t.id === 'digest:daily'),
  ).toMatchObject({
    fallback_action: 'deny',
    allowlist: { feed_ids: [2], category_ids: [] },
    blocklist: emptyList,
  });
  await page
    .getByRole('button', { name: 'Edit allowlist', exact: true })
    .click();
  const allowPicker = page.getByRole('dialog', {
    name: 'Edit allowlist',
    exact: true,
  });
  await expect(
    allowPicker.getByRole('checkbox', { name: 'Engineering Notes (feed 2)' }),
  ).not.toBeVisible();
  await allowPicker
    .getByRole('checkbox', { name: 'Empty category (category 9)' })
    .check();
  await allowPicker
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
});

test('conflicting saves preserve the draft and require a choice before overwriting changed rules', async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole('radio', { name: 'Selected feeds', exact: false })
    .check();
  await selectItems(page, 'allowlist', ['Cloudflare Blog (feed 1)']);
  const current = await (await page.request.get('/admin/scopes')).json();
  expect(
    (
      await page.request.put('/admin/scopes', {
        headers: { Origin: 'http://127.0.0.1:4199' },
        data: {
          revision: current.revision,
          target: 'translation',
          ...defaultPolicy,
          blocklist: { feed_ids: [2], category_ids: [] },
        },
      })
    ).status(),
  ).toBe(200);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/admin/scopes') && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText('your edits are safe');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expandSelected(page, 'Allowlist');
  await expect(page.getByRole('alert')).toContainText(
    'Saved rules changed while you were editing.',
  );
  await expect(
    page.getByRole('button', { name: 'Remove Cloudflare Blog from allowlist' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  expect(
    (await (await page.request.get('/admin/scopes')).json()).targets[0]
      .blocklist.feed_ids,
  ).toEqual([2]);
  await page
    .getByRole('button', { name: 'Keep my changes', exact: true })
    .click();
  await saveRules(page);
  expect(
    (await (await page.request.get('/admin/scopes')).json()).targets[0],
  ).toMatchObject({
    fallback_action: 'deny',
    allowlist: { feed_ids: [1], category_ids: [] },
    blocklist: emptyList,
  });
});

test('unavailable catalog and failed save retain choices; subscription titles are safe text', async ({
  page,
}) => {
  await signIn(page);
  const current = await (await page.request.get('/admin/scopes')).json();
  expect(
    (
      await page.request.put('/admin/scopes', {
        headers: { Origin: 'http://127.0.0.1:4199' },
        data: {
          revision: current.revision,
          target: 'translation',
          ...defaultPolicy,
          blocklist: { feed_ids: [9999], category_ids: [] },
        },
      })
    ).status(),
  ).toBe(200);
  await page.route('**/admin/subscriptions', (route) =>
    route.fulfill({ status: 503, json: { code: 'miniflux_unavailable' } }),
  );
  await page.reload();
  await expandSelected(page, 'Blocklist');
  await expect(page.getByRole('alert')).toContainText(
    'Subscriptions unavailable.',
  );
  await expect(
    page.getByRole('button', { name: 'Edit blocklist', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove Feed #9999 from blocklist' })
    .click();
  await page.route('**/admin/scopes', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          json: { code: 'configuration_write_unavailable' },
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByText('Unable to save. Your edits are kept. Try again.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeEnabled();
  await page.unroute('**/admin/scopes');
  await saveRules(page);
  await page.unroute('**/admin/subscriptions');
  const title = '<img src=x onerror="window.catalogInjected=true">';
  await page.route('**/admin/subscriptions', (route) =>
    route.fulfill({
      json: {
        feeds: [{ id: 3, title, category_id: 7 }],
        categories: [{ id: 7, title: 'News' }],
      },
    }),
  );
  await page.reload();
  await page
    .getByRole('button', { name: 'Edit allowlist', exact: true })
    .click();
  const picker = page.getByRole('dialog', {
    name: 'Edit allowlist',
    exact: true,
  });
  await picker
    .getByRole('button', { name: 'Expand News', exact: true })
    .click();
  await expect(picker.getByText(title, { exact: true })).toBeVisible();
  await picker
    .getByRole('checkbox', { name: `${title} (feed 3)`, exact: true })
    .check();
  await picker
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await expandSelected(page, 'Allowlist');
  await expect(
    page
      .getByRole('region', { name: 'Allowlist', exact: true })
      .getByText(title, { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => 'catalogInjected' in window)).toBe(false);
  await page
    .getByRole('button', { name: 'Reset changes', exact: true })
    .click();
});

test('category directories support keyboard folding, inherited selection and saving category identities', async ({
  page,
}) => {
  await signIn(page);
  const feeds = [
    { id: 1, title: 'Cloudflare Blog', category_id: 7 },
    { id: 2, title: 'Engineering Notes', category_id: 7 },
    { id: 3, title: 'Release Notes', category_id: 8 },
  ];
  await page.route('**/admin/subscriptions', (route) =>
    route.fulfill({
      json: {
        feeds,
        categories: [
          { id: 7, title: 'News' },
          { id: 8, title: 'Software' },
          { id: 9, title: 'Empty category' },
        ],
      },
    }),
  );
  await page.reload();
  await page
    .getByRole('button', { name: 'Edit blocklist', exact: true })
    .click();
  const picker = page.getByRole('dialog', {
    name: 'Edit blocklist',
    exact: true,
  });
  const news = picker.getByRole('region', { name: 'News', exact: true });
  const feed = news.getByRole('checkbox', { name: 'Cloudflare Blog (feed 1)' });
  await expect(feed).not.toBeVisible();
  const expand = news.getByRole('button', { name: 'Expand News', exact: true });
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(feed).toBeVisible();
  await feed.check();
  await expect(
    news.getByRole('checkbox', { name: 'News (category 7)' }),
  ).toBeChecked({ indeterminate: true });
  await page.keyboard.press('Tab');
  await news
    .getByRole('button', { name: 'Collapse News', exact: true })
    .focus();
  await page.keyboard.press('Space');
  await expect(feed).not.toBeVisible();
  await expect(news).toContainText('1 of 2 feeds selected');
  await picker.getByRole('searchbox').fill('engineering');
  await expect(news).toBeVisible();
  await expect(
    news.getByRole('checkbox', { name: 'Engineering Notes (feed 2)' }),
  ).toBeVisible();
  await expect(feed).not.toBeVisible();
  await picker.getByRole('searchbox').fill('');
  await expect(feed).not.toBeVisible();
  await news.getByRole('checkbox', { name: 'News (category 7)' }).check();
  await news.getByRole('button', { name: 'Expand News', exact: true }).click();
  await expect(feed).toBeChecked();
  await expect(feed).toBeDisabled();
  await expect(
    news.getByRole('checkbox', { name: 'Engineering Notes (feed 2)' }),
  ).toBeDisabled();
  await news.getByRole('checkbox', { name: 'News (category 7)' }).uncheck();
  await expect(feed).toBeChecked();
  await expect(feed).toBeEnabled();
  await expect(
    news.getByRole('checkbox', { name: 'Engineering Notes (feed 2)' }),
  ).not.toBeChecked();
  await news.getByRole('checkbox', { name: 'News (category 7)' }).check();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: `artifacts/admin-browser/scope-tree-${colorScheme}.png`,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await picker.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'artifacts/admin-browser/scope-tree-mobile.png',
    animations: 'disabled',
  });
  await picker
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  const list = page.getByRole('region', { name: 'Blocklist', exact: true });
  await expect(
    list.getByText('Cloudflare Blog', { exact: true }),
  ).not.toBeVisible();
  await list.locator('summary').click();
  await expect(
    list.getByText('Cloudflare Blog', { exact: true }),
  ).toBeVisible();
  await list.locator('summary').click();
  await expect(
    list.getByText('Cloudflare Blog', { exact: true }),
  ).not.toBeVisible();
  await saveRules(page);
  const saved = await (await page.request.get('/admin/scopes')).json();
  expect(saved.targets[0].blocklist).toEqual({
    category_ids: [7],
    feed_ids: [1],
  });
  feeds.push({ id: 4, title: 'New subscription', category_id: 7 });
  await page.reload();
  await expect(page.getByLabel('Scope preview')).toContainText('3 excluded');
  await expect(page.getByLabel('Scope preview')).toContainText('1 included');
  await expandSelected(page, 'Blocklist');
  await expect(
    list.getByText('New subscription', { exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get('/admin/config')).json()).restart_required,
  ).toBe(false);
});
