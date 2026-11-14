import { afterEach, describe, expect, it } from 'vitest';
import { Metrics, createLogger } from '../src/obs/index.js';
import { safeWorkError, upstreamRequestId } from '../src/obs/errors.js';
import { artifactOperations, digestOperations } from '../src/db/documents.js';
import type { AiOperation } from '../src/db/documents.js';
import { retrySnapshot } from '../src/config/snapshots.js';
import {
  compact,
  entry,
  response,
  serviceFixture,
  fixtureValues,
  signed,
} from './helpers.js';

const fixtures: Awaited<ReturnType<typeof serviceFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function setup(yaml = '') {
  const f = await serviceFixture(yaml);
  fixtures.push(f);
  await f.prepare();
  return f;
}

describe('observability at committed domain boundaries', () => {
  it('reports generation, independent Feature transitions, AI transport, rendering and source units', async () => {
    const f = await setup('features:\n  summary:\n    min_source_units: 1\n');
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    await f.drain();
    const text = (await f.app.inject({ url: '/metrics' })).body;
    for (const value of [
      'mfai_tasks_total{type="generate_artifacts",outcome="done"} 1',
      'mfai_tasks_total{type="render",outcome="done"} 1',
      'mfai_feature_state_transitions_total{feature="translation",to="ready"} 1',
      'mfai_feature_state_transitions_total{feature="summary",to="ready"} 1',
      'mfai_ai_requests_total{model="test-model",operation="generate_artifacts",mode="joint",outcome="succeeded"} 1',
      'mfai_entries_rendered_total 1',
      'mfai_entry_content_units_count 1',
      'mfai_ai_request_bytes_count 2',
      'mfai_ai_requests_total{model="test-model",operation="detect_language",mode="single",outcome="succeeded"} 1',
      'mfai_language_detections_total{source="llm",outcome="undetermined",reason="undetermined"} 1',
      'mfai_entries_render_pending 0',
      'mfai_tasks_inflight{type="render"} 0',
    ])
      expect(text).toContain(value);
    for (const secret of Object.values(fixtureValues).filter((v) =>
      v.includes('credential'),
    ))
      expect(text).not.toContain(secret);
  });
  it('discards nested transaction observations on rollback and ignores instrumentation failure after commit', async () => {
    const f = await setup();
    const before = await f.service.metrics.registry.metrics();
    expect(() =>
      f.service.db.transaction(() => {
        f.service.repository.insertEntry(compact());
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(f.service.repository.entry(1)).toBeUndefined();
    expect(await f.service.metrics.registry.metrics()).toBe(before);
    f.service.repository.observe.entry = () => {
      throw new Error('instrumentation unavailable');
    };
    expect(() => f.service.repository.insertEntry(compact())).not.toThrow();
    expect(f.service.repository.entry(1)).toBeDefined();
  });
  it('keeps permanently failed Render generations pending and exposes task type on dead counters', async () => {
    const f = await setup(
      'features:\n  translation:\n    enabled: false\n  summary:\n    enabled: false\n',
    );
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    const gauge = async () => (await f.app.inject({ url: '/metrics' })).body;
    expect(await gauge()).toContain('mfai_entries_render_pending 0');
    f.service.repository.requestRender(1, retrySnapshot(f.service.config));
    expect(await gauge()).toContain('mfai_entries_render_pending 1');
    await f.drain();
    expect(await gauge()).toContain('mfai_entries_render_pending 0');
    f.upstream.intercept = (_url, method) =>
      method === 'PUT' ? response({}, 400) : undefined;
    f.service.repository.requestRender(1, retrySnapshot(f.service.config));
    await f.drain();
    const text = await gauge();
    expect(text).toContain('mfai_entries_render_pending 1');
    expect(text).toContain('mfai_tasks_dead_total{type="render"} 1');
  });
  it('separates Scope denials, intrinsic Skips and poll rejections from webhook failure', async () => {
    const f = await setup(
      'features:\n  translation:\n    scope:\n      fallback_action: deny\n',
    );
    f.upstream.entries.set(1, entry(1, ''));
    f.upstream.entries.set(2, {
      ...entry(2),
      feed: { ...entry(2).feed, category: { id: 0, title: '' } },
    });
    await f.service.ingest.poll();
    const body = JSON.stringify({ entries: [entry(3)] });
    f.upstream.intercept = (url) =>
      url.pathname.startsWith('/v1/feeds/') ? response({}, 503) : undefined;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/webhook/miniflux',
          headers: signed(body),
          payload: body,
        })
      ).statusCode,
    ).toBe(503);
    const text = (await f.app.inject({ url: '/metrics' })).body;
    expect(text).toContain(
      'mfai_feature_admission_denials_total{feature="translation",reason="scope_denied"} 1',
    );
    expect(text).toContain(
      'mfai_feature_skips_total{feature="summary",reason="content_too_short"} 1',
    );
    expect(text).toContain(
      'mfai_ingest_rejected_entries_total{source="poll",reason="category_metadata_invalid"} 1',
    );
    expect(text).not.toContain('source="webhook"');
    expect(f.service.repository.featureStates(1)).toHaveLength(1);
  });
});

