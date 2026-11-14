import { expect, it } from 'vitest';
import {
  artifactStats,
  digestStats,
  mergeDigestStats,
} from '../src/ai/stats.js';
import {
  aiExecutionSchema,
  artifactStatsSchema,
  digestStatsSchema,
} from '../src/db/documents.js';
import type { CallStat } from '../src/ai/client.js';
const call = (
  provider_id: string,
  model: string,
  outcome: CallStat['outcome'],
): CallStat => ({
  provider_id,
  model,
  outcome,
  operation: 'generate_artifacts',
  duration_ms: 10,
  finish_reason: 'stop',
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
});
it('attributes every physical attempt to its actual provider/model without mixing their usage', () => {
  const stats = artifactStats([
    call('primary', 'model-a', 'failed'),
    call('backup', 'model-b', 'succeeded'),
  ]);
  expect(stats).toMatchObject({
    schema_version: 2,
    request_count: 2,
    total_duration_ms: 20,
    usage: { total_tokens: 10 },
    providers: [
      {
        provider_id: 'primary',
        model: 'model-a',
        request_count: 1,
        usage: { total_tokens: 5 },
      },
      {
        provider_id: 'backup',
        model: 'model-b',
        request_count: 1,
        usage: { total_tokens: 5 },
      },
    ],
  });
  expect(() =>
    artifactStatsSchema.parse({ ...stats, request_count: 3 }),
  ).toThrow();
});
it('reads legacy evidence and upgrades Digest totals without inventing historical provider identities', () => {
  const current = digestStats([
    {
      ...call('backup', 'new-model', 'succeeded'),
      operation: 'generate_digest_item',
    },
  ]);
  const { providers, ...base } = current;
  void providers;
  const legacy = { ...base, schema_version: 1, model: 'old-model' };
  const combined = mergeDigestStats(digestStatsSchema.parse(legacy), current);
  expect(combined).toMatchObject({
    schema_version: 2,
    request_count: 2,
    providers: [
      { provider_id: null, model: 'old-model' },
      { provider_id: 'backup', model: 'new-model' },
    ],
  });
  expect(digestStatsSchema.parse(combined)).toEqual(combined);
  const next = mergeDigestStats(combined, current);
  expect(next.providers).toHaveLength(2);
  expect(next.providers[1]!.request_count).toBe(2);
  expect(() =>
    digestStatsSchema.parse({
      ...next,
      providers: [...next.providers, next.providers[0]],
    }),
  ).toThrow();
  expect(() =>
    aiExecutionSchema.parse({
      base_url: 'https://old.test/v1',
      model: 'old-model',
      request_timeout_ms: 1000,
      ai_envelope_protocol_version: 1,
    }),
  ).toThrow();
  expect(
    aiExecutionSchema.parse({
      schema_version: 2,
      ai_envelope_protocol_version: 1,
    }),
  ).toEqual({ schema_version: 2, ai_envelope_protocol_version: 1 });
});
