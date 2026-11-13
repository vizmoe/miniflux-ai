import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import {
  adminToken,
  exampleEntry,
  startHarness,
  webhookSecret,
} from '../helpers/harness.js';
import { retrySnapshot } from '../../src/config/snapshots.js';
import type { ScopeView, ModelView, EntryDetail } from '../../web/types.js';

let harness: Awaited<ReturnType<typeof startHarness>>;
beforeEach(async () => {
  harness = await startHarness();
  await vi.waitFor(
    async () => expect((await fetch(harness.url + '/readyz')).status).toBe(200),
    { timeout: 10_000 },
  );
});
afterEach(async () => {
  await harness?.close();
});
const headers = {
  authorization: `Bearer ${adminToken}`,
  'content-type': 'application/json',
};
function api(path: string, method = 'GET', body?: unknown) {
  return fetch(harness.url + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ingestExample() {
  const entry = exampleEntry();
  const original = entry.content;
  harness.entries.set(entry.id, entry);
  const body = JSON.stringify({ entries: [entry] });
  const signature = createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-miniflux-signature': signature,
    'x-miniflux-event-type': 'new_entries',
  };
  const accepted = await fetch(harness.url + '/webhook/miniflux', {
    method: 'POST',
    headers,
    body,
  });
  expect(accepted.status).toBe(204);
  await expect.poll(() => harness.writes.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => harness.service.queue.active.size).toBe(0);
  return { original, body, headers };
}

it('serves built console assets and enforces authentication and same-origin protection', async () => {
  expect((await fetch(harness.url + '/healthz')).status).toBe(200);
  expect((await fetch(harness.url + '/admin/config')).status).toBe(401);
  const html = await fetch(harness.url + '/console/');
  expect(html.status).toBe(200);
  expect(await html.text()).toContain('/console/app.js');
  const js = await fetch(harness.url + '/console/app.js');
  expect(js.headers.get('content-type')).toContain('javascript');
  expect((await js.text()).length).toBeGreaterThan(1000);
  const config = await (await api('/admin/config')).text();
  expect(config).not.toContain(adminToken);
  expect(config).not.toContain('local-ai-test');
  const rejected = await fetch(harness.url + '/auth/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://untrusted.test',
    },
    body: JSON.stringify({ token: adminToken }),
  });
  expect(rejected.status).toBe(403);
  const login = await fetch(harness.url + '/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: harness.url },
    body: JSON.stringify({ token: adminToken }),
  });
  expect(login.status).toBe(201);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(
    (await fetch(harness.url + '/admin/status', { headers: { cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(harness.url + '/admin/backfill', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://untrusted.test',
          'content-type': 'application/json',
        },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(harness.url + '/auth/session', {
        method: 'DELETE',
        headers: { cookie, origin: harness.url },
      })
    ).status,
  ).toBe(204);
  expect(
    (await fetch(harness.url + '/admin/status', { headers: { cookie } }))
      .status,
  ).toBe(401);
});

it('receives a signed webhook, generates both features, and preserves source on write-back', async () => {
  const bad = await fetch(harness.url + '/webhook/miniflux', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-miniflux-signature': 'invalid',
    },
    body: '{}',
  });
  expect(bad.status).toBe(401);
  const { original, body, headers } = await ingestExample();
  expect(harness.writes[0].title).toContain('科学发现');
  expect(harness.writes[0].content).toContain('这是已恢复的中文译文。');
  expect(harness.writes[0].content).toContain(
    'Researchers reported a scientific discovery.',
  );
  expect(harness.writes[0].content).toContain(original);
  expect(harness.aiOperations).toContain('generate_artifacts');
  expect(
    harness.service.repository.featureStates(1).map((state) => state.state),
  ).toEqual(['ready', 'ready']);
  expect(
    (
      await fetch(harness.url + '/webhook/miniflux', {
        method: 'POST',
        headers,
        body,
      })
    ).status,
  ).toBe(204);
  await harness.service.queue.idle();
  expect(harness.writes).toHaveLength(1);
  const detail = (await (await api('/admin/entries/1')).json()) as EntryDetail;
  expect(detail.source.title).toBe('A scientific discovery');
  expect(detail.source.content).toBe(original);
  expect(detail.tasks).toHaveLength(2);
});

