import { z } from 'zod';
import type {
  BackfillProgress,
  CurrentDigestStats,
  TaskPayloads,
  ProviderStats,
} from './types.js';
import {
  nonempty,
  nonnegative,
  positive,
  safeId,
  timestamp,
  canonicalLanguage,
  normalizeBaseUrl,
  templateParts,
  canonicalJson,
} from '../config/primitives.js';
import { primarySubtag, scopeMatchSchema } from '../config/scope.js';
const version = z.literal(1);
const language = nonempty.refine((v) => {
  try {
    return canonicalLanguage(v) === v;
  } catch {
    return false;
  }
});
const baseUrl = z.string().refine((v) => {
  try {
    return normalizeBaseUrl(v) === v;
  } catch {
    return false;
  }
});
const orderedIds = z
  .array(safeId)
  .refine((v) => v.every((id, i) => i === 0 || id > v[i - 1]));
export const featureKind = z.enum(['translation', 'summary']);
export const requestedFeatures = z
  .array(featureKind)
  .nonempty()
  .refine(
    (v) =>
      JSON.stringify(v) ===
      JSON.stringify(
        (['translation', 'summary'] as const).filter((k) => v.includes(k)),
      ),
  );
export const retryPolicySchema = z
  .object({
    initial_delay_ms: positive,
    multiplier: z.number().min(1),
    max_delay_ms: positive,
    jitter_ratio: z.number().min(0).max(1),
    max_attempts: positive,
  })
  .strict()
  .refine((v) => v.max_delay_ms >= v.initial_delay_ms);
export const aiExecutionSchema = z
  .object({
    schema_version: z.literal(2),
    ai_envelope_protocol_version: version,
  })
  .strict();
export const durableScopeSchema = z
  .object({
    fallback_action: z.enum(['allow', 'deny']),
    rules: z.array(
      z
        .object({
          name: nonempty,
          action: z.enum(['allow', 'deny']),
          match: z
            .unknown()
            .superRefine((value, ctx) => {
              const parsed = scopeMatchSchema.safeParse(value);
              if (
                !parsed.success ||
                canonicalJson(value) !== canonicalJson(parsed.data)
              )
                ctx.addIssue({
                  code: 'custom',
                  message: 'noncanonical_scope_match',
                });
            })
            .pipe(scopeMatchSchema),
        })
        .strict(),
    ),
  })
  .strict()
  .refine((v) => new Set(v.rules.map((r) => r.name)).size === v.rules.length);
const translationTemplate = nonempty.refine((v) => {
  try {
    templateParts(v, ['translated', 'original'], ['translated', 'original']);
    return true;
  } catch {
    return false;
  }
});
export const translationWorkSchema = z
  .object({
    instruction: nonempty,
    target_language: language,
    title_template: translationTemplate,
  })
  .strict();
export const summaryWorkSchema = z
  .object({
    instruction: nonempty,
    output_language: language,
    format: z.enum(['paragraph', 'bullets']),
    max_output_units: positive,
    heading: nonempty,
  })
  .strict();
const matchingFeatures = (v: {
  requested_features: ('translation' | 'summary')[];
  translation?: unknown;
  summary?: unknown;
}) =>
  (['translation', 'summary'] as const).every(
    (kind) => (v[kind] !== undefined) === v.requested_features.includes(kind),
  );
export const generatePayloadSchema = z
  .object({
    schema_version: version,
    requested_features: requestedFeatures,
    ai: aiExecutionSchema,
    retry_policy: retryPolicySchema,
    translation: translationWorkSchema.optional(),
    summary: summaryWorkSchema.optional(),
  })
  .strict()
  .refine(matchingFeatures);
export const renderPayloadSchema = z
  .object({
    schema_version: version,
    render_generation: positive,
    retry_policy: retryPolicySchema,
  })
  .strict();
