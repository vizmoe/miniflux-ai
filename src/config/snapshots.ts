import { durationMs, languageIdentity } from './primitives.js';
import type { Config, DigestJob } from './index.js';
import type {
  AiExecution,
  FeatureKind,
  GeneratePayload,
  DigestSnapshot,
} from '../db/types.js';
export const retrySnapshot = (c: Config) => ({
  initial_delay_ms: durationMs(c.queue.retry.initial_delay),
  max_delay_ms: durationMs(c.queue.retry.max_delay),
  multiplier: c.queue.retry.multiplier,
  jitter_ratio: c.queue.retry.jitter_ratio,
  max_attempts: c.queue.retry.max_attempts,
});
export const aiSnapshot = (): AiExecution => ({
  schema_version: 2,
  ai_envelope_protocol_version: 1,
});
export function generationSnapshot(
  c: Config,
  features: FeatureKind[],
  sourceUnits: number,
): GeneratePayload {
  return {
    schema_version: 1,
    requested_features: (['translation', 'summary'] as const).filter((k) =>
      features.includes(k),
    ),
    ai: aiSnapshot(),
    retry_policy: retrySnapshot(c),
    ...(features.includes('translation')
      ? {
          translation: {
            instruction: c.prompts.translation,
            target_language:
              c.features.translation.target_language ?? c.output_language,
            title_template: c.features.translation.title_template,
          },
        }
      : {}),
    ...(features.includes('summary')
      ? {
          summary: {
            instruction: c.prompts.summary,
            output_language: c.output_language,
            format: c.features.summary.format,
            max_output_units: Math.min(
              sourceUnits,
              c.features.summary.max_output_units,
            ),
            heading: c.features.summary.heading,
          },
        }
      : {}),
  };
}
export function backfillSpecs(c: Config, features: FeatureKind[]) {
  const generation = generationSnapshot(
    c,
    features,
    c.features.summary.max_output_units,
  );
  return {
    ai: generation.ai,
    retry_policy: generation.retry_policy,
    requested_features: generation.requested_features,
    ...(generation.translation
      ? {
          translation: {
            ...generation.translation,
            skip_languages: skipLanguages(c),
            scope: c.features.translation.scope,
          },
        }
      : {}),
    ...(generation.summary
      ? {
          summary: {
            ...generation.summary,
            min_source_units: c.features.summary.min_source_units,
            schedule_cron: c.features.summary.schedule.cron,
            scope: c.features.summary.scope,
          },
        }
      : {}),
  };
}
export function skipLanguages(c: Config) {
  return c.features.translation.skip_languages === ''
    ? []
    : [
        ...new Set(
          c.features.translation.skip_languages
            .split(',')
            .map((v) => languageIdentity(v.trim())),
        ),
      ];
}
export function digestSnapshot(c: Config, job: DigestJob): DigestSnapshot {
  return {
    schema_version: 1,
    job_id: job.id,
    output_language: c.output_language,
    summary_reuse_enabled: c.features.summary.enabled,
    ai: aiSnapshot(),
    retry_policy: retrySnapshot(c),
    prompts: c.prompts.digest,
    scope: job.scope,
    selection: {
      max_entries: job.max_entries,
      max_entries_per_feed: job.max_entries_per_feed,
      min_item_source_units: job.min_item_source_units,
    },
    generation: { max_item_summary_units: job.max_item_summary_units },
    output: {
      ...job.output,
      public_base_url: c.features.digest.public_base_url!,
      include_feed_site_url: job.include_feed_site_url,
      entry_title_template: job.entry_title_template,
    },
  };
}
