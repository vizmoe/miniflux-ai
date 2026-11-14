import { pino } from 'pino';
import type { DestinationStream } from 'pino';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { z } from 'zod';
import {
  artifactOperations,
  digestOperations,
  lastErrorSchema,
} from '../db/documents.js';
import type { AiOperation, FeatureKind, TaskType } from '../db/documents.js';
import { safeId } from '../config/primitives.js';
import type { Repository } from '../db/repository.js';
import { languageDiagnosticSchema } from '../lang/contracts.js';
import type { LanguageDiagnostic } from '../lang/contracts.js';

const events = z.enum([
  'service_started',
  'service_stopped',
  'operation_failed',
  'entry_rejected',
  'task_settled',
  'log_payload_rejected',
  'webhook_admitted',
  'webhook_rejected',
  'language_detected',
  'entry_reconciled',
]);
const fieldsSchema = z
  .object({
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .optional(),
    entry_id: safeId.optional(),
    task_id: safeId.optional(),
    job_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    partition_key: z
      .string()
      .regex(/^(all|category:[1-9]\d*)$/)
      .optional(),
    digest_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    operation: z
      .enum(['startup', 'recovery', 'poll', 'summaries', 'digest', 'shutdown'])
      .optional(),
    reason: z
      .enum([
        'entry_metadata_invalid',
        'feed_metadata_invalid',
        'category_metadata_invalid',
      ])
      .optional(),
    error: lastErrorSchema.optional(),
    language_detection: languageDiagnosticSchema.optional(),
    recovery_outcome: z
      .enum([
        'unchanged',
        'restored',
        'regenerated',
        'busy',
        'missing',
        'failed',
      ])
      .optional(),
  })
  .strict();
