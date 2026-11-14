import { expect, it } from 'vitest';
import {
  artifactStats,
  digestStats,
  mergeDigestStats,
} from '../src/ai/stats.js';
import { zeroDigestStats } from '../src/db/documents.js';
import type { DigestStats } from '../src/db/types.js';
import type { CallStat } from '../src/ai/client.js';

const call: CallStat = {
  provider_id: 'primary',
  model: 'model-one',
  operation: 'generate_artifacts',
  duration_ms: 10,
  finish_reason: 'stop',
  outcome: 'succeeded',
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

it('accounts for failed calls and missing usage without inventing token counts', () => {
  const stats = artifactStats([
    call,
    {
      ...call,
      provider_id: 'backup',
      operation: 'repair_summary',
      duration_ms: 20,
      finish_reason: 'length',
      outcome: 'failed',
      usage: null,
    },
  ]);
  expect(stats).toMatchObject({
    schema_version: 2,
    request_count: 2,
    total_duration_ms: 30,
    operations: ['generate_artifacts', 'repair_summary'],
    finish_reasons: { stop: 1, length: 1 },
    usage: {
      reported_request_count: 1,
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    providers: [
      { provider_id: 'primary', request_count: 1 },
      {
        provider_id: 'backup',
        request_count: 1,
        usage: { reported_request_count: 0, total_tokens: 0 },
      },
    ],
  });
});

it('merges current digest totals by provider and model without mutating inputs', () => {
  const first = digestStats([{ ...call, operation: 'generate_digest_item' }]);
  const second = digestStats([
    { ...call, operation: 'generate_digest_item' },
    {
      ...call,
      model: 'model-two',
      operation: 'generate_digest_overview',
      outcome: 'failed',
      usage: null,
    },
  ]);
  const original = structuredClone([first, second]);
  const merged = mergeDigestStats(first, second);
  expect(merged).toMatchObject({
    request_count: 3,
    total_duration_ms: 30,
    operation_counts: { generate_digest_item: 2, generate_digest_overview: 1 },
    outcomes: { succeeded: 2, failed: 1 },
    usage: { reported_request_count: 2, total_tokens: 30 },
  });
  expect(merged.providers).toMatchObject([
    { provider_id: 'primary', model: 'model-one', request_count: 2 },
    { provider_id: 'primary', model: 'model-two', request_count: 1 },
  ]);
  expect([first, second]).toEqual(original);
  expect(() => digestStats([call])).toThrow('invalid_digest_operation');
});

it('retains legacy single-model statistics with an unknown provider identity', () => {
  const current = digestStats([{ ...call, operation: 'generate_digest_item' }]);
  const { providers: _providers, ...fields } = current;
  const legacy: DigestStats = {
    ...fields,
    schema_version: 1,
    model: 'legacy-model',
  };
  const merged = mergeDigestStats(legacy, current);
  expect(merged.schema_version).toBe(2);
  expect(merged.usage.total_tokens).toBe(30);
  expect(merged.providers).toMatchObject([
    { provider_id: null, model: 'legacy-model', request_count: 1 },
    { provider_id: 'primary', model: 'model-one', request_count: 1 },
  ]);
  const { providers: _emptyProviders, ...empty } = zeroDigestStats();
  expect(
    mergeDigestStats(
      { ...empty, schema_version: 1, model: 'legacy-model' },
      zeroDigestStats(),
    ).providers,
  ).toEqual([]);
  expect(() =>
    mergeDigestStats({ ...legacy, request_count: 9 }, current),
  ).toThrow();
});