export const digestSnapshotSchema = z
  .object({
    schema_version: version,
    job_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    output_language: language,
    summary_reuse_enabled: z.boolean(),
    ai: aiExecutionSchema,
    retry_policy: retryPolicySchema,
    prompts: z.object({ item_summary: nonempty, overview: nonempty }).strict(),
    scope: durableScopeSchema,
    selection: z
      .object({
        max_entries: positive,
        max_entries_per_feed: positive,
        min_item_source_units: nonnegative,
      })
      .strict(),
    generation: z.object({ max_item_summary_units: positive }).strict(),
    output: z
      .object({
        partition_by: z.enum(['all', 'category']),
        public_base_url: baseUrl,
        feed_title_template: nonempty,
        destination_category_id: safeId.nullable(),
        existing_feed_id: safeId.nullable(),
        include_feed_site_url: z.boolean(),
        entry_title_template: nonempty,
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.output.partition_by === 'all' || v.output.existing_feed_id === null,
  );
export const digestPayloadSchema = z
  .object({
    schema_version: version,
    digest_run_id: safeId,
    config_snapshot: digestSnapshotSchema,
  })
  .strict();
export const backfillPayloadSchema = z
  .object({
    schema_version: version,
    since_ms: timestamp.nullable(),
    until_ms: timestamp.nullable(),
    feed_ids: orderedIds,
    category_ids: orderedIds,
    limit: positive,
    dry_run: z.boolean(),
    page_size: positive.max(1000),
    requested_features: requestedFeatures,
    ai: aiExecutionSchema,
    retry_policy: retryPolicySchema,
    translation: translationWorkSchema
      .extend({
        skip_languages: z.array(primarySubtag),
        scope: durableScopeSchema,
      })
      .strict()
      .optional(),
    summary: summaryWorkSchema
      .extend({
        min_source_units: positive,
        schedule_cron: nonempty.nullable(),
        scope: durableScopeSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(matchingFeatures)
  .refine(
    (v) =>
      v.since_ms === null || v.until_ms === null || v.since_ms < v.until_ms,
  );
export const backfillProgressSchema = z
  .object({
    schema_version: version,
    after_entry_id: nonnegative,
    examined_entries: nonnegative,
    admitted_entries: nonnegative,
    rejected_entries: nonnegative,
    marker_shaped_id_count: nonnegative,
  })
  .strict();
export const emptyBackfillProgress = (): BackfillProgress => ({
  schema_version: 1,
  after_entry_id: 0,
  examined_entries: 0,
  admitted_entries: 0,
  rejected_entries: 0,
  marker_shaped_id_count: 0,
});
const blockId = z.string().regex(/^[a-f0-9]{12}$/);
const outcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('translated'), text: nonempty }).strict(),
  z.object({ status: z.literal('unchanged') }).strict(),
]);
export const translationArtifactSchema = z
  .object({
    schema_version: z.union([version, z.literal(2)]),
    title: outcome.nullable(),
    blocks: z.array(
      z.discriminatedUnion('status', [
        z
          .object({
            id: blockId,
            status: z.literal('translated'),
            text: nonempty,
          })
          .strict(),
        z.object({ id: blockId, status: z.literal('unchanged') }).strict(),
      ]),
    ),
  })
  .strict()
  .refine((v) => new Set(v.blocks.map((b) => b.id)).size === v.blocks.length);
export const summaryArtifactSchema = z.discriminatedUnion('format', [
  z
    .object({
      schema_version: version,
      format: z.literal('paragraph'),
      text: nonempty,
    })
    .strict(),
  z
    .object({
      schema_version: version,
      format: z.literal('bullets'),
      items: z.array(nonempty).nonempty(),
    })
    .strict(),
]);
export const translationRenderSchema = z
  .object({ schema_version: version, title_template: translationTemplate })
  .strict();
export const summaryRenderSchema = z
  .object({ schema_version: version, heading: nonempty })
  .strict();
const usage = z
  .object({
    reported_request_count: nonnegative,
    prompt_tokens: nonnegative,
    completion_tokens: nonnegative,
    total_tokens: nonnegative,
  })
  .strict();
const finishReasons = z
  .object({
    stop: nonnegative,
    length: nonnegative,
    content_filter: nonnegative,
    other: nonnegative,
    missing: nonnegative,
  })
  .strict();
export const artifactOperations = [
  'generate_artifacts',
  'repair_translation',
  'repair_summary',
  'merge_summary_partials',
] as const;
export const digestOperations = [
  'generate_digest_item',
  'merge_digest_item_partials',
  'generate_digest_overview',
  'merge_digest_overview_partials',
] as const;
const sumsValid = (v: {
  usage: { reported_request_count: number };
  request_count: number;
  finish_reasons: Record<string, number>;
}) =>
  v.usage.reported_request_count <= v.request_count &&
  Object.values(v.finish_reasons).reduce((a, b) => a + b, 0) ===
    v.request_count;
const legacyArtifactStatsSchema = z
  .object({
    schema_version: version,
    model: nonempty,
    ai_envelope_protocol_version: version,
    operations: z.array(z.enum(artifactOperations)).nonempty(),
    request_count: positive,
    total_duration_ms: nonnegative,
    usage,
    finish_reasons: finishReasons,
  })
  .strict()
  .refine((v) => v.request_count === v.operations.length && sumsValid(v));
const legacyDigestStatsSchema = z
  .object({
    schema_version: version,
    model: nonempty,
    ai_envelope_protocol_version: version,
    operation_counts: z
      .object({
        generate_digest_item: nonnegative,
        merge_digest_item_partials: nonnegative,
        generate_digest_overview: nonnegative,
        merge_digest_overview_partials: nonnegative,
      })
      .strict(),
    request_count: nonnegative,
    total_duration_ms: nonnegative,
    usage,
    finish_reasons: finishReasons,
    outcomes: z
      .object({ succeeded: nonnegative, failed: nonnegative })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      sumsValid(v) &&
      Object.values(v.operation_counts).reduce((a, b) => a + b, 0) ===
        v.request_count &&
      v.outcomes.succeeded + v.outcomes.failed === v.request_count,
  );
export const providerStatsSchema = z
  .object({
    provider_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .nullable(),
    model: nonempty,
    request_count: positive,
    total_duration_ms: nonnegative,
    usage,
  })
  .strict()
  .refine((v) => v.usage.reported_request_count <= v.request_count);
const breakdown = {
  schema_version: z.literal(2),
  providers: z.array(providerStatsSchema),
};
const currentArtifactStatsSchema = z
  .object(legacyArtifactStatsSchema.shape)
  .omit({ schema_version: true, model: true })
  .extend(breakdown)
  .strict();
const currentDigestStatsSchema = z
  .object(legacyDigestStatsSchema.shape)
  .omit({ schema_version: true, model: true })
  .extend(breakdown)
  .strict();
const providersValid = (v: {
  providers: ProviderStats[];
  request_count: number;
  total_duration_ms: number;
  usage: ProviderStats['usage'];
}) =>
  new Set(v.providers.map((p) => JSON.stringify([p.provider_id, p.model])))
    .size === v.providers.length &&
  v.providers.reduce((n, p) => n + p.request_count, 0) === v.request_count &&
  v.providers.reduce((n, p) => n + p.total_duration_ms, 0) ===
    v.total_duration_ms &&
  (Object.keys(v.usage) as (keyof ProviderStats['usage'])[]).every(
    (k) => v.providers.reduce((n, p) => n + p.usage[k], 0) === v.usage[k],
  );
export const artifactStatsSchema = z.union([
  legacyArtifactStatsSchema,
  currentArtifactStatsSchema.refine(
    (v) =>
      sumsValid(v) &&
      v.request_count === v.operations.length &&
      providersValid(v),
  ),
]);
export const digestStatsSchema = z.union([
  legacyDigestStatsSchema,
  currentDigestStatsSchema.refine(
    (v) =>
      sumsValid(v) &&
      Object.values(v.operation_counts).reduce((a, b) => a + b, 0) ===
        v.request_count &&
      v.outcomes.succeeded + v.outcomes.failed === v.request_count &&
      providersValid(v),
  ),
]);
export const failureClasses = [
  'network',
  'timeout',
  'rate_limited',
  'upstream_5xx',
  'overload',
  'context_overflow',
  'request_too_large',
  'output_truncated',
  'invalid_response',
  'auth',
  'invalid_request',
  'not_found',
  'tombstoned',
  'validation',
  'integrity',
  'unsupported_version',
  'repository',
] as const;
export const integrityStages = [
  'pre_put_block_plan_join',
  'pre_put_sanitizer',
  'put_response_markers',
  'put_response_source_signature',
  'put_response_title',
] as const;
export const lastErrorSchema = z
  .object({
    schema_version: version,
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    failure_class: z.enum(failureClasses),
    http_status: z.number().int().min(100).max(599).nullable(),
    retryable: z.boolean(),
    upstream_request_id: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .nullable(),
    miniflux_version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .nullable(),
    integrity_stage: z.enum(integrityStages).nullable(),
  })
  .strict()
  .refine((v) =>
    v.code === 'render_integrity_failed'
      ? v.failure_class === 'integrity' &&
        !v.retryable &&
        v.miniflux_version !== null &&
        v.integrity_stage !== null &&
        (v.integrity_stage !== 'pre_put_block_plan_join' ||
          (v.http_status === null && v.upstream_request_id === null))
      : v.miniflux_version === null && v.integrity_stage === null,
  );
export const bindingSchema = z
  .object({ schema_version: version, base_url: baseUrl, user_id: safeId })
  .strict();
export const cursorSchema = z
  .object({ schema_version: version, after_entry_id: nonnegative })
  .strict();
export const taskSchemas = {
  generate_artifacts: generatePayloadSchema,
  render: renderPayloadSchema,
  digest: digestPayloadSchema,
  ingest_backfill: backfillPayloadSchema,
};
export function retryPolicyOf(payload: TaskPayloads[keyof TaskPayloads]) {
  return 'config_snapshot' in payload
    ? payload.config_snapshot.retry_policy
    : payload.retry_policy;
}
export function zeroDigestStats(): CurrentDigestStats {
  return {
    schema_version: 2,
    providers: [],
    ai_envelope_protocol_version: 1,
    operation_counts: {
      generate_digest_item: 0,
      merge_digest_item_partials: 0,
      generate_digest_overview: 0,
      merge_digest_overview_partials: 0,
    },
    request_count: 0,
    total_duration_ms: 0,
    usage: {
      reported_request_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    finish_reasons: {
      stop: 0,
      length: 0,
      content_filter: 0,
      other: 0,
      missing: 0,
    },
    outcomes: { succeeded: 0, failed: 0 },
  };
}
