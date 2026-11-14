import { afterEach, describe, expect, it } from 'vitest';
import { computeSourceIntegritySignature } from '../src/html/ownership.js';
import {
  chat,
  generated,
  response,
  serviceFixture,
  entry,
  feed,
  signed,
  auth,
  fixtureValues,
} from './helpers.js';

const fixtures: Awaited<ReturnType<typeof serviceFixture>>[] = [];
async function setup(yaml = '') {
  const f = await serviceFixture(yaml);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const enabled = 'features:\n  summary:\n    min_source_units: 1\n';

describe('admission and complete Artifact Write-back', () => {
  it('writes translations without rewriting stored absolute resource URLs', async () => {
    const f = await setup(enabled);
    await f.prepare();
    const content =
      '<p>Visit <a href="http://example.com">the main site</a> or <a href="http://feature-login.previews.example.com">the preview</a> and <a href="http://EXAMPLE.org">the other site</a> for details.</p><img src="https://Images.example.com:443" alt="Preview image">';
    f.upstream.entries.set(1, entry(1, content));
    await f.service.ingest.poll();
    await f.drain();
    expect(f.upstream.puts).toBe(1);
    expect(f.service.repository.entry(1)!.rendered_generation).toBe(1);
    expect(
      computeSourceIntegritySignature(
        f.upstream.entries.get(1)!.content,
        f.service.repository.artifacts(1),
      ),
    ).toEqual(computeSourceIntegritySignature(content));
  });
  it('preserves implicit table containers across sanitizer serialization and HTML5 reparsing', async () => {
    const f = await setup(enabled);
    await f.prepare();
    const content =
      '<table><thead><tr><th>Column heading</th></tr></thead><tr><td>Cell introduction<p>Nested cell paragraph</p>Cell conclusion</td></tr></table>';
    f.upstream.entries.set(1, entry(1, content));
    await f.service.ingest.poll();
    await f.drain();
    expect(f.upstream.puts).toBe(1);
    expect(f.service.repository.entry(1)!.rendered_generation).toBe(1);
    expect(
      computeSourceIntegritySignature(
        f.upstream.entries.get(1)!.content,
        f.service.repository.artifacts(1),
      ),
    ).toEqual(computeSourceIntegritySignature(content));
  });
  it.each(['joint', 'translation', 'summary'])(
    'completes %s with stored Source intact and closed module boundaries',
    async (mode) => {
      const f = await setup(
        `${enabled}${mode === 'joint' ? '' : mode === 'translation' ? '    enabled: false\n' : '  translation:\n    enabled: false\n'}`,
      );
      await f.prepare();
      const source = entry();
      f.upstream.entries.set(1, source);
      const original = source.content;
      await f.service.ingest.poll();
      await f.drain();
      expect(f.service.repository.featureStates(1).map((s) => s.state)).toEqual(
        mode === 'joint' ? ['ready', 'ready'] : ['ready'],
      );
      expect(f.upstream.aiInputs).toHaveLength(1);
      expect(f.upstream.puts).toBe(1);
      const stored = f.service.repository.entry(1)!;
      expect(stored.rendered_generation).toBe(stored.render_generation);
      expect(await f.service.source.load(1)).toEqual({
        title: 'An interesting entry',
        content: original,
      });
      expect(
        computeSourceIntegritySignature(
          source.content,
          f.service.repository.artifacts(1),
        ),
      ).toEqual(computeSourceIntegritySignature(original));
      expect(
        f.upstream.requests.every((r) =>
          ['miniflux.test', 'ai.test'].includes(r.url.host),
        ),
      ).toBe(true);
      expect(
        f.upstream.requests.some((r) =>
          r.url.pathname.includes('fetch-content'),
        ),
      ).toBe(false);
      const dump =
        JSON.stringify(f.service.db.all('SELECT * FROM entries')) +
        JSON.stringify(f.service.db.all('SELECT * FROM tasks'));
      expect(dump).not.toContain(original);
      expect(dump).not.toContain(fixtureValues.ai_key);
      const admin = await f.app.inject({
        url: '/admin/entries/1',
        headers: auth,
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().render_status).toBe('current');
      expect((await f.app.inject({ url: '/metrics' })).body).toContain(
        'mfai_entries_rendered_total 1',
      );
    },
  );
  it('handles title-only Translation and an all-unchanged Artifact without duplicating Source', async () => {
    const f = await setup();
    await f.prepare();
    f.upstream.entries.set(1, entry(1, ''));
    f.upstream.aiHandler = (e) =>
      e.operation === 'generate_artifacts'
        ? chat({
            translation: { title: e.source.title, blocks: e.source.blocks },
          })
        : chat(generated(e));
    await f.service.ingest.poll();
    await f.drain();
    expect(f.service.repository.featureStates(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'translation', state: 'ready' }),
        expect.objectContaining({
          kind: 'summary',
          state: 'skipped',
          skip_reason: 'content_too_short',
        }),
      ]),
    );
    const artifact = f.service.repository.currentArtifacts(1)[0]!;
    expect(artifact.payload).toEqual({
      schema_version: 2,
      title: { status: 'unchanged' },
      blocks: [],
    });
    expect(f.upstream.entries.get(1)!.content).toBe('');
    expect(f.service.repository.entry(1)!.rendered_generation).toBe(1);
  });
  it('writes a translated title while preserving an empty stored body', async () => {
    const f = await setup();
    await f.prepare();
    f.upstream.entries.set(1, entry(1, ''));
    await f.service.ingest.poll();
    await f.drain();
    expect(f.upstream.entries.get(1)).toMatchObject({
      title: '译文标题（An interesting entry）',
      content: '',
    });
    expect(f.service.repository.entry(1)!.rendered_generation).toBe(1);
    expect(await f.service.source.load(1)).toEqual({
      title: 'An interesting entry',
      content: '',
    });
  });
  it('writes body Artifacts while preserving an empty stored title', async () => {
    const f = await setup();
    await f.prepare();
    const source = entry();
    source.title = '';
    const content = source.content;
    f.upstream.entries.set(1, source);
    await f.service.ingest.poll();
    await f.drain();
    expect(f.upstream.entries.get(1)!.title).toBe('');
    expect(f.service.repository.entry(1)!.rendered_generation).toBe(1);
    expect(await f.service.source.load(1)).toEqual({ title: '', content });
  });
  it('installs a valid sibling and keeps an exhausted invalid member independently requeueable', async () => {
    const f = await setup(`${enabled}queue:\n  retry:\n    max_attempts: 1\n`);
    await f.prepare();
    f.upstream.entries.set(1, entry());
    f.upstream.aiHandler = (e) => {
      const v = generated(e) as Record<string, unknown>;
      if ('summary' in v)
        v.summary = { format: 'paragraph', text: '<b>invalid model HTML</b>' };
      return chat(v);
    };
    await f.service.ingest.poll();
    await f.drain();
    expect(f.service.repository.featureStates(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'translation', state: 'ready' }),
        expect.objectContaining({ kind: 'summary', state: 'failed' }),
      ]),
    );
    const dead = f.service.repository.listTasks({
      state: 'dead',
      type: 'generate_artifacts',
    })[0]!;
    expect(dead.payload).toMatchObject({ requested_features: ['summary'] });
    expect(f.service.repository.requeueReason(dead)).toBeNull();
    f.upstream.aiHandler = (e) => chat(generated(e));
    f.service.repository.requeue(dead.id);
    await f.drain();
    expect(
      f.service.repository.featureStates(1).every((s) => s.state === 'ready'),
    ).toBe(true);
    expect(f.upstream.aiInputs.at(-1)).toMatchObject({
      requested_outputs: { summary: expect.anything() },
    });
    expect(f.service.repository.artifacts(1)).toHaveLength(2);
  });
  it('keeps a previous Artifact through replacement failure and removes it on intrinsic Skip', async () => {
    const f = await setup(`${enabled}queue:\n  retry:\n    max_attempts: 1\n`);
    await f.prepare();
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    await f.drain();
    const before = f.upstream.entries.get(1)!.content,
      old = f.service.repository
        .featureStates(1)
        .find((s) => s.kind === 'translation')!.current_artifact_id;
    f.upstream.aiHandler = () =>
      response({ error: { code: 'unauthorized' } }, 401);
    await f.service.reprocess(1, ['translation']);
    await f.drain();
    expect(
      f.service.repository
        .featureStates(1)
        .find((s) => s.kind === 'translation'),
    ).toMatchObject({ state: 'failed', current_artifact_id: old });
    expect(f.upstream.entries.get(1)!.content).toBe(before);
    f.service.db.run(
      "UPDATE entries SET primary_language='zh', language_confidence=1 WHERE entry_id=1",
    );
    await f.service.reprocess(1, ['translation']);
    await f.drain();
    expect(
      f.service.repository
        .featureStates(1)
        .find((s) => s.kind === 'translation'),
    ).toMatchObject({ state: 'skipped', current_artifact_id: null });
    expect(f.upstream.entries.get(1)!.content).not.toContain(
      'mfai-v1-translation',
    );
    expect(f.upstream.entries.get(1)!.content).toContain('mfai-v1-summary');
    const oldTask = f.service.repository.listTasks({
      state: 'dead',
      type: 'generate_artifacts',
    })[0]!;
    expect(f.service.repository.requeueReason(oldTask)).toEqual({
      code: 'task_superseded',
      reason: 'feature_superseded',
      feature: 'translation',
    });
  });
  it.each(['markers', 'body', 'title'])(
    'treats the PUT response as authority and rejects changed %s',
    async (mutation) => {
      const f = await setup('features:\n  summary:\n    enabled: false\n');
      await f.prepare();
      const original = entry();
      f.upstream.entries.set(1, original);
      await f.service.ingest.poll();
      f.upstream.intercept = (url, method, raw) => {
        if (url.pathname === '/v1/entries/1' && method === 'PUT') {
          const body = raw as { title: string; content: string };
          return response(
            {
              ...original,
              title: mutation === 'title' ? 'Changed title' : body.title,
              content:
                mutation === 'markers'
                  ? body.content.replace(/ id="[^"]*"/g, '')
                  : mutation === 'body'
                    ? body.content.replace(
                        'useful introduction',
                        'changed introduction',
                      )
                    : body.content,
            },
            201,
          );
        }
      };
      await f.drain();
      const dead = f.service.repository.listTasks({
        state: 'dead',
        type: 'render',
      })[0]!;
      expect(dead.last_error).toMatchObject({
        code: 'render_integrity_failed',
        miniflux_version: '2.3.3',
        integrity_stage:
          mutation === 'markers'
            ? 'put_response_markers'
            : mutation === 'body'
              ? 'put_response_source_signature'
              : 'put_response_title',
      });
      expect(f.service.repository.entry(1)!.rendered_generation).toBe(0);
    },
  );
});