export function createLogger(
  level: 'debug' | 'info' | 'warn' | 'error',
  destination?: DestinationStream,
) {
  const logger = pino({ level, base: null }, destination);
  return {
    log(
      severity: 'debug' | 'info' | 'warn' | 'error',
      event: z.infer<typeof events>,
      fields: z.infer<typeof fieldsSchema> = {},
    ) {
      const parsed = fieldsSchema.safeParse(fields),
        name = events.safeParse(event);
      if (!parsed.success || !name.success) {
        logger.warn({ event: 'log_payload_rejected' });
        return;
      }
      logger[severity]({ event: name.data, ...parsed.data });
    },
  };
}
export type SafeLogger = ReturnType<typeof createLogger>;
const taskTypes = [
  'generate_artifacts',
  'render',
  'digest',
  'ingest_backfill',
] as const;
export class Metrics {
  readonly registry = new Registry();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  constructor(private readonly models: Set<string>) {
    for (const [name, labels] of Object.entries({
      tasks_total: ['type', 'outcome'],
      tasks_dead_total: ['type'],
      feature_state_transitions_total: ['feature', 'to'],
      ai_requests_total: ['model', 'operation', 'mode', 'outcome'],
      ai_degradation_total: ['level'],
      miniflux_requests_total: ['endpoint', 'status'],
      entries_rendered_total: [],
      digest_runs_total: ['job_id', 'partition_key', 'outcome'],
      digest_candidate_exclusions_total: ['job_id', 'reason'],
      feature_admission_denials_total: ['feature', 'reason'],
      feature_skips_total: ['feature', 'reason'],
      ingest_rejected_entries_total: ['source', 'reason'],
      language_detections_total: ['source', 'outcome', 'reason'],
      entry_recovery_total: ['outcome'],
    }))
      this.counters.set(
        name,
        new Counter({
          name: `mfai_${name}`,
          help: `miniflux-ai ${name.replaceAll('_', ' ')}`,
          labelNames: labels,
          registers: [this.registry],
        }),
      );
    for (const [name, labels] of Object.entries({
      tasks_inflight: ['type'],
      entries_render_pending: [],
      digest_feed_ready: ['job_id', 'partition_key'],
      digest_runs_awaiting_output_feed: ['job_id', 'partition_key'],
      digest_oldest_awaiting_output_feed_age_seconds: [
        'job_id',
        'partition_key',
      ],
      subsystem_ready: ['subsystem'],
    }))
      this.gauges.set(
        name,
        new Gauge({
          name: `mfai_${name}`,
          help: `miniflux-ai ${name.replaceAll('_', ' ')}`,
          labelNames: labels,
          registers: [this.registry],
        }),
      );
    for (const [name, labels, buckets] of [
      ['task_duration_seconds', ['type'], [0.01, 0.1, 1, 10, 60, 300, 1800]],
      ['ai_request_bytes', [], [1024, 4096, 16384, 65536, 262144, 1048576]],
      ['entry_content_units', [], [0, 20, 100, 200, 600, 2000, 10000, 100000]],
      ['language_detection_duration_seconds', [], [0.001, 0.01, 0.1, 1, 5, 10]],
    ] as Array<[string, string[], number[]]>)
      this.histograms.set(
        name,
        new Histogram({
          name: `mfai_${name}`,
          help: `miniflux-ai ${name.replaceAll('_', ' ')}`,
          labelNames: labels,
          buckets,
          registers: [this.registry],
        }),
      );
  }
  ai(
    model: string,
    operation: AiOperation,
    mode: 'joint' | 'single',
    outcome: 'succeeded' | 'failed',
    bytes: number,
  ): void {
    if (
      !this.models.has(model) ||
      ![...artifactOperations, ...digestOperations, 'detect_language'].includes(
        operation,
      ) ||
      !['joint', 'single'].includes(mode) ||
      !['succeeded', 'failed'].includes(outcome) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    )
      throw new Error('invalid_metric_labels');
    this.counters
      .get('ai_requests_total')!
      .inc({ model, operation, mode, outcome });
    this.histograms.get('ai_request_bytes')!.observe(bytes);
  }
  language(diagnostic: LanguageDiagnostic): void {
    const { source, outcome, reason, duration_ms } =
      languageDiagnosticSchema.parse(diagnostic);
    this.counters
      .get('language_detections_total')!
      .inc({ source, outcome, reason });
    this.histograms
      .get('language_detection_duration_seconds')!
      .observe(duration_ms / 1000);
  }
  degradation(level: number): void {
    if (!Number.isInteger(level) || level < 1 || level > 6)
      throw new Error('invalid_metric_labels');
    this.counters.get('ai_degradation_total')!.inc({ level: String(level) });
  }
  miniflux(endpoint: string, status: string): void {
    if (
      !/^\/v1\/(version|me|categories|entries(?:(?:\/:id))?|feeds(?:\/:id(?:\/entries\/import)?)?)$/.test(
        endpoint,
      ) ||
      !/^(network|[1-5]\d\d)$/.test(status)
    )
      throw new Error('invalid_metric_labels');
    this.counters.get('miniflux_requests_total')!.inc({ endpoint, status });
  }
  rendered(): void {
    this.counters.get('entries_rendered_total')!.inc();
  }
  recovery(
    outcome:
      'unchanged' | 'restored' | 'regenerated' | 'busy' | 'missing' | 'failed',
  ): void {
    this.counters.get('entry_recovery_total')!.inc({ outcome });
  }
  rejected(source: 'poll' | 'backfill', reason: string): void {
    if (
      !['poll', 'backfill'].includes(source) ||
      ![
        'entry_metadata_invalid',
        'feed_metadata_invalid',
        'category_metadata_invalid',
      ].includes(reason)
    )
      throw new Error('invalid_metric_labels');
    this.counters.get('ingest_rejected_entries_total')!.inc({ source, reason });
  }
  exclusion(job: string, reason: string): void {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job) ||
      ![
        'scope_denied',
        'content_too_short',
        'source_title_missing',
        'entry_url_invalid',
      ].includes(reason)
    )
      throw new Error('invalid_metric_labels');
    this.counters
      .get('digest_candidate_exclusions_total')!
      .inc({ job_id: job, reason });
  }
  admission(kind: FeatureKind, outcome: string): void {
    if (outcome === 'scope_denied')
      this.counters
        .get('feature_admission_denials_total')!
        .inc({ feature: kind, reason: outcome });
    else if (
      [
        'content_too_short',
        'language_not_required',
        'no_translatable_content',
      ].includes(outcome)
    )
      this.counters
        .get('feature_skips_total')!
        .inc({ feature: kind, reason: outcome });
  }
  feature(kind: FeatureKind, state: string): void {
    if (
      !['translation', 'summary'].includes(kind) ||
      ![
        'scheduled',
        'pending',
        'processing',
        'ready',
        'skipped',
        'failed',
      ].includes(state)
    )
      throw new Error('invalid_metric_labels');
    this.counters
      .get('feature_state_transitions_total')!
      .inc({ feature: kind, to: state });
  }
  task(type: TaskType, outcome: string, durationMs: number): void {
    if (
      !taskTypes.includes(type) ||
      !['done', 'dead', 'pending'].includes(outcome)
    )
      return;
    this.counters.get('tasks_total')!.inc({ type, outcome });
    if (outcome === 'dead')
      this.counters.get('tasks_dead_total')!.inc({ type });
    this.histograms
      .get('task_duration_seconds')!
      .observe({ type }, durationMs / 1000);
  }
  digest(job: string, partition: string, outcome: string): void {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job) ||
      !/^(all|category:[1-9]\d*)$/.test(partition) ||
      !['imported', 'failed', 'tombstoned'].includes(outcome)
    )
      throw new Error('invalid_metric_labels');
    this.counters
      .get('digest_runs_total')!
      .inc({ job_id: job, partition_key: partition, outcome });
  }
  sourceUnits(units: number): void {
    this.histograms.get('entry_content_units')!.observe(units);
  }
  refresh(
    repository: Repository,
    digest: {
      state: string;
      output_feeds: Array<{
        job_id: string;
        partition_key: string;
        state: string;
        awaiting_output_feed_run_count: number;
        oldest_awaiting_output_feed_since: number | null;
      }>;
    },
  ): void {
    for (const type of taskTypes)
      this.gauges
        .get('tasks_inflight')!
        .set(
          { type },
          repository.db.get<{ n: number }>(
            "SELECT count(*) AS n FROM tasks WHERE type=? AND state='leased'",
            type,
          )!.n,
        );
    this.gauges
      .get('entries_render_pending')!
      .set(
        repository.db.get<{ n: number }>(
          'SELECT count(*) AS n FROM entries WHERE render_generation>rendered_generation',
        )!.n,
      );
    this.gauges
      .get('subsystem_ready')!
      .set(
        { subsystem: 'digest' },
        Number(['ready', 'disabled'].includes(digest.state)),
      );
    for (const name of [
      'digest_feed_ready',
      'digest_runs_awaiting_output_feed',
      'digest_oldest_awaiting_output_feed_age_seconds',
    ])
      this.gauges.get(name)!.reset();
    for (const feed of digest.output_feeds) {
      const labels = { job_id: feed.job_id, partition_key: feed.partition_key };
      this.gauges
        .get('digest_feed_ready')!
        .set(labels, Number(feed.state === 'ready'));
      this.gauges
        .get('digest_runs_awaiting_output_feed')!
        .set(labels, feed.awaiting_output_feed_run_count);
      this.gauges
        .get('digest_oldest_awaiting_output_feed_age_seconds')!
        .set(
          labels,
          feed.oldest_awaiting_output_feed_since === null
            ? 0
            : Math.max(
                0,
                (repository.now() - feed.oldest_awaiting_output_feed_since) /
                  1000,
              ),
        );
    }
  }
}
