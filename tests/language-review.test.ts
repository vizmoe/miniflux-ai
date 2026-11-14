import { aiConfig } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { Envelope } from '../src/ai/protocol.js';
import { aiSnapshot } from '../src/config/snapshots.js';
import { LanguageDetector } from '../src/lang/index.js';
import { LanguageAnalyzer, reviewSamples } from '../src/lang/review.js';
import { languageCodeSchema } from '../src/lang/contracts.js';
import type { LanguageDiagnostic } from '../src/lang/contracts.js';
import { registeredLanguages } from '../src/lang/registry.js';
import { Metrics, createLogger } from '../src/obs/index.js';
import {
  auth,
  chat,
  compact,
  entry,
  feed,
  response,
  serviceFixture,
} from './helpers.js';

type Request = Extract<Envelope, { operation: 'detect_language' }>;
const label = (request: Request, code: string) => ({
  parts: request.parts.map(({ id }) => ({ id, code })),
});
const unknown = { primaryLanguage: null, languageConfidence: null };
function harness(
  answer: (request: Request) => Response | Promise<Response> = (r) =>
    chat(label(r, 'en')),
  reliable = false,
) {
  const calls: Request[] = [],
    diagnostics: LanguageDiagnostic[] = [];
  const ai = new AiClient(
    1,
    () => aiConfig('test-key'),
    async (_input, init) => {
      const body = JSON.parse(String(init!.body)) as {
        messages: { content: string }[];
      };
      const request = JSON.parse(body.messages[1]!.content) as Request;
      calls.push(request);
      return answer(request);
    },
  );
  const local = new LanguageDetector({
    detect: () => ({
      language: reliable ? 'en' : '',
      isReliable: () => reliable,
    }),
  });
  const analyzer = new LanguageAnalyzer(local, ai, (_id, diagnostic) =>
    diagnostics.push(diagnostic),
  );
  const controller = new AbortController(),
    budget = new AbortController();
  return {
    calls,
    diagnostics,
    ai,
    analyzer,
    controller,
    budget,
    run: (title = 'A brief introduction', texts: string[] = []) =>
      analyzer.resolve(
        analyzer.prepare(
          title,
          texts.map((text, i) => ({ id: String(i), text })),
        ),
        aiSnapshot(),
        1,
        controller.signal,
        budget.signal,
      ),
  };
}