describe('public, webhook and Admin boundaries', () => {
  it('authenticates the raw webhook before readiness, ignores unrelated events, and gates cursor bootstrap', async () => {
    const f = await setup();
    const body = JSON.stringify({ entries: [entry()] });
    expect((await f.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/webhook/miniflux',
          payload: body,
          headers: { ...signed(body), 'x-miniflux-signature': 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/webhook/miniflux',
          payload: 'not JSON',
          headers: signed('not JSON', 'save_entry'),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/webhook/miniflux',
          payload: body,
          headers: signed(body),
        })
      ).statusCode,
    ).toBe(503);
    await f.service.binding.check();
    expect(f.service.repository.cursor()).toBeUndefined();
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(503);
    await f.service.ingest.bootstrap();
    expect((await f.app.inject({ url: '/readyz' })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/admin/config' })).statusCode).toBe(401);
    const redacted = (
      await f.app.inject({ url: '/admin/config', headers: auth })
    ).body;
    expect(redacted).not.toContain(fixtureValues.ai_key);
    expect(redacted).not.toContain(fixtureValues.miniflux_key);
    const accepted = await f.app.inject({
      method: 'POST',
      url: '/webhook/miniflux',
      payload: body,
      headers: signed(body),
    });
    expect(accepted.statusCode).toBe(204);
    const first = f.service.repository.entry(1);
    const duplicate = JSON.stringify({
      entries: [{ ...entry(), title: 'Changed' }],
    });
    await f.app.inject({
      method: 'POST',
      url: '/webhook/miniflux',
      payload: duplicate,
      headers: signed(duplicate),
    });
    expect(f.service.repository.entry(1)).toEqual(first);
    expect(
      f.upstream.requests.filter((r) => r.url.pathname === '/v1/feeds/1'),
    ).toHaveLength(1);
  });
  it('rolls back a webhook enrichment failure, then lets polling recover valid siblings and reject bad metadata', async () => {
    const f = await setup();
    await f.prepare();
    f.upstream.feeds.set(2, feed(2));
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/feeds/2' ? response({}, 503) : undefined;
    await expect(
      f.service.ingest.webhook({
        entries: [entry(1), entry(2, '<p>Second body</p>', 2)],
      }),
    ).rejects.toThrow();
    expect(f.service.repository.entry(1)).toBeUndefined();
    f.upstream.intercept = undefined;
    f.upstream.entries.set(1, entry(1));
    f.upstream.entries.set(2, {
      ...entry(2),
      published_at: '2026-02-30T00:00:00Z',
    });
    f.upstream.entries.set(3, entry(3));
    await f.service.ingest.poll();
    expect(f.service.repository.entry(1)).toBeDefined();
    expect(f.service.repository.entry(2)).toBeUndefined();
    expect(f.service.repository.entry(3)).toBeDefined();
    expect(f.service.repository.cursor()).toBe(3);
    expect(f.service.ingest.status.rejected_entry_count).toBe(1);
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/entries'
        ? response({
            entries: [
              entry(4),
              { ...entry(5), id: Number.MAX_SAFE_INTEGER + 1 },
            ],
          })
        : undefined;
    await expect(f.service.ingest.poll()).rejects.toThrow(
      'miniflux_entry_id_out_of_range',
    );
    expect(f.service.repository.entry(4)).toBeUndefined();
    expect(f.service.repository.cursor()).toBe(3);
  });
  it('creates resumable dry-run Backfill, then admits only missing state on live Backfill', async () => {
    const f = await setup('features:\n  summary:\n    enabled: false\n');
    f.upstream.entries.set(1, entry());
    f.upstream.entries.set(2, entry(2));
    await f.prepare();
    expect(f.service.repository.cursor()).toBe(2);
    const request = { limit: 10, features: ['translation'], dry_run: true };
    const created = await f.app.inject({
      method: 'POST',
      url: '/admin/backfill',
      headers: auth,
      payload: request,
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().id as number;
    expect(f.service.repository.task(id)!.progress).toMatchObject({
      after_entry_id: 0,
      examined_entries: 0,
    });
    await f.drain();
    expect(f.service.repository.entry(1)).toBeUndefined();
    expect(f.service.repository.task(id)!.progress).toMatchObject({
      after_entry_id: 2,
      examined_entries: 2,
      admitted_entries: 2,
    });
    const status = await f.app.inject({
      url: `/admin/backfill/${id}`,
      headers: auth,
    });
    expect(status.body).not.toContain('instruction');
    expect(status.body).not.toContain('ai.test');
    await f.app.inject({
      method: 'POST',
      url: '/admin/backfill',
      headers: auth,
      payload: { ...request, dry_run: false },
    });
    await f.drain();
    const artifacts = f.service.repository.artifacts(1);
    expect(artifacts).toHaveLength(1);
    await f.app.inject({
      method: 'POST',
      url: '/admin/backfill',
      headers: auth,
      payload: { ...request, dry_run: false },
    });
    await f.drain();
    expect(f.service.repository.artifacts(1)).toEqual(artifacts);
    const disabled = await f.app.inject({
      method: 'POST',
      url: '/admin/entries/1/reprocess',
      headers: auth,
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().code).toBe('feature_disabled');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/admin/rules/dry-run',
          headers: auth,
          payload: { feature: 'summary', entry_id: 1 },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('schedules Summary only after the Entry generation mutex opens and never replaces current output', async () => {
    const f = await setup(`${enabled}    schedule:\n      cron: '0 2 * * *'\n`);
    await f.prepare();
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    expect(f.service.repository.featureStates(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', state: 'scheduled' }),
      ]),
    );
    expect(await f.service.summaries()).toBe(0);
    await f.drain();
    expect(await f.service.summaries()).toBe(1);
    await f.drain();
    expect(await f.service.summaries()).toBe(0);
    expect(f.service.repository.artifacts(1)).toHaveLength(2);
  });
});
