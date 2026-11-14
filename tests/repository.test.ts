import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { backoff, type ArtifactInput } from '../src/db/repository.js';
import { WorkError } from '../src/obs/errors.js';
import {
  generationSnapshot,
  backfillSpecs,
  retrySnapshot,
  digestSnapshot,
} from '../src/config/snapshots.js';
import * as D from '../src/db/documents.js';
import { artifactStats } from '../src/ai/stats.js';
import { config, compact, temporaryRepository } from './helpers.js';

const fixtures: ReturnType<typeof temporaryRepository>[] = [];
function setup(now?: () => number) {
  const f = temporaryRepository(now);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const c = config(
  'queue:\n  retry:\n    jitter_ratio: 0\n    initial_delay: 1s\n    max_attempts: 2\n',
);
const payload = generationSnapshot(c, ['translation', 'summary'], 200);
function admitted(
  f: ReturnType<typeof setup>,
  id = 1,
  kinds: D.FeatureKind[] = ['translation', 'summary'],
) {
  f.repository.insertEntry(compact(id));
  return f.repository.admit(
    id,
    kinds.map((kind) => ({ kind, state: 'pending', skip_reason: null })),
    generationSnapshot(c, kinds, 200),
  ).task!;
}
export const stats = artifactStats([
  {
    provider_id: 'primary',
    model: 'test-model',
    operation: 'generate_artifacts',
    duration_ms: 1,
    finish_reason: 'stop',
    usage: null,
    outcome: 'succeeded',
  },
]);
const summary = {
  kind: 'summary' as const,
  output_language: 'zh-CN',
  payload: { schema_version: 1, format: 'paragraph', text: '摘要' },
  render_spec: { schema_version: 1, heading: 'Heading' },
  ai_stats: stats,
} satisfies ArtifactInput;

describe('SQLite ownership, immutable ingest facts and lineage', () => {
  it('owns a kernel lock before migrating and reopens after release', () => {
    const f = setup();
    expect(() => new Database(f.root)).toThrow('instance_lock_unavailable');
    expect(f.db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(f.db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(f.db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    f.db.close();
    const reopened = new Database(f.root);
    expect(reopened.ping()).toBe(true);
    reopened.close();
  });
  it('preserves first-ingest data and rolls back admission with its parent transaction', () => {
    const f = setup();
    f.repository.insertEntry(compact());
    expect(
      f.repository.insertEntry(compact(1, { source_title: 'Later title' })),
    ).toBe(false);
    expect(f.repository.entry(1)!.source_title).toBe('An interesting entry');
    expect(() =>
      f.db.transaction(() => {
        admitted(f, 2);
        throw new Error('fault');
      }),
    ).toThrow('fault');
    expect(f.repository.entry(2)).toBeUndefined();
    expect(f.repository.listTasks()).toEqual([]);
    for (const bad of [
      { source_content_units: -1 },
      { category_id: 0 },
      { source_category_title: '' },
      { primary_language: null, language_confidence: 1 },
      { source_content: 'must never persist' },
    ])
      expect(() =>
        f.repository.insertEntry({ ...compact(3), ...bad }),
      ).toThrow();
    for (const sql of [
      'UPDATE entries SET source_content_units=-1',
      'UPDATE entries SET category_id=0',
      "UPDATE entries SET source_category_title=''",
    ])
      expect(() => f.db.run(sql)).toThrow();
  });
  it('enforces the one-active-generation mutex and canonical Feature domain', () => {
    const f = setup();
    const task = admitted(f);
    expect(() =>
      f.repository.admit(
        1,
        [{ kind: 'summary', state: 'pending', skip_reason: null }],
        payload,
      ),
    ).toThrow('generation_in_progress');
    expect(() =>
      f.repository.createTask('generate_artifacts', task.dedup_key, 1, payload),
    ).toThrow();
    expect(() =>
      f.db.run("UPDATE tasks SET state='cancelled' WHERE id=?", task.id),
    ).toThrow();
    expect(() =>
      f.db.run(
        "UPDATE entry_feature_states SET state='scheduled' WHERE kind='translation'",
      ),
    ).toThrow();
    expect(() =>
      f.db.run("UPDATE entry_feature_states SET kind='digest'"),
    ).toThrow();
    expect(() =>
      f.db.run(
        "UPDATE entry_feature_states SET state='skipped',skip_reason='disabled'",
      ),
    ).toThrow();
  });
  it('fences expired workers and preserves the consumed attempt across recovery', () => {
    let now = 1000;
    const f = setup(() => now);
    const pending = admitted(f),
      a = f.repository.claim(4, 100)!;
    expect(a.attempts).toBe(1);
    expect(
      f.repository.featureStates(1).every((s) => s.state === 'processing'),
    ).toBe(true);
    now = 1050;
    f.repository.renew(a, 100);
    now = 1149;
    expect(f.repository.reap()).toBe(0);
    now = 1150;
    expect(f.repository.reap()).toBe(1);
    expect(f.repository.task(pending.id)).toMatchObject({
      state: 'pending',
      attempts: 1,
      run_after: 2150,
    });
    expect(() => f.repository.assertOwner(a)).toThrow();
    expect(f.repository.claim(4, 100)).toBeUndefined();
    now = 2150;
    const b = f.repository.claim(4, 100)!;
    expect(b.lease_owner).not.toBe(a.lease_owner);
    expect(b.attempts).toBe(2);
    expect(() =>
      f.repository.completeGeneration(a, [summary], {
        translation: new WorkError('invalid', 'validation', true),
      }),
    ).toThrow();
    now = 3000;
    expect(f.repository.reap()).toBe(1);
    expect(f.repository.task(b.id)!.state).toBe('dead');
    expect(
      f.repository.featureStates(1).every((s) => s.state === 'failed'),
    ).toBe(true);
    const resumed = f.repository.requeue(b.id);
    expect(resumed).toMatchObject({ state: 'pending', attempts: 0, payload });
  });
  it('installs only complete validated Artifacts and retains prior output across failures', () => {
    const f = setup();
    admitted(f, 1, ['summary']);
    const task = f.repository.claim(4, 100)!;
    const invalid = {
      ...summary,
      payload: { ...summary.payload, text: 'valid', source: 'forbidden' },
    };
    expect(() =>
      f.repository.completeGeneration(task, [invalid], {}),
    ).toThrow();
    expect(f.repository.artifacts(1)).toEqual([]);
    f.repository.completeGeneration(task, [summary], {});
    const current = f.repository.currentArtifacts(1)[0]!;
    expect(current.marker_token).toMatch(/^[a-f0-9]{32}$/);
    expect(f.repository.readySummary(1, 'zh-CN')).toEqual(summary.payload);
    expect(f.repository.readySummary(1, 'en')).toBeUndefined();
    f.repository.admit(
      1,
      [{ kind: 'summary', state: 'pending', skip_reason: null }],
      generationSnapshot(c, ['summary'], 200),
    );
    const render = f.repository.claim(4, 100)!;
    f.repository.settle(render, 'done');
    const replacement = f.repository.claim(4, 100)!;
    f.repository.settle(replacement, new WorkError('ai_auth', 'auth', false));
    expect(f.repository.currentArtifacts(1)[0]!.id).toBe(current.id);
    expect(f.repository.readySummary(1, 'zh-CN')).toBeUndefined();
    f.repository.requeue(replacement.id);
    expect(f.repository.currentArtifacts(1)[0]!.id).toBe(current.id);
  });
  it('reserves a foreground worker and orders requests by priority, creation time and ID', () => {
    const f = setup();
    const backfill: D.BackfillPayload = {
      schema_version: 1,
      ...backfillSpecs(c, ['translation']),
      since_ms: null,
      until_ms: null,
      feed_ids: [],
      category_ids: [],
      limit: 10,
      dry_run: true,
      page_size: 100,
    };
    const bg1 = f.repository.createTask(
      'ingest_backfill',
      'backfill:1',
      null,
      backfill,
      D.emptyBackfillProgress(),
    );
    f.repository.createTask(
      'ingest_backfill',
      'backfill:2',
      null,
      backfill,
      D.emptyBackfillProgress(),
    );
    expect(f.repository.claim(2, 100)!.id).toBe(bg1.id);
    expect(f.repository.claim(2, 100)).toBeUndefined();
    const fg = admitted(f);
    expect(f.repository.claim(2, 100)!.id).toBe(fg.id);
    expect(f.repository.claim(2, 100)).toBeUndefined();
  });
  it('writes ready output before older queued model work and then resumes generation', () => {
    let now = 1000;
    const f = setup(() => now);
    const generation = admitted(f, 1);
    now++;
    f.repository.insertEntry(compact(2));
    f.repository.requestRender(2, retrySnapshot(c));
    f.repository.insertEntry(compact(3));
    f.repository.requestRender(3, retrySnapshot(c));
    const first = f.repository.claim(1, 100)!;
    expect(first.type).toBe('render');
    expect(first.entry_id).toBe(2);
    expect(f.repository.claim(1, 100)).toBeUndefined();
    f.repository.completeRender(first, 1);
    const second = f.repository.claim(1, 100)!;
    expect(second.type).toBe('render');
    expect(second.entry_id).toBe(3);
    f.repository.settle(second, new WorkError('transient', 'network', true));
    expect(f.repository.claim(1, 100)!.id).toBe(generation.id);
  });
  it.each([
    'pending',
    'processing',
    'scheduled',
    'ready',
    'skipped',
    'missing',
    'failed_newer',
  ])('rejects dead Summary task after Feature becomes %s', (state) => {
    const f = setup();
    const old = admitted(f, 1, ['summary']),
      leased = f.repository.claim(4, 100)!;
    f.repository.settle(leased, new WorkError('invalid', 'validation', false));
    if (state === 'missing')
      f.db.run('DELETE FROM entry_feature_states WHERE entry_id=1');
    else if (state === 'failed_newer') {
      const newer = f.repository.admit(
        1,
        [{ kind: 'summary', state: 'pending', skip_reason: null }],
        generationSnapshot(c, ['summary'], 200),
      ).task!;
      f.repository.settle(
        f.repository.claim(4, 100)!,
        new WorkError('invalid', 'validation', false),
      );
      expect(newer.id).not.toBe(old.id);
    } else if (state === 'ready') {
      f.repository.requeue(old.id);
      f.repository.completeGeneration(
        f.repository.claim(4, 100)!,
        [summary],
        {},
      );
      f.db.run("UPDATE tasks SET state='dead' WHERE id=?", old.id);
    } else
      f.db.run(
        'UPDATE entry_feature_states SET state=?,skip_reason=? WHERE entry_id=1',
        state,
        state === 'skipped' ? 'content_too_short' : null,
      );
    expect(f.repository.requeueReason(f.repository.task(old.id)!)).toEqual({
      code: 'task_superseded',
      reason: 'feature_superseded',
      feature: 'summary',
    });
    expect(() => f.repository.requeue(old.id)).toThrow('task_superseded');
  });
  it('prioritizes the active-generation conflict before a lineage mismatch and treats mixed requeue atomically', () => {
    const f = setup();
    const old = admitted(f);
    f.repository.settle(
      f.repository.claim(4, 100)!,
      new WorkError('invalid', 'validation', false),
    );
    f.db.run(
      "UPDATE entry_feature_states SET state='skipped',skip_reason='content_too_short' WHERE kind='summary'",
    );
    expect(() => f.repository.requeue(old.id)).toThrow('task_superseded');
    expect(
      f.repository.featureStates(1).find((s) => s.kind === 'translation')!
        .state,
    ).toBe('failed');
    f.repository.admit(
      1,
      [{ kind: 'translation', state: 'pending', skip_reason: null }],
      generationSnapshot(c, ['translation'], 200),
    );
    expect(f.repository.requeueReason(f.repository.task(old.id)!)).toEqual({
      code: 'generation_in_progress',
    });
  });
  it('uses monotonic cursors, compare-and-swap bindings and bounded jitter', () => {
    const f = setup();
    f.repository.setCursor(5);
    expect(() => f.repository.setCursor(4)).toThrow('cursor_regression');
    const binding = {
      schema_version: 1 as const,
      base_url: 'https://miniflux.test',
      user_id: 1,
    };
    f.repository.bind(binding);
    expect(() => f.repository.bind({ ...binding, user_id: 2 })).toThrow(
      'miniflux_binding_conflict',
    );
    expect(backoff(retrySnapshot(c), 1)).toBe(1000);
    expect(backoff({ ...retrySnapshot(c), jitter_ratio: 0.5 }, 1, 0)).toBe(500);
    expect(backoff(retrySnapshot(c), 100)).toBe(retrySnapshot(c).max_delay_ms);
  });
});
describe('versioned closed durable JSON', () => {
  it('round-trips every family and rejects unknown versions and nested properties', () => {
    const jobConfig = config(
      "features:\n  digest:\n    public_base_url: https://digest.test\n    jobs:\n      - id: daily\n        cron: '0 2 * * *'\n        output:\n          feed_title_template: Daily\n",
    );
    const digest = digestSnapshot(
      jobConfig,
      jobConfig.features.digest.jobs[0]!,
    );
    const cases = [
      [D.generatePayloadSchema, payload],
      [
        D.renderPayloadSchema,
        {
          schema_version: 1,
          render_generation: 1,
          retry_policy: payload.retry_policy,
        },
      ],
      [
        D.digestPayloadSchema,
        { schema_version: 1, digest_run_id: 1, config_snapshot: digest },
      ],
      [
        D.backfillPayloadSchema,
        {
          schema_version: 1,
          ...backfillSpecs(c, ['translation']),
          since_ms: null,
          until_ms: null,
          feed_ids: [],
          category_ids: [],
          limit: 10,
          dry_run: true,
          page_size: 100,
        },
      ],
      [
        D.translationArtifactSchema,
        { schema_version: 1, title: null, blocks: [] },
      ],
      [D.summaryArtifactSchema, summary.payload],
      [
        D.translationRenderSchema,
        { schema_version: 1, title_template: '{translated} {original}' },
      ],
      [D.summaryRenderSchema, summary.render_spec],
      [D.artifactStatsSchema, stats],
      [D.digestStatsSchema, D.zeroDigestStats()],
      [D.lastErrorSchema, new WorkError('invalid', 'validation', false).detail],
      [
        D.bindingSchema,
        { schema_version: 1, base_url: 'https://host.test', user_id: 1 },
      ],
      [D.cursorSchema, { schema_version: 1, after_entry_id: 0 }],
      [D.backfillProgressSchema, D.emptyBackfillProgress()],
      [D.digestSnapshotSchema, digest],
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
      for (const bad of [
        { ...value, schema_version: 999 },
        { ...value, schema_version: undefined },
        { ...value, extra: 'forbidden' },
      ])
        expect(() => schema.parse(bad)).toThrow();
    }
    expect(() =>
      D.generatePayloadSchema.parse({
        ...payload,
        ai: { ...payload.ai, api_key: 'secret' },
      }),
    ).toThrow();
    expect(() =>
      D.generatePayloadSchema.parse({
        ...payload,
        requested_features: ['summary', 'translation'],
      }),
    ).toThrow();
    expect(() =>
      D.digestSnapshotSchema.parse({
        ...digest,
        selection: { ...digest.selection, max_item_summary_units: 1 },
      }),
    ).toThrow();
    expect(() =>
      D.artifactStatsSchema.parse({ ...stats, request_count: 2 }),
    ).toThrow();
    expect(() =>
      D.lastErrorSchema.parse({
        ...new WorkError('render_integrity_failed', 'integrity', false).detail,
      }),
    ).toThrow();
  });
});