describe('automatic local-first language review', () => {
  it('keeps reliable local evidence fast and avoids sending non-language text', async () => {
    const h = harness(undefined, true);
    expect(await h.run('', ['ordinary '.repeat(50)])).toEqual({
      primaryLanguage: 'en',
      languageConfidence: 1,
    });
    expect(await h.run('123 https://source.test', [])).toEqual(unknown);
    expect(h.calls).toHaveLength(0);
    expect(h.diagnostics).toEqual([
      expect.objectContaining({
        source: 'local',
        outcome: 'identified',
        reason: 'local_evidence',
      }),
      expect.objectContaining({
        source: 'local',
        outcome: 'undetermined',
        reason: 'no_text',
      }),
    ]);
  });
  it('reviews a short title once with strict JSON and normalizes registered aliases to the existing identity', async () => {
    const h = harness((r) => chat(label(r, 'cmn')));
    expect(await h.run('短标题')).toEqual({
      primaryLanguage: 'zh',
      languageConfidence: 1,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      protocol_version: 1,
      operation: 'detect_language',
      parts: [{ id: 'p0', text: '短标题' }],
    });
    expect(h.diagnostics[0]).toMatchObject({
      source: 'llm',
      outcome: 'identified',
      language: 'zh',
    });
  });
  it('derives shares from weighted evidence and retains unknown weight in the denominator', async () => {
    const h = harness((r) =>
      chat({
        parts: r.parts
          .map(({ id }, i) => ({ id, code: i === 0 ? 'en' : 'zh' }))
          .reverse(),
      }),
    );
    expect(
      await h.run('', ['ordinary '.repeat(70), 'ordinary '.repeat(40)]),
    ).toEqual(unknown);
    expect(
      await h.run('', ['ordinary '.repeat(100), 'ordinary '.repeat(40)]),
    ).toEqual({ primaryLanguage: 'en', languageConfidence: 100 / 140 });
    const mostlyUnknown = harness((r) =>
      chat({
        parts: r.parts.map(({ id }, i) => ({
          id,
          code: i === 0 ? 'en' : 'und',
        })),
      }),
    );
    expect(
      await mostlyUnknown.run('Brief title', ['ordinary '.repeat(50)]),
    ).toEqual(unknown);
    expect(mostlyUnknown.diagnostics[0]).toMatchObject({
      source: 'llm',
      outcome: 'undetermined',
    });
  });
  it.each([
    'zz',
    'zzz',
    'qaa',
    'mul',
    'zxx',
    'EN',
    'english',
    'zh-Hant',
    'en-US',
    '',
    ' en ',
  ])('rejects unregistered or non-primary code %j', async (code) => {
    const h = harness((r) => chat(label(r, code)));
    expect(await h.run()).toEqual(unknown);
    expect(h.diagnostics[0]).toMatchObject({
      source: 'fallback',
      outcome: 'failed',
      reason: 'invalid_response',
    });
    expect(h.calls).toHaveLength(1);
  });
  it.each([
    { parts: [] },
    {
      parts: [
        { id: 'p0', code: 'en' },
        { id: 'p0', code: 'en' },
      ],
    },
    { parts: [{ id: 'invented', code: 'en' }] },
    { parts: [{ id: 'p0', code: 'en', confidence: 1 }] },
    { parts: [{ id: 'p0', code: 'en' }], reason: 'private prose' },
    [{ id: 'p0', code: 'en' }],
    '```json\n{"parts":[{"id":"p0","code":"en"}]}\n```',
  ])(
    'rejects malformed or mismatched response %# without accepting partial labels',
    async (raw) => {
      const h = harness(() => chat(raw));
      expect(await h.run()).toEqual(unknown);
      expect(h.diagnostics[0]).toMatchObject({
        source: 'fallback',
        reason: 'invalid_response',
      });
    },
  );
  it('distinguishes und from provider failure and never retries inline', async () => {
    const und = harness((r) => chat(label(r, 'und')));
    expect(await und.run()).toEqual(unknown);
    expect(und.diagnostics[0]).toMatchObject({
      source: 'llm',
      outcome: 'undetermined',
    });
    const failed = harness(() =>
      response({ error: { message: 'secret response' } }, 503),
    );
    expect(await failed.run()).toEqual(unknown);
    expect(failed.calls).toHaveLength(1);
    expect(failed.diagnostics[0]).toMatchObject({
      source: 'fallback',
      outcome: 'failed',
      reason: 'provider_error',
    });
    expect(JSON.stringify(failed.diagnostics)).not.toContain('secret');
  });
  it('includes semaphore waiting in the review deadline and releases cancelled waiters', async () => {
    const h = harness(),
      release = await h.ai.semaphore.acquire();
    const result = h.run();
    h.budget.abort(new DOMException('Deadline', 'TimeoutError'));
    expect(await result).toEqual(unknown);
    release();
    expect(h.calls).toHaveLength(0);
    expect(h.diagnostics[0]).toMatchObject({
      source: 'fallback',
      reason: 'timeout',
    });
    const nextRelease = await h.ai.semaphore.acquire();
    nextRelease();
  });
  it('propagates lifecycle cancellation instead of admitting a fallback result', async () => {
    const h = harness(),
      release = await h.ai.semaphore.acquire();
    const result = h.run();
    h.controller.abort();
    await expect(result).rejects.toThrow();
    release();
    expect(h.diagnostics).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });
  it('samples the full article within UTF-8 byte caps and preserves the title weight cap', () => {
    const samples = reviewSamples(
      '标题'.repeat(1000),
      Array.from({ length: 60 }, (_, i) => ({
        id: String(i),
        text: i === 59 ? 'final passage' : '日本語の文章です。'.repeat(600),
      })),
    );
    expect(samples.length).toBeLessThanOrEqual(16);
    expect(samples.at(-1)!.text).toBe('final passage');
    expect(
      samples.every(
        (p) => Buffer.byteLength(p.text) <= 1024 && !p.text.includes('\uFFFD'),
      ),
    ).toBe(true);
    expect(
      samples.slice(0, 3).reduce((sum, p) => sum + p.weight, 0),
    ).toBeCloseTo(50);
    const largeBlock = reviewSamples('', [
      {
        id: 'one',
        text: 'head '.repeat(500) + 'middle '.repeat(500) + 'tail '.repeat(500),
      },
    ]);
    expect(largeBlock).toHaveLength(3);
    expect(largeBlock[0]!.text).toContain('head');
    expect(largeBlock[1]!.text).toContain('middle');
    expect(largeBlock[2]!.text).toContain('tail');
    expect(largeBlock.reduce((sum, p) => sum + p.weight, 0)).toBeCloseTo(500);
  });
  it('accepts the IANA primary languages rather than only the local detector inventory', () => {
    expect(languageCodeSchema.parse('yue')).toBe('yue');
    expect(languageCodeSchema.parse('iw')).toBe('he');
    expect(languageCodeSchema.parse('und')).toBe('und');
    for (const code of registeredLanguages)
      expect(languageCodeSchema.safeParse(code).success).toBe(true);
  });
  it('does not give a tiny trailing window the weight of a full window', async () => {
    const h = harness((r) =>
      chat({
        parts: r.parts.map(({ id }, i) => ({
          id,
          code: i === 0 ? 'en' : 'zh',
        })),
      }),
    );
    const result = await h.run('', ['ordinary '.repeat(120) + '短']);
    expect(h.calls[0]!.parts).toHaveLength(2);
    expect(result.primaryLanguage).toBe('en');
    expect(result.languageConfidence).toBeGreaterThan(0.9);
  });
  it('logs only closed diagnostics and uses fixed labels without text, language, or Entry IDs', async () => {
    const lines: string[] = [],
      logger = createLogger('info', {
        write: (line) => {
          lines.push(line);
        },
      });
    const metrics = new Metrics(new Set(['test-model']));
    const diagnostic: LanguageDiagnostic = {
      source: 'fallback',
      outcome: 'failed',
      reason: 'invalid_response',
      language: null,
      duration_ms: 4,
    };
    logger.log('warn', 'language_detected', {
      entry_id: 1,
      language_detection: diagnostic,
    });
    metrics.language(diagnostic);
    logger.log('warn', 'language_detected', {
      language_detection: { ...diagnostic, language: 'secret article text' },
    });
    expect(lines.join('')).not.toContain('secret article text');
    expect(lines.join('')).toContain('log_payload_rejected');
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'mfai_language_detections_total{source="fallback",outcome="failed",reason="invalid_response"} 1',
    );
    expect(text).not.toContain('entry_id');
    expect(() =>
      metrics.language({ ...diagnostic, reason: 'private error' as 'timeout' }),
    ).toThrow();
  });
});

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

