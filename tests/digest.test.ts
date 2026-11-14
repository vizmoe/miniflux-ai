import { afterEach, describe, expect, it } from 'vitest';
import { createService } from '../src/runtime/service.js';
import { digestSnapshot } from '../src/config/snapshots.js';
import { DigestRepository } from '../src/db/digest.js';
import { WorkError } from '../src/obs/errors.js';
import {
  config,
  writeConfiguration,
  compact,
  entry,
  feed,
  serviceFixture,
  response,
  chat,
  generated,
  temporaryRepository,
  auth,
} from './helpers.js';

const end = Date.parse('2026-09-04T00:00:00Z');
const yaml = (partition = 'all', extra = '') =>
  `features:\n  translation:\n    enabled: false\n  summary:\n    enabled: false\n  digest:\n    public_base_url: https://digest.test\n    jobs:\n      - id: daily\n        cron: '0 2 * * *'\n        min_item_source_units: 0\n        ${extra}\n        output:\n          partition_by: ${partition}\n          feed_title_template: '${partition === 'all' ? 'Daily news' : '{category_title} digest'}'\n`;
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function setup(partition = 'all', extra = '') {
  const f = await serviceFixture(yaml(partition, extra));
  closers.push(() => f.close());
  await f.prepare();
  for (let i = 1; i <= 3; i++)
    f.upstream.entries.set(
      i,
      entry(
        i,
        '<p>The first sentence explains a topic. A second sentence adds useful detail.</p>',
        i === 3 ? 2 : 1,
        i === 3 ? 8 : 7,
      ),
    );
  f.upstream.feeds.set(2, feed(2, 8));
  await f.service.ingest.poll();
  return f;
}