it('publishes a digest and exposes the Atom provisioning feed', async () => {
  await ingestExample();
  const selected = await api('/admin/digests/run', 'POST', { job_id: 'daily' });
  expect(selected.status).toBe(200);
  await expect.poll(() => harness.imports.length, { timeout: 15_000 }).toBe(1);
  expect(harness.aiOperations).toEqual(
    expect.arrayContaining([
      'generate_digest_item',
      'generate_digest_overview',
    ]),
  );
  const imported = harness.imports[0] as { title: string; content: string };
  expect(imported.content).toContain('Today in science.');
  expect(imported.content).toContain('https://example.test/articles/1');
  const feed = await fetch(harness.url + '/digest/feeds/daily.xml');
  expect(feed.status).toBe(200);
  expect(feed.headers.get('content-type')).toContain('application/atom+xml');
  expect(await feed.text()).toContain('http://www.w3.org/2005/Atom');
  expect((await fetch(harness.url + '/digest/feeds/missing.xml')).status).toBe(
    404,
  );
});

it('supports dry-run backfill and rejects stale configuration revisions without exposing secrets', async () => {
  await ingestExample();
  harness.entries.set(2, exampleEntry(2));
  const backfill = await api('/admin/backfill', 'POST', {
    dry_run: true,
    limit: 2,
    features: ['translation', 'summary'],
  });
  expect(backfill.status).toBe(202);
  const task = (await backfill.json()) as { id: number };
  await expect
    .poll(() => harness.service.repository.task(task.id)?.state, {
      timeout: 10_000,
    })
    .toBe('done');
  const progress = harness.service.repository.task(task.id)!.progress!;
  expect(progress.examined_entries).toBe(2);
  expect(progress.admitted_entries).toBe(1);
  expect(harness.service.repository.entry(2)).toBeUndefined();
  const scopes = (await (await api('/admin/scopes')).json()) as ScopeView;
  const update = {
    target: 'translation',
    revision: scopes.revision,
    fallback_action: 'deny',
    allowlist: { feed_ids: [1], category_ids: [] },
    blocklist: { feed_ids: [], category_ids: [] },
  };
  expect((await api('/admin/scopes', 'PUT', update)).status).toBe(200);
  expect((await api('/admin/scopes', 'PUT', update)).status).toBe(409);
  const model = (await (await api('/admin/model')).json()) as ModelView;
  const provider = model.providers[0];
  const save = await api('/admin/model', 'PUT', {
    revision: model.revision,
    providers: [
      {
        id: provider.id,
        enabled: provider.enabled,
        base_url: provider.base_url,
        model: provider.model,
        priority: 3,
        request_timeout_ms: provider.request_timeout_ms,
        api_key: '',
      },
    ],
    failover: model.failover,
  });
  expect(save.status).toBe(200);
  expect(await save.text()).not.toContain('local-ai-test');
  const yaml = parse(await readFile(harness.configPath, 'utf8')) as {
    ai: { providers: { api_key: string; priority: number }[] };
  };
  expect(yaml.ai.providers[0].api_key).toBe('local-ai-test');
  expect(yaml.ai.providers[0].priority).toBe(3);
  expect(
    harness.service.config.features.translation.scope.fallback_action,
  ).toBe('deny');
});

it('rerenders the same content without duplicating generated sections', async () => {
  await ingestExample();
  expect((await api('/admin/entries/999999')).status).toBe(404);
  const original = harness.writes[0];
  const task = harness.service.repository.requestRender(
    1,
    retrySnapshot(harness.service.config),
  );
  harness.service.queue.tick();
  await expect
    .poll(() => harness.service.repository.task(task.id)?.state)
    .toBe('done');
  expect(harness.writes).toHaveLength(2);
  expect(harness.writes[1]).toEqual(original);
});