describe('review before immutable first-ingest facts and admission', () => {
  it('uses reviewed language for Scope and intrinsic Translation skip without configuration', async () => {
    const f = await setup(
      'features:\n  summary:\n    min_source_units: 1\n    scope:\n      fallback_action: deny\n      rules:\n        - name: Chinese\n          action: allow\n          match:\n            primary_languages: [zh]\n',
    );
    f.upstream.languageHandler = (r) => chat(label(r, 'zh'));
    const raw = entry(1, '<p>简短文章</p>');
    f.upstream.entries.set(1, raw);
    await f.service.ingest.webhook({ entries: [raw, raw] });
    expect(f.upstream.languageInputs).toHaveLength(1);
    expect(f.service.repository.entry(1)).toMatchObject({
      primary_language: 'zh',
      language_confidence: 1,
    });
    expect(f.service.repository.featureStates(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'translation',
          state: 'skipped',
          skip_reason: 'language_not_required',
        }),
        expect.objectContaining({ kind: 'summary', state: 'pending' }),
      ]),
    );
    await f.service.ingest.poll();
    await f.service.ingest.webhook({ entries: [raw] });
    expect(f.upstream.languageInputs).toHaveLength(1);
    const dump =
      JSON.stringify(f.service.db.all('SELECT * FROM entries')) +
      JSON.stringify(f.service.db.all('SELECT * FROM tasks'));
    expect(dump).not.toContain('简短文章');
    expect(dump).not.toContain('"parts"');
  });
  it('falls back on malformed output and keeps polling and unknown-language Translation working', async () => {
    const f = await setup();
    f.upstream.languageHandler = () => chat({ code: 'zh', confidence: 1 });
    f.upstream.entries.set(1, entry());
    await f.service.ingest.poll();
    expect(f.service.repository.cursor()).toBe(1);
    expect(f.service.repository.entry(1)).toMatchObject({
      primary_language: null,
      language_confidence: null,
    });
    expect(f.service.repository.featureStates(1)).toContainEqual(
      expect.objectContaining({ kind: 'translation', state: 'pending' }),
    );
  });
  it('validates the whole webhook batch before sending any Source to the model', async () => {
    const f = await setup();
    await expect(
      f.service.ingest.webhook({
        entries: [entry(), { ...entry(2), published_at: 'invalid' }],
      }),
    ).rejects.toThrow();
    expect(f.upstream.languageInputs).toHaveLength(0);
    expect(f.service.repository.entry(1)).toBeUndefined();
  });
  it.each(['abort', 'binding'])(
    'prevents writes when %s occurs while review is in flight',
    async (kind) => {
      const f = await setup(),
        controller = new AbortController();
      f.upstream.languageHandler = (r) => {
        if (kind === 'abort') controller.abort();
        else f.service.binding.stop();
        return chat(label(r, 'en'));
      };
      await expect(
        f.service.ingest.webhook({ entries: [entry()] }, controller.signal),
      ).rejects.toThrow();
      expect(f.service.repository.entry(1)).toBeUndefined();
      expect(f.service.repository.listTasks({})).toHaveLength(0);
    },
  );
  it('uses first committed facts if another intake wins during a Backfill review', async () => {
    const f = await setup();
    f.upstream.entries.set(1, entry());
    f.upstream.entries.set(2, entry(2, '<p>Excluded feed</p>', 2));
    f.upstream.feeds.set(2, feed(2));
    f.upstream.languageHandler = (r) => {
      f.service.repository.insertEntry(
        compact(1, { primary_language: 'zh', language_confidence: 1 }),
      );
      return chat(label(r, 'en'));
    };
    const created = await f.app.inject({
      method: 'POST',
      url: '/admin/backfill',
      headers: auth,
      payload: {
        limit: 10,
        feed_ids: [1],
        features: ['translation'],
        dry_run: false,
      },
    });
    expect(created.statusCode).toBe(202);
    await f.drain();
    expect(f.service.repository.task(created.json().id)).toMatchObject({
      state: 'done',
      last_error: null,
    });
    expect(f.upstream.languageInputs).toHaveLength(1);
    expect(f.service.repository.entry(2)).toBeUndefined();
    expect(f.service.repository.featureStates(1)).toContainEqual(
      expect.objectContaining({
        kind: 'translation',
        state: 'skipped',
        skip_reason: 'language_not_required',
      }),
    );
  });
});
