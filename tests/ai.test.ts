import { aiConfig } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';
import { AiClient, classifyAiFailure } from '../src/ai/client.js';
import type { CallStat } from '../src/ai/client.js';
import { parseEnvelope, parseTopLevel } from '../src/ai/protocol.js';
import type { Envelope } from '../src/ai/protocol.js';
import { ArtifactGenerator } from '../src/generation/index.js';
import { translationSpecification } from '../src/features/translation/index.js';
import { summarySpecification } from '../src/features/summary/index.js';
import { artifactStats, digestStats } from '../src/ai/stats.js';
import {
  absoluteUrls,
  halves,
  joinTranslation,
  plainText,
  splitSentences,
} from '../src/ai/text.js';
import { generationSnapshot } from '../src/config/snapshots.js';
import { chat, config, FakeUpstream, generated, response } from './helpers.js';

const c = config(),
  snapshot = generationSnapshot(c, ['translation', 'summary'], 200);
const source = {
  title: 'Original article title',
  blocks: [
    {
      id: '111111111111',
      text: 'The first sentence explains the idea. The next sentence examines the consequences.',
    },
    {
      id: '222222222222',
      text: 'Another section gives practical details. Its final sentence draws a conclusion.',
    },
  ],
};
const envelope: Envelope = {
  protocol_version: 1,
  operation: 'generate_artifacts',
  context: { feed_title: 'Feed', primary_language: 'en' },
  source,
  requested_outputs: {
    translation: {
      target_language: 'zh-CN',
      title_requested: true,
      block_ids: source.blocks.map((b) => b.id),
    },
  },
};
const order = { priority: 100, created_at: 1, id: 1 },
  signal = new AbortController().signal;
const overflow = () =>
  response({ error: { code: 'context_length_exceeded' } }, 400);
