import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('normal navigation loads a new deployment despite cached old assets', async ({
  page,
}) => {
  const [legacyHtml, html, script, style] = await Promise.all([
    readFile('admin/index.html', 'utf8'),
    readFile('dist/admin/index.html', 'utf8'),
    readFile('dist/admin/app.js', 'utf8'),
    readFile('dist/admin/app.css', 'utf8'),
  ]);
  let deployed = false;
  const assetRequests: string[] = [];
  // A real HTTP server lets Chromium use its HTTP cache. Playwright routing
  // disables that cache and would hide the production failure.
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/console/') {
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
      });
      response.end(deployed ? html : legacyHtml);
    } else if (['/console/app.js', '/console/app.css'].includes(url.pathname)) {
      assetRequests.push(request.url!);
      const isScript = url.pathname.endsWith('.js');
      response.writeHead(200, {
        'Content-Type': isScript ? 'text/javascript' : 'text/css',
        'Cache-Control': 'public, max-age=14400',
      });
      const legacy = isScript
        ? 'document.querySelector("#app").innerHTML = "<h1>Old console</h1>";'
        : ':root { color-scheme: light; }';
      response.end(deployed ? (isScript ? script : style) : legacy);
    } else {
      response.writeHead(401, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end('{"code":"unauthorized"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${origin}/console/`);
    await expect(
      page.getByRole('heading', { name: 'Old console' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    const cached = [...assetRequests].sort();
    expect(cached).toEqual(['/console/app.css', '/console/app.js']);

    deployed = true;
    await page.goto('about:blank');
    await page.goto(`${origin}/console/`);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    expect(assetRequests).toHaveLength(4);
    expect(assetRequests.slice(2).every((url) => !cached.includes(url))).toBe(
      true,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