describe('fixed schemas keep protected text out of logs and metric labels', () => {
  it('enumerates fixed AI operations, modes and outcomes and rejects arbitrary labels', async () => {
    const metrics = new Metrics(new Set(['test-model']));
    for (const operation of [...artifactOperations, ...digestOperations])
      for (const outcome of ['succeeded', 'failed'] as const)
        metrics.ai('test-model', operation, 'single', outcome, 1);
    metrics.ai('test-model', 'generate_artifacts', 'joint', 'succeeded', 1);
    for (const invalid of [
      'entry:1',
      'task:1',
      'job:daily',
      'feed:2',
      'category:7',
      'https://provider.test/private',
      'private error',
    ]) {
      expect(() =>
        metrics.ai(invalid, 'generate_artifacts', 'single', 'failed', 1),
      ).toThrow();
      expect(() =>
        metrics.ai('test-model', invalid as AiOperation, 'single', 'failed', 1),
      ).toThrow();
      expect(() =>
        metrics.ai(
          'test-model',
          'generate_artifacts',
          invalid as 'single',
          'failed',
          1,
        ),
      ).toThrow();
    }
    expect(() =>
      metrics.ai(
        'test-model',
        'generate_artifacts',
        'single',
        'pending' as 'failed',
        1,
      ),
    ).toThrow();
    for (const level of [1, 2, 3, 4, 5, 6]) metrics.degradation(level);
    for (const level of [0, 7, 1.5])
      expect(() => metrics.degradation(level)).toThrow();
    for (const endpoint of [
      '/v1/version',
      '/v1/me',
      '/v1/categories',
      '/v1/entries',
      '/v1/entries/:id',
      '/v1/feeds',
      '/v1/feeds/:id',
      '/v1/feeds/:id/entries/import',
    ])
      for (const status of ['network', '200', '201', '429', '503'])
        metrics.miniflux(endpoint, status);
    expect(() => metrics.miniflux('/v1/entries/secret', '200')).toThrow();
    expect(() =>
      metrics.miniflux('/v1/entries/:id', 'private error'),
    ).toThrow();
    const output = await metrics.registry.metrics();
    expect(output).not.toContain('private error');
  });
  it('rejects raw data at every log level and preserves only sanitized classifications and request IDs', () => {
    const lines: string[] = [],
      logger = createLogger('debug', {
        write: (line: string) => {
          lines.push(line);
        },
      });
    const protectedText = 'private Source text and secret provider token';
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      logger.log(level, 'operation_failed', {
        error: safeWorkError(new Error(protectedText)).detail,
      });
      logger.log(level, 'operation_failed', {
        content: protectedText,
      } as Parameters<typeof logger.log>[2]);
    }
    const error = safeWorkError(new Error(protectedText));
    expect(error.detail).toMatchObject({
      code: 'operation_failed',
      failure_class: 'repository',
      retryable: true,
    });
    logger.log('info', 'webhook_admitted', { request_id: 'request-123' });
    expect(lines.join('')).not.toContain(protectedText);
    expect(
      lines
        .map((line) => JSON.parse(line).event)
        .filter((event) => event === 'log_payload_rejected'),
    ).toHaveLength(4);
    expect(lines.at(-1)).toContain('request-123');
    expect(
      upstreamRequestId(new Headers({ 'x-request-id': 'request-123' })),
    ).toBe('request-123');
    expect(
      upstreamRequestId(new Headers({ 'x-request-id': protectedText })),
    ).toBeNull();
  });
});
