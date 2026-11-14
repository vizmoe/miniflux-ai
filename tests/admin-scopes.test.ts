import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isMap, parseDocument } from 'yaml';
import { parseConfig } from '../src/config/index.js';
import {
  auth,
  entry,
  feed,
  fixtureValues,
  response,
  serviceFixture,
} from './helpers.js';

const fixtures: Awaited<ReturnType<typeof serviceFixture>>[] = [];
async function setup(yaml = '') {
  const fixture = await serviceFixture(yaml);
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe('Admin scope settings', () => {
  it('limits new work to an allowlist with blocklist priority across feeds and categories', async () => {
    const f = await setup('features:\n  summary:\n    min_source_units: 1\n');
    await f.prepare();
    const before = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: {
        revision: before.revision,
        target: 'translation',
        fallback_action: 'deny',
        allowlist: { feed_ids: [3], category_ids: [7] },
        blocklist: { feed_ids: [1], category_ids: [9] },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().targets[0]).toMatchObject({
      fallback_action: 'deny',
      allowlist: { feed_ids: [3], category_ids: [7] },
      blocklist: { feed_ids: [1], category_ids: [9] },
      applied: true,
    });
    for (const [id, category] of [
      [1, 7],
      [2, 7],
      [3, 9],
      [4, 8],
    ]) {
      const source = entry(id!, undefined, id!, category!);
      f.upstream.feeds.set(id!, source.feed);
      f.upstream.entries.set(id!, source);
    }
    await f.service.ingest.poll();
    await f.drain();
    const actual = (
      await f.app.inject({ url: '/admin/entries', headers: auth })
    ).json().entries;
    expect(actual).toHaveLength(4);
    for (const id of [1, 2, 3, 4]) {
      expect(
        actual.find((e: { entry_id: number }) => e.entry_id === id),
      ).toMatchObject({
        translation_state: id === 2 ? 'ready' : null,
        summary_state: 'ready',
      });
    }
    expect(
      (await f.app.inject({ url: '/admin/config', headers: auth })).json()
        .restart_required,
    ).toBe(false);
  });
  it('supports an empty allowlist and changing the default while retaining ordered YAML rules', async () => {
    const f = await setup(`features:
  translation:
    scope:
      fallback_action: deny
      rules:
        - { name: selected, action: allow, match: { feed_ids: [88] } }
        - { name: later-deny, action: deny, match: { feed_ids: [88, 90] } }
        - { name: combined, action: allow, match: { feed_ids: [42], category_ids: [7] } }
`);
    const before = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    expect(before.targets[0]).toMatchObject({
      allowlist: { feed_ids: [88], category_ids: [] },
      blocklist: { feed_ids: [], category_ids: [] },
      other_rules: [{ name: 'later-deny' }, { name: 'combined' }],
    });
    const request = {
      revision: before.revision,
      target: 'translation',
      fallback_action: 'deny',
      allowlist: { feed_ids: [], category_ids: [] },
      blocklist: { feed_ids: [], category_ids: [] },
    };
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: request,
    });
    expect(saved.statusCode).toBe(200);
    const sample = {
      feed_id: 2,
      category_id: 7,
      source_feed_url: '',
      source_feed_site_url: '',
      entry_url: '',
      source_title: 'Title',
      source_author: '',
      primary_language: 'en',
      source_content_units: 10,
    };
    const dry = () =>
      f.app.inject({
        method: 'POST',
        url: '/admin/rules/dry-run',
        headers: auth,
        payload: { feature: 'translation', sample },
      });
    expect((await dry()).json()).toEqual({ action: 'deny', matchedRule: null });
    const original = parseConfig(
      readFileSync(f.service.configuration.path, 'utf8'),
    ).features.translation.scope.rules;
    expect(original).toEqual([
      { name: 'later-deny', action: 'deny', match: { feed_ids: [88, 90] } },
      {
        name: 'combined',
        action: 'allow',
        match: { feed_ids: [42], category_ids: [7] },
      },
    ]);
    const next = saved.json().targets[0];
    const changed = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: {
        ...request,
        revision: saved.json().revision,
        blocklist: next.blocklist,
        fallback_action: 'allow',
      },
    });
    expect(changed.statusCode).toBe(200);
    expect((await dry()).json()).toEqual({
      action: 'allow',
      matchedRule: null,
    });
    expect(
      parseConfig(readFileSync(f.service.configuration.path, 'utf8')).features
        .translation.scope.rules,
    ).toEqual(original);
  });
  it('lists current subscriptions and empty categories without requiring a model or exposing credentials', async () => {
    const f = await setup('ai:\n  providers: []\n');
    f.upstream.feeds.set(1, { ...feed(1), title: 'Cloudflare Blog' });
    f.upstream.intercept = async (url) =>
      url.pathname === '/v1/categories'
        ? response([
            { id: 7, title: 'News' },
            { id: 9, title: 'Empty category' },
          ])
        : undefined;
    const result = await f.app.inject({
      url: '/admin/subscriptions',
      headers: auth,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      feeds: [{ id: 1, title: 'Cloudflare Blog', category_id: 7 }],
      categories: [
        { id: 9, title: 'Empty category' },
        { id: 7, title: 'News' },
      ],
    });
    expect(result.body).not.toContain(fixtureValues.miniflux_key);
    expect(result.headers['cache-control']).toBe('no-store');
    expect((await f.app.inject('/admin/subscriptions')).statusCode).toBe(401);
  });
  it('saves independent exclusions to private YAML and applies them to new admissions without restarting', async () => {
    const f = await setup('features:\n  summary:\n    min_source_units: 1\n');
    await f.prepare();
    f.upstream.entries.set(1, entry(1));
    await f.service.ingest.poll();
    const before = await f.app.inject({ url: '/admin/scopes', headers: auth });
    expect(before.statusCode).toBe(200);
    const save = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: {
        revision: before.json().revision,
        target: 'translation',
        fallback_action: 'allow',
        allowlist: { feed_ids: [], category_ids: [] },
        blocklist: { feed_ids: [1], category_ids: [9] },
      },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().targets[0]).toMatchObject({
      id: 'translation',
      blocklist: { feed_ids: [1], category_ids: [9] },
      applied: true,
    });
    const saved = parseConfig(
      readFileSync(f.service.configuration.path, 'utf8'),
    );
    expect(saved.features.translation.scope.rules).toEqual([
      { name: 'block-feeds', action: 'deny', match: { feed_ids: [1] } },
      {
        name: 'block-categories',
        action: 'deny',
        match: { category_ids: [9] },
      },
    ]);
    expect(saved.features.summary.scope.rules).toEqual([]);
    expect(saved.ai.providers[0]!.api_key).toBe(fixtureValues.ai_key);
    expect(statSync(f.service.configuration.path).mode & 0o777).toBe(0o600);
    expect(
      (await f.app.inject({ url: '/admin/config', headers: auth })).json()
        .restart_required,
    ).toBe(false);
    f.upstream.entries.set(2, entry(2));
    await f.service.ingest.poll();
    await f.drain();
    const entries = (
      await f.app.inject({ url: '/admin/entries', headers: auth })
    ).json().entries;
    expect(
      entries.find((e: { entry_id: number }) => e.entry_id === 1),
    ).toMatchObject({ translation_state: 'ready', summary_state: 'ready' });
    expect(
      entries.find((e: { entry_id: number }) => e.entry_id === 2),
    ).toMatchObject({ translation_state: null, summary_state: 'ready' });
  });
  it('preserves ordered custom rules and fallback while editing the leading exclusions', async () => {
    const f = await setup(`features:
  translation:
    scope:
      fallback_action: deny
      rules:
        - { name: blocked, action: deny, match: { feed_ids: [1] } }
        - { name: second-block, action: deny, match: { feed_ids: [2] } }
        - { name: exclude-categories, action: allow, match: { feed_ids: [88] } }
        - { name: block-categories, action: deny, match: { feed_ids: [42], category_ids: [9] } }
`);
    const before = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    expect(before.targets[0]).toMatchObject({
      blocklist: { feed_ids: [1, 2], category_ids: [] },
      allowlist: { feed_ids: [88], category_ids: [] },
      fallback_action: 'deny',
    });
    const result = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: {
        revision: before.revision,
        target: 'translation',
        fallback_action: 'deny',
        allowlist: { feed_ids: [88], category_ids: [] },
        blocklist: { feed_ids: [99, 3, 99], category_ids: [7] },
      },
    });
    expect(result.statusCode).toBe(200);
    const yaml = parseConfig(
      readFileSync(f.service.configuration.path, 'utf8'),
    );
    expect(yaml.features.translation.scope).toEqual({
      fallback_action: 'deny',
      rules: [
        { name: 'blocked', action: 'deny', match: { feed_ids: [3, 99] } },
        {
          name: 'block-categories-2',
          action: 'deny',
          match: { category_ids: [7] },
        },
        {
          name: 'exclude-categories',
          action: 'allow',
          match: { feed_ids: [88] },
        },
        {
          name: 'block-categories',
          action: 'deny',
          match: { feed_ids: [42], category_ids: [9] },
        },
      ],
    });
    const sample = {
      feed_id: 88,
      category_id: 7,
      source_feed_url: '',
      source_feed_site_url: '',
      entry_url: '',
      source_title: 'Title',
      source_author: '',
      primary_language: 'en',
      source_content_units: 10,
    };
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/admin/rules/dry-run',
          headers: auth,
          payload: { feature: 'translation', sample },
        })
      ).json(),
    ).toEqual({ action: 'deny', matchedRule: 'block-categories-2' });
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/admin/rules/dry-run',
          headers: auth,
          payload: {
            feature: 'translation',
            sample: { ...sample, category_id: 6 },
          },
        })
      ).json(),
    ).toEqual({ action: 'allow', matchedRule: 'exclude-categories' });
  });
  it('updates only the selected Digest job and immediately uses its new scope', async () => {
    const f = await setup(`features:
  digest:
    enabled: false
    jobs:
      - id: daily
        cron: '0 0 * * *'
        output: { feed_title_template: Daily }
      - id: other
        cron: '0 2 * * *'
        output: { feed_title_template: Other }
`);
    await f.prepare();
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    const before = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    const result = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: {
        revision: before.revision,
        target: 'digest:daily',
        fallback_action: 'allow',
        allowlist: { feed_ids: [], category_ids: [] },
        blocklist: { feed_ids: [], category_ids: [7] },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(
      result
        .json()
        .targets.find((t: { id: string }) => t.id === 'digest:daily'),
    ).toMatchObject({
      blocklist: { feed_ids: [], category_ids: [7] },
      applied: true,
    });
    const dry = async (job_id: string) =>
      (
        await f.app.inject({
          method: 'POST',
          url: '/admin/rules/dry-run',
          headers: auth,
          payload: { feature: 'digest', job_id, entry_id: 1 },
        })
      ).json();
    expect(await dry('daily')).toEqual({
      action: 'deny',
      matchedRule: 'block-categories',
    });
    expect(await dry('other')).toEqual({ action: 'allow', matchedRule: null });
    const config = (
      await f.app.inject({ url: '/admin/config', headers: auth })
    ).json();
    expect(config.restart_required).toBe(false);
    expect(config.config.features.digest.jobs[0]).toMatchObject({
      cron: '0 0 * * *',
      output: { feed_title_template: 'Daily' },
    });
    expect(config.config.features.translation.scope.rules).toEqual([]);
  });
  it('rejects stale revisions and invalid requests without changing YAML or active rules', async () => {
    const f = await setup();
    const initial = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    const valid = {
      revision: initial.revision,
      target: 'summary',
      fallback_action: 'allow',
      allowlist: { feed_ids: [], category_ids: [] },
      blocklist: { feed_ids: [9999], category_ids: [] },
    };
    const save = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: valid,
    });
    expect(save.statusCode).toBe(200);
    const committed = readFileSync(f.service.configuration.path, 'utf8');
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/scopes',
          headers: auth,
          payload: { ...valid, blocklist: { feed_ids: [], category_ids: [] } },
        })
      ).statusCode,
    ).toBe(409);
    for (const invalid of [
      { blocklist: { feed_ids: [0], category_ids: [] } },
      { allowlist: { feed_ids: [], category_ids: ['7'] } },
      { fallback_action: 'invalid' },
      { blocklist: { feed_ids: [] } },
      { allowlist: { feed_ids: [], category_ids: [], unexpected: true } },
      { target: 'digest:missing' },
      { target: '../ai' },
      { revision: 'invalid' },
      { enabled: false },
    ]) {
      const result = await f.app.inject({
        method: 'PUT',
        url: '/admin/scopes',
        headers: auth,
        payload: { ...valid, revision: save.json().revision, ...invalid },
      });
      expect([400, 404]).toContain(result.statusCode);
      expect(readFileSync(f.service.configuration.path, 'utf8')).toBe(
        committed,
      );
    }
    expect(
      (await f.app.inject({ url: '/admin/scopes', headers: auth })).json()
        .targets[1],
    ).toMatchObject({
      blocklist: { feed_ids: [9999], category_ids: [] },
      applied: true,
    });
    expect((await f.app.inject({ url: '/admin/scopes' })).statusCode).toBe(401);
    const login = await f.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: 'http://localhost:80' },
      payload: { token: fixtureValues.admin_token },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/admin/scopes',
          headers: { cookie, origin: 'https://foreign.test' },
          payload: { ...valid, revision: save.json().revision },
        })
      ).statusCode,
    ).toBe(403);
    expect(readFileSync(f.service.configuration.path, 'utf8')).toBe(committed);
  });
  it('keeps YAML and active scopes intact when editing an anchor would break another scope', async () => {
    const f = await setup();
    const path = f.service.configuration.path;
    const document = parseDocument(readFileSync(path, 'utf8'));
    const shared = document.getIn(['features', 'translation', 'scope'], true);
    if (!isMap(shared)) throw new Error('scope_fixture_missing');
    document.setIn(
      ['features', 'summary', 'scope'],
      document.createAlias(shared, 'shared-scope'),
    );
    document.comment = 'Keep this configuration note';
    const text = document.toString();
    writeFileSync(path, text);
    const before = (
      await f.app.inject({ url: '/admin/scopes', headers: auth })
    ).json();
    const payload = {
      revision: before.revision,
      target: 'translation',
      fallback_action: 'allow',
      allowlist: { feed_ids: [], category_ids: [] },
      blocklist: { feed_ids: [1], category_ids: [] },
    };
    const result = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload,
    });
    expect(result.statusCode).toBe(400);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(
      (await f.app.inject({ url: '/admin/scopes', headers: auth })).json()
        .targets[0],
    ).toMatchObject({
      blocklist: { feed_ids: [], category_ids: [] },
      applied: true,
    });
    // Replacing only the alias is safe; its original target must stay unchanged.
    const independent = await f.app.inject({
      method: 'PUT',
      url: '/admin/scopes',
      headers: auth,
      payload: { ...payload, target: 'summary' },
    });
    expect(independent.statusCode).toBe(200);
    expect(
      parseConfig(readFileSync(path, 'utf8')).features.translation.scope.rules,
    ).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain(
      'Keep this configuration note',
    );
  });
  it('reports unavailable catalogs and never lists subscriptions from an unverified account', async () => {
    const f = await setup();
    f.upstream.userId = 2;
    f.service.repository.bind({
      schema_version: 1,
      base_url: fixtureValues.miniflux_url,
      user_id: 1,
    });
    const mismatch = await f.app.inject({
      url: '/admin/subscriptions',
      headers: auth,
    });
    expect(mismatch.statusCode).toBe(503);
    expect(mismatch.json()).toEqual({ code: 'miniflux_account_mismatch' });
    expect(
      f.upstream.requests.some((r) =>
        ['/v1/feeds', '/v1/categories'].includes(r.url.pathname),
      ),
    ).toBe(false);
    const offline = await setup();
    offline.upstream.intercept = async (url) =>
      url.pathname === '/v1/categories' ? response({}, 503) : undefined;
    expect(
      (await offline.app.inject({ url: '/admin/subscriptions', headers: auth }))
        .statusCode,
    ).toBe(503);
    expect(
      (await offline.app.inject({ url: '/admin/scopes', headers: auth }))
        .statusCode,
    ).toBe(200);
  });
});
