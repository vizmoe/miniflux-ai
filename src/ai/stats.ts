import {
  artifactStatsSchema,
  digestStatsSchema,
  zeroDigestStats,
} from '../db/documents.js';
import type {
  CurrentDigestStats,
  DigestStats,
  ProviderStats,
} from '../db/documents.js';
import type { CallStat } from './client.js';

type Totals = Pick<
  CurrentDigestStats,
  'total_duration_ms' | 'finish_reasons' | 'usage' | 'providers'
>;

function addNumbers<K extends string>(
  total: Record<K, number>,
  delta: Record<K, number>,
) {
  for (const key of Object.keys(total) as K[]) total[key] += delta[key];
}

function mergeProviders(total: ProviderStats[], delta: ProviderStats[]) {
  for (const row of delta) {
    const saved = total.find(
      (p) => p.provider_id === row.provider_id && p.model === row.model,
    );
    if (!saved) {
      total.push(structuredClone(row));
      continue;
    }
    saved.request_count += row.request_count;
    saved.total_duration_ms += row.total_duration_ms;
    addNumbers(saved.usage, row.usage);
  }
}

function addCall(stats: Totals, call: CallStat) {
  stats.total_duration_ms += call.duration_ms;
  stats.finish_reasons[call.finish_reason]++;
  const provider: ProviderStats = {
    provider_id: call.provider_id,
    model: call.model,
    request_count: 1,
    total_duration_ms: call.duration_ms,
    usage: zeroDigestStats().usage,
  };
  if (call.usage) {
    provider.usage.reported_request_count = 1;
    Object.assign(provider.usage, call.usage);
    addNumbers(stats.usage, provider.usage);
  }
  mergeProviders(stats.providers, [provider]);
}

export function artifactStats(calls: CallStat[]) {
  const {
    operation_counts: _operations,
    outcomes: _outcomes,
    ...stats
  } = zeroDigestStats();
  stats.request_count = calls.length;
  for (const call of calls) addCall(stats, call);
  return artifactStatsSchema.parse({
    ...stats,
    operations: calls.map((c) => c.operation),
  });
}

export function digestStats(calls: CallStat[]) {
  const result = zeroDigestStats();
  for (const call of calls) {
    if (!(call.operation in result.operation_counts))
      throw new Error('invalid_digest_operation');
    result.operation_counts[
      call.operation as keyof CurrentDigestStats['operation_counts']
    ]++;
    result.outcomes[call.outcome]++;
    result.request_count++;
    addCall(result, call);
  }
  return result;
}

function providersOf(value: DigestStats): ProviderStats[] {
  if (value.schema_version === 2) return value.providers;
  if (!value.request_count) return [];
  return [
    {
      provider_id: null,
      model: value.model,
      request_count: value.request_count,
      total_duration_ms: value.total_duration_ms,
      usage: value.usage,
    },
  ];
}

export function mergeDigestStats(
  total: DigestStats,
  delta: DigestStats,
): CurrentDigestStats {
  const result = zeroDigestStats();
  for (const value of [total, delta]) {
    digestStatsSchema.parse(value);
    result.request_count += value.request_count;
    result.total_duration_ms += value.total_duration_ms;
    addNumbers(result.operation_counts, value.operation_counts);
    addNumbers(result.usage, value.usage);
    addNumbers(result.finish_reasons, value.finish_reasons);
    addNumbers(result.outcomes, value.outcomes);
    mergeProviders(result.providers, providersOf(value));
  }
  digestStatsSchema.parse(result);
  return result;
}
