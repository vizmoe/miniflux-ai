import { expect, test, type Page } from '@playwright/test';

async function checkContrast(page: Page) {
  const measurements = await page.evaluate(() => {
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number);
      return [values[0]!, values[1]!, values[2]!, values[3] ?? 1];
    };
    const composite = (foreground: number[], background: number[]) =>
      foreground
        .slice(0, 3)
        .map(
          (value, index) =>
            value * foreground[3]! + background[index]! * (1 - foreground[3]!),
        );
    const background = (element: Element) => {
      const layers: number[][] = [];
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        const layer = rgba(getComputedStyle(current).backgroundColor);
        layers.push(layer);
        if (layer[3] === 1) break;
      }
      return layers.reduceRight(
        (under, over) => composite(over, under),
        [255, 255, 255],
      );
    };
    const luminance = (color: number[]) => {
      const linear = color.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const contrast = (foreground: string, backdrop: number[]) => {
      const fg = luminance(composite(rgba(foreground), backdrop));
      const bg = luminance(backdrop);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    };
    const results: { selector: string; ratio: number; minimum: number }[] = [];
    const selectors = [
      'h1',
      'h2',
      'h3',
      'label',
      'input:not([type=checkbox])',
      'select',
      'button:enabled',
      '.button',
      'nav a',
      '.logo',
      '.light',
      '.small',
      '.help',
      '.tag',
      '.top-tag',
      '.eyebrow',
      '.nav-caption',
      '.stat-top',
      '.stat-number',
      '.stat-word',
      '.pipeline-item',
      '.text-link',
      'th',
      'td',
      '.feed-mark',
      '.badge',
      '.stat-icon',
      '.chart-foot',
      '.panel-foot',
      '.pagination',
      '.optional',
      '.empty',
      '.form-error',
      '.error-panel',
      '.task-error',
      '.notice:not(:empty)',
      'summary',
      'pre',
      '.chart text',
      ':focus-visible',
    ];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || element.closest(':disabled'))
        continue;
      const style = getComputedStyle(element);
      const backdrop = background(element);
      const selector = element.tagName + '.' + [...element.classList].join('.');
      const foreground = element.matches('.chart text')
        ? style.fill
        : style.color;
      results.push({
        selector,
        ratio: contrast(foreground, backdrop),
        minimum: 4.5,
      });
      if (element.matches('input[placeholder]')) {
        const placeholder = getComputedStyle(element, '::placeholder');
        results.push({
          selector: selector + '::placeholder',
          ratio: contrast(placeholder.color, backdrop),
          minimum: 4.5,
        });
      }
      if (
        style.outlineStyle !== 'none' &&
        Number.parseFloat(style.outlineWidth) > 0
      ) {
        results.push({
          selector: selector + ' outline',
          ratio: contrast(
            style.outlineColor,
            background(element.parentElement!),
          ),
          minimum: 3,
        });
      }
    }
    for (const bar of document.querySelectorAll('.bar')) {
      const track = bar.parentElement!.querySelector('.bar-track')!;
      results.push({
        selector: '.bar',
        ratio: contrast(
          getComputedStyle(bar).fill,
          rgba(getComputedStyle(track).fill).slice(0, 3),
        ),
        minimum: 3,
      });
    }
    return results;
  });
  expect(measurements.length).toBeGreaterThan(0);
  for (const value of measurements)
    expect
      .soft(value.ratio, value.selector)
      .toBeGreaterThanOrEqual(value.minimum);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`${colorScheme} text, controls and charts meet contrast requirements`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/console/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Skip to content' }),
    ).toBeFocused();
    await checkContrast(page);
    await page.getByLabel('Admin token').fill('incorrect');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid admin token.');
    await checkContrast(page);
    await page.getByLabel('Admin token').fill('test-admin-credential');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    for (const route of [
      'overview',
      'model',
      'scopes',
      'entries',
      'tasks',
      'system',
    ]) {
      await page.goto('/console/#' + route);
      await expect(page.locator('.page-heading')).toBeVisible();
      await checkContrast(page);
    }
    await page.goto('/console/#entries');
    await page
      .getByRole('button', { name: 'View entry 6', exact: true })
      .click();
    await page.getByText('Source HTML', { exact: true }).click();
    await expect(page.locator('pre.source')).toBeVisible();
    await checkContrast(page);
  });
}