describe('Digest selection, provisioning and two-stage import', () => {
  it('always runs Stage 1 on a matching ready Summary without reloading the Source', async () => {
    const f = await serviceFixture(
      yaml().replace(
        '  summary:\n    enabled: false',
        '  summary:\n    enabled: true\n    min_source_units: 1\n    format: bullets',
      ),
    );
    closers.push(() => f.close());
    await f.prepare();
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    await f.drain();
    f.upstream.entries.delete(1);
    f.upstream.requests.length = 0;
    f.upstream.aiInputs.length = 0;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    await f.drain();
    expect(f.service.digestRepository.runs(selected.window.id)[0]!.state).toBe(
      'imported',
    );
    expect(f.upstream.aiInputs.map((e) => e.operation)).toEqual([
      'generate_digest_item',
      'generate_digest_overview',
    ]);
    expect(f.upstream.aiInputs[0]).toMatchObject({
      context: { input_kind: 'summary_artifact' },
      input: { text: '文章摘要。' },
    });
    expect(
      f.upstream.requests.some((r) => r.url.pathname === '/v1/entries/1'),
    ).toBe(false);
  });
  it('fails the whole partition permanently when a frozen candidate Source is gone', async () => {
    const f = await setup();
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    f.upstream.entries.delete(1);
    await f.drain();
    const run = f.service.digestRepository.runs(selected.window.id)[0]!;
    expect(run.state).toBe('failed');
    expect(f.service.digestRepository.taskForRun(run.id)).toMatchObject({
      state: 'dead',
      last_error: { failure_class: 'not_found', retryable: false },
    });
    expect(f.upstream.imports.size).toBe(0);
    expect(
      f.service.digestRepository.candidates(run.id).map((e) => e.entry_id),
    ).toEqual([3, 2, 1]);
  });
  it('retains category partition identity and Feed title while the next window captures a renamed category', async () => {
    const f = await setup('category');
    const first = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    await f.drain();
    const older = f.service.digestRepository
      .runs(first.window.id)
      .find((r) => r.partition_key === 'category:7')!;
    const feedBefore = f.service.digestRepository.feed('daily', 'category:7')!;
    f.service.repository.insertEntry(
      compact(50000, {
        published_at: end + 1000,
        source_category_title: 'Renamed News',
      }),
    );
    const next = await f.service.digest.select(
      'daily',
      end + 86400000,
      'manual',
    );
    const newer = f.service.digestRepository.runs(next.window.id)[0]!;
    expect(newer).toMatchObject({
      partition_key: older.partition_key,
      source_category_title: 'Renamed News',
    });
    expect(
      f.service.digestRepository.run(older.id)!.source_category_title,
    ).toBe('Category 7');
    const feedAfter = f.service.digestRepository.feed('daily', 'category:7')!;
    expect(feedAfter.feed_url).toBe(feedBefore.feed_url);
    expect(feedAfter.feed_title).toBe(feedBefore.feed_title);
  });
  it('keeps indefinite Feed retry backoff across explicit scans and restart', async () => {
    const f = await setup();
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/feeds' ? response({}, 503) : undefined;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    const before = f.upstream.requests.length;
    for (let pass = 0; pass < 8; pass++) await f.service.digest.reconcile();
    expect(f.upstream.requests).toHaveLength(before);
    expect(
      f.service.digestRepository.taskForRun(
        f.service.digestRepository.runs(selected.window.id)[0]!.id,
      ),
    ).toBeUndefined();
    await f.service.stop();
    const restarted = await createService(f.service.configuration, {
      root: f.root,
      fetch: f.upstream.fetch,
      logger: { log() {} },
    });
    closers.push(() => restarted.stop());
    await restarted.binding.check();
    const afterBinding = f.upstream.requests.length;
    await restarted.digest.reconcile();
    expect(f.upstream.requests).toHaveLength(afterBinding);
    for (let attempt = 0; attempt < 10; attempt++) {
      restarted.db.run('UPDATE digest_output_feeds SET next_attempt_at=0');
      await restarted.digest.reconcile();
    }
    expect(restarted.digestRepository.feed('daily', 'all')!.state).toBe(
      'degraded',
    );
    f.upstream.intercept = undefined;
    restarted.db.run('UPDATE digest_output_feeds SET next_attempt_at=0');
    await restarted.digest.reconcile();
    await restarted.digest.activate();
    expect(
      restarted.digestRepository.taskForRun(
        restarted.digestRepository.runs(selected.window.id)[0]!.id,
      ),
    ).toMatchObject({ state: 'pending', attempts: 0 });
  });
  it.each(['all', 'category'])(
    'freezes candidates and imports %s partitions with zero-entry feeds and retained permalinks',
    async (partition) => {
      const f = await setup(partition);
      const selected = await f.service.digest.select('daily', end, 'manual');
      await f.service.digest.reconcile();
      await f.service.digest.activate();
      await f.drain();
      const runs = f.service.digestRepository.runs(selected.window.id);
      expect(runs).toHaveLength(partition === 'all' ? 1 : 2);
      expect(runs.every((r) => r.state === 'imported')).toBe(true);
      expect(runs.reduce((n, r) => n + r.item_count!, 0)).toBe(3);
      expect(
        f.upstream.aiInputs.filter(
          (e) => e.operation === 'generate_digest_item',
        ),
      ).toHaveLength(3);
      for (const run of runs) {
        const stored = f.upstream.entries.get(run.miniflux_entry_id!)!,
          candidates = f.service.digestRepository.candidates(run.id);
        for (const e of candidates)
          expect(stored.content).toContain(`href="${e.entry_url}"`);
        expect(stored.content).toContain('本期内容概览');
        expect(stored.content).toContain('简短摘要');
        expect(stored.content).toContain('2026-09-04');
        expect(run.ai_stats.request_count).toBe(candidates.length + 1);
        const path =
          partition === 'all'
            ? '/digest/feeds/daily.xml'
            : `/digest/feeds/daily/categories/${run.source_category_id}.xml`;
        const atom = await f.app.inject({ url: path });
        expect(atom.statusCode).toBe(200);
        expect(atom.body).not.toContain('<entry');
        const link = await f.app.inject({
          url:
            partition === 'all'
              ? '/digest/daily/2026-09-04?evil=ignored'
              : `/digest/daily/categories/${run.source_category_id}/2026-09-04?evil=ignored`,
        });
        expect(link.statusCode).toBe(302);
        expect(link.headers.location).toBe(
          `https://miniflux.test/feed/${run.output_feed_id}/entry/${run.miniflux_entry_id}`,
        );
        expect(link.body).toBe('');
        expect(link.headers['cache-control']).toBe('no-store');
      }
      const count = f.upstream.aiInputs.length;
      await f.service.digest.select('daily', end, 'manual');
      await f.drain();
      expect(f.upstream.aiInputs).toHaveLength(count);
      const persisted =
        JSON.stringify(f.service.db.all('SELECT * FROM digest_runs')) +
        JSON.stringify(
          f.service.db.all('SELECT * FROM digest_run_candidates'),
        ) +
        JSON.stringify(f.service.db.all('SELECT * FROM tasks'));
      expect(persisted).not.toContain('简短摘要');
      expect(persisted).not.toContain('本期内容概览');
      expect(persisted).not.toContain('<p>The first sentence');
      for (const path of [
        '/digest/daily/2026-02-30',
        '/digest/missing/2026-09-04',
        '/digest/feeds/daily/categories/0.xml',
        '/digest/feeds/daily/categories/07.xml',
      ])
        expect((await f.app.inject({ url: path })).statusCode).toBe(404);
      expect(
        (await f.app.inject({ url: '/admin/digests', headers: auth })).body,
      ).not.toContain('config_snapshot');
    },
  );
  it('waits without a task or attempts, then activates the original window snapshot', async () => {
    const f = await setup();
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/feeds' ? response({}, 503) : undefined;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    const run = f.service.digestRepository.runs(selected.window.id)[0]!;
    expect(f.service.digestRepository.taskForRun(run.id)).toBeUndefined();
    expect(f.service.digestRepository.waiting(run, true)).toMatchObject({
      awaiting_output_feed: true,
      task_state: null,
    });
    expect(f.service.digest.status().output_feeds[0]!.state).toBe('degraded');
    const newer = entry(4);
    f.upstream.entries.set(4, newer);
    await f.service.ingest.poll();
    await f.service.digest.select('daily', end, 'manual');
    expect(
      f.service.digestRepository.candidates(run.id).map((e) => e.entry_id),
    ).toEqual([3, 2, 1]);
    f.upstream.intercept = undefined;
    f.service.db.run('UPDATE digest_output_feeds SET next_attempt_at=0');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    const task = f.service.digestRepository.taskForRun(run.id)!;
    expect(task).toMatchObject({
      state: 'pending',
      attempts: 0,
      payload: { config_snapshot: selected.window.config_snapshot },
    });
    await f.drain();
    expect(f.service.digestRepository.run(run.id)!.state).toBe('imported');
  });
  it('applies exclusions before per-feed/global caps and freezes category presentation at selection', async () => {
    const f = await setup(
      'category',
      'max_entries: 1\n        max_entries_per_feed: 1',
    );
    f.service.repository.insertEntry(
      compact(4, { source_title: ' ', category_id: 7 }),
    );
    f.service.repository.insertEntry(
      compact(5, { entry_url: 'file:///not-http', category_id: 7 }),
    );
    const selected = await f.service.digest.select('daily', end, 'manual');
    const runs = f.service.digestRepository.runs(selected.window.id);
    const category = runs.find((r) => r.partition_key === 'category:7')!;
    expect(category.dropped_count).toBe(1);
    expect(
      f.service.digestRepository.candidates(category.id).map((e) => e.entry_id),
    ).toEqual([2]);
    f.service.repository.insertEntry(
      compact(6, { category_id: 9, source_category_title: 'Uncategorized' }),
    );
    const repeated = await f.service.digest.select('daily', end, 'manual');
    expect(f.service.digestRepository.runs(repeated.window.id)).toHaveLength(3);
    expect(
      f.service.digestRepository.run(category.id)!.source_category_title,
    ).toBe('Category 7');
    expect(
      f.service.digestRepository.feed('daily', 'category:9')!.feed_url,
    ).toBe('https://digest.test/digest/feeds/daily/categories/9.xml');
    const metrics = (await f.app.inject({ url: '/metrics' })).body;
    expect(metrics).toContain('reason="source_title_missing"');
    expect(metrics).toContain('reason="entry_url_invalid"');
  });
  it('retries a failed import from every original candidate without caching generated content', async () => {
    const f = await setup();
    let failing = true;
    f.upstream.intercept = (url) =>
      failing && url.pathname.endsWith('/entries/import')
        ? response({}, 503)
        : undefined;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    await f.drain();
    const run = f.service.digestRepository.runs(selected.window.id)[0]!,
      task = f.service.digestRepository.taskForRun(run.id)!;
    expect(task.state).toBe('pending');
    expect(task.attempts).toBe(1);
    const beforeCalls = f.upstream.aiInputs.length;
    f.upstream.entries.set(4, entry(4));
    await f.service.ingest.poll();
    await f.service.digest.select('daily', end, 'manual');
    failing = false;
    f.service.db.run(
      'UPDATE tasks SET run_after=? WHERE id=?',
      Date.now(),
      task.id,
    );
    await f.drain();
    expect(f.upstream.aiInputs.length - beforeCalls).toBe(4);
    expect(
      f.service.digestRepository.candidates(run.id).map((e) => e.entry_id),
    ).toEqual([3, 2, 1]);
    expect(f.service.digestRepository.run(run.id)!.ai_stats.request_count).toBe(
      8,
    );
    expect(f.upstream.imports.size).toBe(1);
  });
  it.each([
    'missing_id',
    'duplicate_id',
    'unknown_id',
    'prose_url',
    'item_url',
    'item_failure',
  ])(
    'fails %s without importing or persisting partials, then regenerates on requeue',
    async (fault) => {
      const f = await setup();
      f.service.config.queue.retry.max_attempts = 1;
      f.upstream.aiHandler = (e) => {
        if (e.operation === 'generate_digest_item') {
          if (fault === 'item_failure') return response({}, 401);
          if (fault === 'item_url')
            return chat({ summary: 'https://invented.test' });
        }
        if (e.operation === 'generate_digest_overview') {
          const ids = e.items.map((i) => i.id);
          return chat({
            overview: fault === 'prose_url' ? 'https://invented.test' : '概览',
            sections: [
              {
                title: '要点',
                item_ids:
                  fault === 'missing_id'
                    ? ids.slice(1)
                    : fault === 'duplicate_id'
                      ? [...ids, ids[0]]
                      : fault === 'unknown_id'
                        ? [...ids.slice(1), 999]
                        : ids,
              },
            ],
          });
        }
        return chat(generated(e));
      };
      const selected = await f.service.digest.select('daily', end, 'manual');
      await f.service.digest.reconcile();
      await f.service.digest.activate();
      await f.drain();
      const run = f.service.digestRepository.runs(selected.window.id)[0]!;
      expect(run.state).toBe('failed');
      expect(f.upstream.imports.size).toBe(0);
      const task = f.service.digestRepository.taskForRun(run.id)!;
      expect(task.state).toBe('dead');
      const count = f.upstream.aiInputs.length;
      await f.service.digest.select('daily', end, 'manual');
      await f.drain();
      expect(f.upstream.aiInputs).toHaveLength(count);
      f.upstream.aiHandler = (e) => chat(generated(e));
      if (fault === 'item_failure') {
        const current = f.service.configuration.read();
        f.service.configuration.updateAi(current.revision, (ai) => ({
          ...ai,
          providers: ai.providers.map((p) => ({
            ...p,
            api_key: 'corrected-key',
          })),
        }));
      }
      f.service.repository.requeue(task.id);
      await f.drain();
      expect(f.service.digestRepository.run(run.id)!.state).toBe('imported');
      expect(f.upstream.aiInputs.length - count).toBe(4);
    },
  );
  it('tombstones a run permanently and reports that reason before any partition conflict', async () => {
    const f = await setup();
    f.upstream.intercept = (url) =>
      url.pathname.endsWith('/entries/import')
        ? response({ error_message: 'ErrEntryTombstoned' }, 400)
        : undefined;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    await f.drain();
    const run = f.service.digestRepository.runs(selected.window.id)[0]!,
      task = f.service.digestRepository.taskForRun(run.id)!;
    expect(run.state).toBe('tombstoned');
    expect(task.state).toBe('dead');
    expect(f.service.repository.requeueReason(task)).toEqual({
      code: 'task_superseded',
      reason: 'run_tombstoned',
    });
    expect(() => f.service.repository.requeue(task.id)).toThrow(
      'task_superseded',
    );
  });
  it('performs model merges for split items and split overview batches', async () => {
    const f = await setup();
    const attempted = new Set<number>();
    f.upstream.aiHandler = (e) => {
      if (
        e.operation === 'generate_digest_item' &&
        !attempted.has(e.context.entry_id)
      ) {
        attempted.add(e.context.entry_id);
        return response({}, 413);
      }
      if (e.operation === 'generate_digest_overview' && e.items.length > 1)
        return response({}, 413);
      return chat(generated(e));
    };
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    await f.service.digest.activate();
    await f.drain();
    expect(f.service.digestRepository.runs(selected.window.id)[0]!.state).toBe(
      'imported',
    );
    expect(
      f.upstream.aiInputs.filter(
        (e) => e.operation === 'merge_digest_item_partials',
      ),
    ).toHaveLength(3);
    expect(
      f.upstream.aiInputs.some(
        (e) => e.operation === 'merge_digest_overview_partials',
      ),
    ).toBe(true);
  });
  it('validates manual partition and UTC bounds before committing any window', async () => {
    const f = await setup();
    for (const body of [
      { job_id: 'daily', window_end: '2099-01-01T00:00:00Z' },
      { job_id: 'daily', window_end: '2026-02-30T00:00:00Z' },
      {
        job_id: 'daily',
        window_end: '2026-09-04T00:00:00Z',
        partition_key: 'category:7',
      },
    ])
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/admin/digests/run',
            headers: auth,
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
    expect(f.service.digestRepository.windows()).toEqual([]);
    await f.service.digest.select('daily', end, 'manual');
    await expect(
      f.service.digest.select('daily', end + 1000, 'manual'),
    ).rejects.toThrow('digest_window_conflict');
  });
});
describe('Digest repository recovery invariants', () => {
  it('freezes window and candidate identities, selects newly discovered partitions, and serializes dates per partition', () => {
    const f = temporaryRepository();
    closers.push(() => f.close());
    const d = new DigestRepository(f.repository),
      c = config(yaml()),
      snapshot = digestSnapshot(c, c.features.digest.jobs[0]!);
    f.repository.insertEntry(compact());
    const first = d.claimWindow(snapshot, end, 86400000, 'manual').window;
    d.select(first.id);
    const run = d.runs(first.id)[0]!;
    expect(d.activate(() => false)).toBe(0);
    expect(d.taskForRun(run.id)).toBeUndefined();
    expect(d.waiting(run, false)).toMatchObject({
      waiting_for_import_capability: true,
      awaiting_output_feed: true,
    });
    expect(() =>
      f.db.run(
        'UPDATE digest_windows SET config_snapshot=config_snapshot WHERE id=?',
        first.id,
      ),
    ).toThrow('digest_window_immutable');
    expect(() =>
      f.db.run(
        'UPDATE digest_run_candidates SET selection_position=1 WHERE digest_run_id=?',
        run.id,
      ),
    ).toThrow('digest_candidate_immutable');
    expect(() => d.markFeed('daily', 'all', 'ready', null, null)).toThrow();
    d.markFeed('daily', 'all', 'ready', null, null, { id: 100, categoryId: 1 });
    expect(d.activate(() => true)).toBe(1);
    expect(d.activate(() => true)).toBe(0);
    expect(d.taskForRun(run.id)!.attempts).toBe(0);
    f.repository.insertEntry(compact(2, { published_at: end + 1000 }));
    const second = d.claimWindow(
      snapshot,
      end + 86400000,
      86400000,
      'manual',
    ).window;
    d.select(second.id);
    const waiting = d.runs(second.id)[0]!;
    expect(d.activate(() => true)).toBe(0);
    expect(d.waiting(waiting, true).waiting_for_partition).toBe(true);
    f.repository.settle(
      f.repository.claim(4, 100)!,
      new WorkError('bad_request', 'invalid_request', false),
    );
    expect(d.activate(() => true)).toBe(1);
    expect(f.repository.requeueReason(d.taskForRun(run.id)!)).toEqual({
      code: 'digest_partition_busy',
    });
  });
  it('recovers claimed work after disabling jobs and rejects a changed registry URL without reprovisioning', async () => {
    const f = await setup();
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/feeds' ? response({}, 503) : undefined;
    const selected = await f.service.digest.select('daily', end, 'manual');
    await f.service.digest.reconcile();
    const original = selected.window.config_snapshot;
    await f.service.stop();
    const restartedConfig = config(
      yaml().replace('https://digest.test', 'https://changed.test'),
    );
    restartedConfig.ai.providers[0]!.model = 'model-b';
    const changed = await createService(
      writeConfiguration(f.root, restartedConfig),
      {
        root: f.root,
        fetch: f.upstream.fetch,
        logger: { log() {} },
      },
    );
    await changed.binding.check();
    f.upstream.intercept = undefined;
    changed.db.run('UPDATE digest_output_feeds SET next_attempt_at=0');
    await changed.digest.reconcile();
    expect(changed.digestRepository.feed('daily', 'all')!).toMatchObject({
      feed_url: 'https://digest.test/digest/feeds/daily.xml',
      reason: 'feed_url_mismatch',
    });
    expect(
      f.upstream.requests.filter(
        (r) => r.method === 'POST' && r.url.pathname === '/v1/feeds',
      ),
    ).toHaveLength(0);
    await changed.stop();
    const disabled = await createService(
      writeConfiguration(
        f.root,
        config('features:\n  digest:\n    enabled: false\n'),
      ),
      { root: f.root, fetch: f.upstream.fetch, logger: { log() {} } },
    );
    closers.push(() => disabled.stop());
    await disabled.binding.check();
    await disabled.digest.resumeWindows();
    disabled.db.run('UPDATE digest_output_feeds SET next_attempt_at=0');
    await disabled.digest.reconcile();
    await disabled.digest.activate();
    const run = disabled.digestRepository.runs(selected.window.id)[0]!;
    expect(disabled.digestRepository.taskForRun(run.id)!.payload).toMatchObject(
      { config_snapshot: original },
    );
    disabled.queue.tick();
    await disabled.queue.idle();
    expect(disabled.digestRepository.run(run.id)!.state).toBe('imported');
    await expect(
      disabled.digest.select('daily', end + 86400000, 'manual'),
    ).rejects.toThrow('feature_disabled');
  });
});