function generator(handler?: FakeUpstream['aiHandler']) {
  const upstream = new FakeUpstream();
  upstream.aiHandler = handler;
  const client = new AiClient(
    2,
    () => aiConfig('current-secret'),
    upstream.fetch,
  );
  return { upstream, client, generator: new ArtifactGenerator(client) };
}
async function run(
  g: ArtifactGenerator,
  input = source,
  kinds = ['translation', 'summary'],
  options: { max?: number; sections?: string[][] } = {},
) {
  return g.generate(
    input,
    {
      ...(kinds.includes('translation')
        ? {
            translation: translationSpecification(snapshot.translation!, input),
          }
        : {}),
      ...(kinds.includes('summary')
        ? {
            summary: summarySpecification(
              { ...snapshot.summary!, max_output_units: options.max ?? 200 },
              input.blocks.map((b) => b.text).join('\n'),
            ),
          }
        : {}),
    },
    {
      ai: snapshot.ai,
      order,
      signal,
      context: { feed_title: 'Feed', primary_language: 'en' },
      sections: options.sections,
    },
  );
}
describe('AI transport and explicit failure classes', () => {
  it.each([
    [401, { error: { code: 'context_length_exceeded' } }, 'auth', false],
    [403, {}, 'auth', false],
    [429, { error: { code: 'context_length_exceeded' } }, 'rate_limited', true],
    [503, { error: { code: 'context_length_exceeded' } }, 'upstream_5xx', true],
    [503, { error: { type: 'overloaded_error' } }, 'overload', true],
    [413, {}, 'request_too_large', true],
    [
      400,
      { error: { code: 'context_length_exceeded' } },
      'context_overflow',
      true,
    ],
    [
      400,
      {
        error: { message: 'Maximum context length exceeded for this request' },
      },
      'context_overflow',
      true,
    ],
    [
      400,
      { error: { message: 'Invalid max_tokens parameter' } },
      'invalid_request',
      false,
    ],
    [
      400,
      { error: { message: 'Request exceeds account quota' } },
      'invalid_request',
      false,
    ],
    [404, {}, 'invalid_request', false],
    [408, {}, 'timeout', true],
    [408, { error: { code: 'context_length_exceeded' } }, 'timeout', true],
    [422, { errors: [{ code: 'prompt_too_long' }] }, 'context_overflow', true],
  ])('classifies HTTP %i %j as %s', (status, body, failure, retryable) =>
    expect(classifyAiFailure(status, body, 5000).detail).toMatchObject({
      failure_class: failure,
      retryable,
      http_status: status,
    }),
  );
  it('uses the exact snapshotted protocol with current secrets and no sampling overrides', async () => {
    const { upstream, client } = generator();
    const calls: CallStat[] = [];
    await client.call(
      snapshot.ai,
      'Static instruction',
      envelope,
      order,
      signal,
      (s) => calls.push(s),
    );
    const request = upstream.requests[0]!,
      body = request.body as Record<string, unknown>;
    expect(request.url.href).toBe('https://ai.test/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer current-secret');
    expect(Object.keys(body).sort()).toEqual([
      'messages',
      'model',
      'response_format',
      'stream',
    ]);
    expect(body).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_object' },
      stream: true,
    });
    expect(calls[0]).toMatchObject({
      outcome: 'succeeded',
      finish_reason: 'stop',
      usage: { total_tokens: 30 },
    });
    expect(artifactStats(calls)).toMatchObject({
      operations: ['generate_artifacts'],
      request_count: 1,
      usage: { reported_request_count: 1 },
    });
  });
  it.each([
    ['fenced JSON', () => chat('```json\n{}\n```'), 'invalid_response'],
    ['invalid JSON', () => chat('{'), 'invalid_response'],
    ['scalar', () => chat('123'), 'invalid_response'],
    ['null', () => chat('null'), 'invalid_response'],
    ['array', () => chat([]), 'invalid_response'],
    [
      'unrequested member',
      () => chat({ translation: {}, summary: {} }),
      'invalid_response',
    ],
    ['missing member', () => chat({}), 'invalid_response'],
    ['missing choices', () => response({}), 'invalid_response'],
    [
      'truncated even if valid JSON',
      () => chat({ translation: {} }, 'length'),
      'output_truncated',
    ],
  ] as const)(
    'rejects %s without transport retries',
    async (_name, reply, failure) => {
      const observed = vi.fn(),
        calls: CallStat[] = [],
        fetcher = vi.fn(async () => reply()),
        client = new AiClient(1, () => aiConfig('key'), fetcher, observed);
      await expect(
        client.call(snapshot.ai, 'Instruction', envelope, order, signal, (s) =>
          calls.push(s),
        ),
      ).rejects.toMatchObject({ detail: { failure_class: failure } });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(calls[0]!.outcome).toBe('failed');
      expect(observed.mock.calls[0]![3]).toBe('failed');
    },
  );
  it('reports network, timeout, Retry-After and aborted waits without hidden retries', async () => {
    const client = new AiClient(
      1,
      () => aiConfig('key'),
      async () => {
        throw new TypeError('private network details');
      },
    );
    await expect(
      client.call(
        snapshot.ai,
        'Instruction',
        envelope,
        order,
        signal,
        () => {},
      ),
    ).rejects.toMatchObject({ detail: { failure_class: 'network' } });
    const timed = new AiClient(
      1,
      () => aiConfig('key', { request_timeout_ms: 5 }),
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          ),
        ),
    );
    await expect(
      timed.call(snapshot.ai, 'Instruction', envelope, order, signal, () => {}),
    ).rejects.toMatchObject({ detail: { failure_class: 'timeout' } });
    const retry = new AiClient(
      1,
      () => aiConfig('key'),
      async () => response({}, 429, { 'retry-after': '12' }),
    );
    await expect(
      retry.call(snapshot.ai, 'Instruction', envelope, order, signal, () => {}),
    ).rejects.toMatchObject({ retryAfterMs: 300000 });
    const upstreamTimeout = new AiClient(
      1,
      () => aiConfig('key'),
      async () => response({}, 408, { 'retry-after': '9' }),
    );
    await expect(
      upstreamTimeout.call(
        snapshot.ai,
        'Instruction',
        envelope,
        order,
        signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      detail: {
        code: 'ai_timeout',
        failure_class: 'timeout',
        http_status: 408,
        retryable: true,
      },
      retryAfterMs: 300000,
    });
    const aborted = new AbortController();
    aborted.abort(new Error('stopped'));
    await expect(
      client.call(
        snapshot.ai,
        'Instruction',
        envelope,
        order,
        aborted.signal,
        () => {},
      ),
    ).rejects.toThrow('stopped');
  });
  it('records incomplete usage and finish reasons without fabricating token counts', async () => {
    const reasons = [undefined, 'content_filter', 'tool_calls'];
    const calls: CallStat[] = [];
    const client = new AiClient(
      1,
      () => aiConfig('key'),
      async () =>
        response({
          choices: [
            {
              finish_reason: reasons.shift(),
              message: { content: JSON.stringify({ translation: {} }) },
            },
          ],
          usage: { total_tokens: 3 },
        }),
    );
    for (let i = 0; i < 3; i++)
      await client.call(
        snapshot.ai,
        'Instruction',
        envelope,
        order,
        signal,
        (s) => calls.push(s),
      );
    expect(artifactStats(calls)).toMatchObject({
      usage: { reported_request_count: 0, total_tokens: 0 },
      finish_reasons: { missing: 1, content_filter: 1, other: 1 },
    });
  });
});
describe('independent Artifact repair and bounded whole-document degradation', () => {
  it('repairs only invalid translation IDs and never repeats a valid sibling or title', async () => {
    const f = generator((e, n) =>
      n === 1
        ? chat({
            translation: {
              title: '有效标题',
              blocks: [{ id: source.blocks[0]!.id, text: '有效译文' }],
            },
            summary: { format: 'paragraph', text: '有效摘要' },
          })
        : chat(generated(e)),
    );
    const result = await run(f.generator);
    expect(result.artifacts).toHaveLength(2);
    expect(result.failures).toEqual({});
    expect(f.upstream.aiInputs).toHaveLength(2);
    expect(f.upstream.aiInputs[1]).toMatchObject({
      operation: 'repair_translation',
      source: { title: null, blocks: [source.blocks[1]] },
      repair_targets: {
        title_requested: false,
        block_ids: [source.blocks[1]!.id],
      },
    });
    expect(
      result.artifacts.find((a) => a.kind === 'summary')!.ai_stats.operations,
    ).toEqual(['generate_artifacts']);
  });
  it('allows one Summary size repair without resending rejected prose', async () => {
    const f = generator((e, n) =>
      n === 1
        ? chat({
            summary: {
              format: 'paragraph',
              text: 'one two three four five six',
            },
          })
        : chat({ summary: { format: 'paragraph', text: 'brief' } }),
    );
    const result = await run(f.generator, source, ['summary'], { max: 2 });
    expect(result.artifacts).toHaveLength(1);
    expect(f.upstream.aiInputs[1]).toMatchObject({
      operation: 'repair_summary',
      repair: { reason: 'max_units_exceeded', observed_units: 6 },
    });
    expect(JSON.stringify(f.upstream.aiInputs[1])).not.toContain(
      'one two three four five six',
    );
    const bad = generator(() =>
      chat({ summary: { format: 'paragraph', text: 'one two three four' } }),
    );
    const failed = await run(bad.generator, source, ['summary'], { max: 1 });
    expect(failed.artifacts).toHaveLength(0);
    expect(bad.upstream.aiInputs).toHaveLength(2);
  });
  it('splits an oversized joint request into independent trees and performs a model Summary merge', async () => {
    const f = generator((e, n) => (n === 1 ? overflow() : chat(generated(e))));
    const result = await run(f.generator, source, ['translation', 'summary'], {
      sections: source.blocks.map((b) => [b.id]),
    });
    expect(result.artifacts).toHaveLength(2);
    expect(f.upstream.aiInputs.map((e) => e.operation)).toContain(
      'merge_summary_partials',
    );
    for (const e of f.upstream.aiInputs.slice(1))
      if (e.operation === 'generate_artifacts')
        expect(Object.keys(e.requested_outputs)).toHaveLength(1);
    const translation = result.artifacts.find((a) => a.kind === 'translation')!;
    expect(translation.payload).toMatchObject({
      blocks: source.blocks.map((b) => ({ id: b.id, status: 'translated' })),
    });
  });
  it('uses title-only and sentence splits without a Translation model merge', async () => {
    const f = generator((e) =>
      e.operation === 'generate_artifacts' &&
      (e.source.blocks.some((b) => splitSentences(b.text).length > 1) ||
        (e.source.title && e.source.blocks.length))
        ? overflow()
        : chat(generated(e)),
    );
    const result = await run(
      f.generator,
      { title: source.title, blocks: source.blocks.slice(0, 1) },
      ['translation'],
    );
    expect(result.artifacts).toHaveLength(1);
    expect(
      f.upstream.aiInputs.some(
        (e) =>
          e.operation === 'generate_artifacts' && e.source.blocks.length === 0,
      ),
    ).toBe(true);
    expect(
      f.upstream.aiInputs.every((e) => e.operation === 'generate_artifacts'),
    ).toBe(true);
    const titles = generator((_e, n) =>
      n === 1
        ? overflow()
        : chat({ translation: { title: '译文', blocks: [] } }),
    );
    expect(
      (
        await run(
          titles.generator,
          { title: 'First title sentence. Second title sentence.', blocks: [] },
          ['translation'],
        )
      ).artifacts,
    ).toHaveLength(1);
  });
  it('bounds unsplittable input and depth, and discards every partial on leaf failure', async () => {
    const small = generator(() => overflow());
    const result = await run(
      small.generator,
      { title: '', blocks: [{ id: '111111111111', text: 'Indivisible' }] },
      ['translation', 'summary'],
    );
    expect(result.artifacts).toHaveLength(0);
    const deep = generator(() => overflow());
    const big = {
      title: '',
      blocks: Array.from({ length: 256 }, (_, i) => ({
        id: i.toString(16).padStart(12, '0'),
        text: 'One sentence.',
      })),
    };
    const exhausted = await run(deep.generator, big, ['translation']);
    expect(exhausted.failures.translation!.detail.code).toBe(
      'split_depth_exceeded',
    );
    const partial = generator((e, n) =>
      n === 1 ? overflow() : n === 3 ? response({}, 503) : chat(generated(e)),
    );
    const failed = await run(partial.generator, source, ['translation']);
    expect(failed.artifacts).toHaveLength(0);
    expect(failed.failures.translation!.detail.failure_class).toBe(
      'upstream_5xx',
    );
  });
  it('does not split authentication or malformed transport output and does not repair Summary shape/URL defects', async () => {
    const auth = generator(() => response({}, 401));
    await expect(run(auth.generator)).rejects.toMatchObject({
      detail: { failure_class: 'auth' },
    });
    expect(auth.upstream.aiInputs).toHaveLength(1);
    const malformed = generator(() => chat({ translation: {} }));
    await expect(run(malformed.generator)).rejects.toMatchObject({
      detail: { failure_class: 'invalid_response' },
    });
    const invalid = generator(() =>
      chat({ summary: { format: 'paragraph', text: 'https://invented.test' } }),
    );
    const result = await run(invalid.generator, source, ['summary']);
    expect(result.artifacts).toHaveLength(0);
    expect(invalid.upstream.aiInputs).toHaveLength(1);
    await expect(run(generator().generator, source, [])).rejects.toThrow(
      'no_requested_outputs',
    );
  });
  it('degrades a repair independently while retaining already valid pieces', async () => {
    const f = generator((e, n) =>
      n === 1
        ? chat({ translation: { title: '有效标题', blocks: [] } })
        : e.operation === 'repair_translation'
          ? overflow()
          : chat(generated(e)),
    );
    const result = await run(f.generator, source, ['translation']);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.payload).toMatchObject({
      title: { text: '有效标题' },
    });
    expect(
      f.upstream.aiInputs
        .slice(2)
        .every(
          (e) =>
            e.operation !== 'generate_artifacts' ||
            !e.requested_outputs.translation?.title_requested,
        ),
    ).toBe(true);
  });
  it('splits overflowing Summary repairs and recursively reduces oversized merge batches', async () => {
    let merges = 0;
    const many = {
      title: 'Title',
      blocks: Array.from({ length: 5 }, (_, i) => ({
        id: i.toString(16).padStart(12, '0'),
        text: `This section explains a distinct aspect of the problem in detail.`,
      })),
    };
    const f = generator((e, n) => {
      if (n === 1) return overflow();
      if (e.operation === 'merge_summary_partials') {
        merges++;
        if (e.partials.length > 2) return overflow();
        return chat({
          summary: { format: 'paragraph', text: merges > 2 ? '短' : '简短' },
        });
      }
      return chat({
        summary: { format: 'paragraph', text: '较长的分段摘要内容' },
      });
    });
    const result = await run(f.generator, many, ['summary'], {
      sections: many.blocks.map((b) => [b.id]),
    });
    expect(result.artifacts).toHaveLength(1);
    expect(merges).toBeGreaterThan(2);
    const repaired = generator((e, n) =>
      n === 1
        ? chat({
            summary: {
              format: 'paragraph',
              text: 'one two three four five six',
            },
          })
        : e.operation === 'repair_summary'
          ? overflow()
          : chat({ summary: { format: 'paragraph', text: '短' } }),
    );
    expect(
      (await run(repaired.generator, source, ['summary'], { max: 2 }))
        .artifacts,
    ).toHaveLength(1);
  });
});
describe('closed protocol and text utilities', () => {
  it('rejects unknown keys, mismatched IDs and unversioned or structurally empty operations', () => {
    expect(parseEnvelope(envelope)).toEqual(envelope);
    expect(() =>
      parseEnvelope({
        ...envelope,
        protocol_version: 2,
      } as unknown as Envelope),
    ).toThrow();
    expect(() =>
      parseEnvelope({
        ...envelope,
        source: { ...source, extra: true },
      } as Envelope),
    ).toThrow();
    expect(() => parseTopLevel({}, ['summary'])).toThrow();
    expect(() => parseTopLevel(null, [])).toThrow();
  });
  it('uses plain prose, absolute URLs and language-sensitive sentence joins', () => {
    expect(plainText('<p>Unsafe</p>')).toBe(false);
    expect(plainText('1 < 2')).toBe(true);
    expect(absoluteUrls('Visit https://example.test/a.')).toContain(
      'https://example.test/a',
    );
    expect(halves([1])).toBeNull();
    expect(joinTranslation(['第一句。', '第二句。'], '中文。')).toBe(
      '第一句。第二句。',
    );
    expect(joinTranslation(['First.', 'Second.'], 'English.')).toBe(
      'First. Second.',
    );
    expect(digestStats([])).toMatchObject({
      request_count: 0,
      outcomes: { succeeded: 0, failed: 0 },
    });
  });
});
