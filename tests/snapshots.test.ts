import { afterEach, describe, expect, it } from 'vitest';
import { createService } from '../src/runtime/service.js';
import { retrySnapshot } from '../src/config/snapshots.js';
import { artifactStats } from '../src/ai/stats.js';
import {
  serviceFixture,
  config,
  writeConfiguration,
  entry,
  chat,
  generated,
  response,
} from './helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(yaml = '', source = entry()) {
  const f = await serviceFixture(yaml);
  closers.push(() => f.close());
  await f.prepare();
  f.upstream.entries.set(1, source);
  await f.service.ingest.poll();
  return f;
}
async function drain(service: Awaited<ReturnType<typeof createService>>) {
  for (let i = 0; i < 20; i++) {
    service.queue.tick();
    await service.queue.idle();
    if (
      !service.repository
        .listTasks()
        .some((t) => t.state === 'pending' && t.run_after <= Date.now())
    )
      return;
  }
  throw new Error('queue did not drain');
}

describe('immutable continuation and Artifact rendering snapshots', () => {
  it('keeps instructions/retry/template A while old and new tasks use current YAML model B after restart', async () => {
    const f = await fixture(
      "features:\n  summary:\n    enabled: false\n  translation:\n    title_template: 'A {translated} ({original})'\nprompts:\n  translation: Instruction A\nqueue:\n  retry:\n    max_attempts: 3\n",
    );
    const original = f.service.repository.listTasks()[0]!;
    expect(f.upstream.languageInputs).toHaveLength(1);
    await f.service.stop();
    // The initial language review used A before rotation; assertions below cover
    // requests executed by the restarted service with its current credentials.
    f.upstream.requests.length = 0;
    const current = config(
      "miniflux:\n  max_requests_per_second: 100000\nfeatures:\n  translation:\n    enabled: false\n    title_template: 'B {translated} ({original})'\n  summary:\n    min_source_units: 1\n    heading: Heading B\nprompts:\n  translation: Instruction B\n  summary: Summary B\nqueue:\n  retry:\n    max_attempts: 1\n",
    );
    current.ai.providers[0]!.model = 'model-b';
    current.ai.providers[0]!.api_key = 'rotated-ai-secret';
    current.miniflux.api_key = 'rotated-miniflux-secret';
    const service = await createService(writeConfiguration(f.root, current), {
      root: f.root,
      fetch: f.upstream.fetch,
      logger: { log() {} },
    });
    closers.push(() => service.stop());
    await service.binding.check();
    f.upstream.aiHandler = (e, n) =>
      n === 1 ? response({}, 503) : chat(generated(e));
    await drain(service);
    expect(service.repository.task(original.id)).toMatchObject({
      state: 'pending',
      attempts: 1,
      payload: original.payload,
    });
    service.db.run('UPDATE tasks SET run_after=0 WHERE id=?', original.id);
    await drain(service);
    expect(f.upstream.entries.get(1)!.title).toBe(
      'A 译文标题 (An interesting entry)',
    );
    await service.reprocess(1, ['summary']);
    await drain(service);
    const requests = f.upstream.requests.filter(
      (r) => r.url.pathname === '/v1/chat/completions',
    );
    expect((requests[0]!.body as { model: string }).model).toBe('model-b');
    expect((requests[1]!.body as { model: string }).model).toBe('model-b');
    expect((requests[2]!.body as { model: string }).model).toBe('model-b');
    expect(JSON.stringify(requests[1]!.body)).toContain('Instruction A');
    expect(JSON.stringify(requests[1]!.body)).not.toContain('Instruction B');
    expect(
      requests.every(
        (r) => r.headers.get('authorization') === 'Bearer rotated-ai-secret',
      ),
    ).toBe(true);
    expect(f.upstream.entries.get(1)!.content).toContain('Heading B');
    expect(f.upstream.entries.get(1)!.title.startsWith('A ')).toBe(true);
    const durable =
      JSON.stringify(service.db.all('SELECT * FROM tasks')) +
      JSON.stringify(service.db.all('SELECT * FROM artifacts'));
    expect(durable).not.toContain('rotated-ai-secret');
    expect(durable).not.toContain('rotated-miniflux-secret');
  });
  it('settles old Render generations without PUT and permanently rejects a future generation', async () => {
    const f = await fixture();
    await f.drain();
    const puts = f.upstream.puts;
    const old = f.service.repository.requestRender(
      1,
      retrySnapshot(f.service.config),
    );
    f.service.repository.requestRender(1, retrySnapshot(f.service.config));
    await f.drain();
    expect(f.upstream.puts).toBe(puts + 1);
    expect(f.service.repository.task(old.id)!.state).toBe('done');
    const future = f.service.repository.createTask(
      'render',
      'render:1:future',
      1,
      {
        schema_version: 1,
        render_generation: 999,
        retry_policy: retrySnapshot(f.service.config),
      },
    );
    await f.drain();
    expect(f.service.repository.task(future.id)).toMatchObject({
      state: 'dead',
      last_error: {
        code: 'invalid_render_generation',
        miniflux_version: null,
        integrity_stage: null,
      },
    });
    expect(f.upstream.puts).toBe(puts + 1);
    expect(() => f.service.repository.requeue(old.id)).toThrow('task_not_dead');
  });
  it('checks the current block plan before PUT and preserves pending status after a failed Render', async () => {
    const f = await fixture('features:\n  summary:\n    enabled: false\n');
    const task = f.service.repository.claim(4, 1000)!;
    f.service.repository.completeGeneration(
      task,
      [
        {
          kind: 'translation',
          output_language: 'zh-CN',
          payload: {
            schema_version: 1,
            title: { status: 'translated', text: 'Title' },
            blocks: [],
          },
          render_spec: {
            schema_version: 1,
            title_template: '{translated} {original}',
          },
          ai_stats: artifactStats([
            {
              provider_id: 'primary',
              model: 'test-model',
              operation: 'generate_artifacts',
              duration_ms: 0,
              finish_reason: 'stop',
              usage: null,
              outcome: 'succeeded',
            },
          ]),
        },
      ],
      {},
    );
    await f.drain();
    const failed = f.service.repository.listTasks({
      state: 'dead',
      type: 'render',
    })[0]!;
    expect(failed.last_error).toMatchObject({
      code: 'render_integrity_failed',
      integrity_stage: 'pre_put_block_plan_join',
      http_status: null,
      upstream_request_id: null,
    });
    expect(f.upstream.puts).toBe(0);
    expect((await f.app.inject({ url: '/metrics' })).body).toContain(
      'mfai_entries_render_pending 1',
    );
    expect(() =>
      f.service.db.run("UPDATE artifacts SET render_spec='{}'"),
    ).toThrow('artifact_immutable');
  });
  it('fails before PUT on sanitizer instability and rejects malformed owned Source without mutation', async () => {
    const f = await fixture(
      '',
      entry(1, '<div>Unexpected unsanitized Source wrapper</div>'),
    );
    await f.drain();
    expect(
      f.service.repository.listTasks({ state: 'dead', type: 'render' })[0]!
        .last_error,
    ).toMatchObject({ integrity_stage: 'pre_put_sanitizer' });
    expect(f.upstream.puts).toBe(0);
    const token = f.service.repository
      .artifacts(1)
      .find((a) => a.kind === 'translation')!.marker_token;
    f.upstream.entries.get(1)!.content =
      `<p>Source</p><p><sup id="mfai-v1-translation-${token}-111111111111">not empty</sup>Invalid</p>`;
    await expect(f.service.reprocess(1, ['translation'])).rejects.toThrow(
      'source_projection_invalid',
    );
    expect(
      f.service.repository.listTasks({ type: 'generate_artifacts' }),
    ).toHaveLength(1);
  });
});
