import type { YamlConfiguration } from '../config/store.js';
import type { FeatureKind, ArtifactInput } from '../db/types.js';
import type { AppLogger } from '../obs/index.js';
export interface ServiceOptions {
  root?: string;
  now?: () => number;
  fetch?: typeof fetch;
  logger?: AppLogger;
}
export type Service = Awaited<ReturnType<typeof createService>>;
import { MINIFLUX_SUPPORTED_VERSION } from '../config/constants.js';
import { ModelSettings } from '../admin/model.js';
import { ScopeSettings } from '../admin/scopes.js';
import { durationMs } from '../config/primitives.js';
import { Database } from '../db/database.js';
import { Repository } from '../db/repository.js';
import { DigestRepository } from '../db/digest.js';
import { generatePayloadSchema } from '../db/documents.js';
import { MinifluxClient } from '../miniflux/client.js';
import { BindingController } from '../miniflux/binding.js';
import { AiClient } from '../ai/client.js';
import { ArtifactGenerator } from '../generation/index.js';
import { translationSpecification } from '../features/translation/index.js';
import { summarySpecification } from '../features/summary/index.js';
import { DigestGenerator } from '../features/digest/generation.js';
import { DigestController } from '../features/digest/index.js';
import {
  MinifluxSourceReader,
  assertSourceCurrent,
  sourceFingerprint,
} from '../source/index.js';
import { LanguageDetector } from '../lang/index.js';
import { LanguageAnalyzer } from '../lang/review.js';
import { Renderer } from '../render/index.js';
import {
  extractSemanticBlocks,
  extractTranslationBlocks,
} from '../html/blocks.js';
import { parseSource } from '../html/dom.js';
import { EntryLock } from './concurrency.js';
import { AdmissionPolicy } from './admission.js';
import { EntryRecovery } from './recovery.js';
import { Ingest } from '../ingest/index.js';
import { Queue } from '../queue/index.js';
import { Scheduler } from '../scheduler/index.js';
import { Metrics, createLogger } from '../obs/index.js';
import { ApiError, safeWorkError } from '../obs/errors.js';
export async function createService(
  configuration: YamlConfiguration,
  options: ServiceOptions = {},
) {
  const config = configuration.read().config;
  const db = new Database(options.root),
    repository = new Repository(db, options.now),
    lock = new EntryLock();
  const models = new Set(config.ai.providers.map((p) => p.model));
  const metrics = new Metrics(models),
    logger = options.logger ?? createLogger(config.logging.level);
  repository.observe = {
    entry: (units) => metrics.sourceUnits(units),
    feature: (kind, state) => metrics.feature(kind, state),
    task: (type, state, duration) => metrics.task(type, state, duration),
    digest: (job, partition, state) => metrics.digest(job, partition, state),
  };
  const client = new MinifluxClient(
    config.miniflux,
    options.fetch,
    (endpoint, status) => metrics.miniflux(endpoint, status),
  );
  let started = false,
    stopped = false;
  const notifyActivation = () => {
    if (scheduler)
      void scheduler
        .requestActivation()
        .catch(() =>
          logger.log('error', 'operation_failed', { operation: 'digest' }),
        );
  };
  const binding = new BindingController(
    repository,
    client,
    config.miniflux.base_url,
    () => {
      if (started) scheduler?.recovered();
    },
    options.now,
  );
  const source = new MinifluxSourceReader(repository, client);
  const ai = new AiClient(
    config.ai.max_concurrent_requests,
    () => {
      const ai = configuration.read().config.ai;
      for (const p of ai.providers) models.add(p.model);
      return ai;
    },
    options.fetch,
    (...args) => metrics.ai(...args),
    options.now,
  );
  const modelSettings = new ModelSettings(
    configuration,
    config,
    () => ai.health(),
    () => {
      if (started) scheduler.recovered();
    },
  );
  const generator = new ArtifactGenerator(ai, (level) =>
    metrics.degradation(level),
  );
  const digestRepository = new DigestRepository(repository, (job, reason) =>
    metrics.exclusion(job, reason),
  );
  const digest = new DigestController(
    config,
    digestRepository,
    repository,
    client,
    binding,
    source,
    new DigestGenerator(ai, (level) => metrics.degradation(level)),
    notifyActivation,
  );
  const admission = new AdmissionPolicy(
    config,
    () => {
      binding.requireOpen();
      modelSettings.requireConfigured();
    },
    (kind, outcome) => metrics.admission(kind, outcome),
  );
  let detector;
  try {
    detector = await LanguageDetector.create();
  } catch (error) {
    db.close();
    throw error;
  }
  const language = new LanguageAnalyzer(detector, ai, (id, result) => {
    metrics.language(result);
    logger.log(
      result.outcome === 'failed' ? 'warn' : 'info',
      'language_detected',
      {
        entry_id: id,
        language_detection: result,
      },
    );
  });
  const recovery = new EntryRecovery(
    repository,
    client,
    source,
    language,
    admission,
    lock,
    config,
    () => binding.open && modelSettings.configured,
    (id, outcome, error) => {
      metrics.recovery(outcome);
      if (outcome !== 'unchanged' && outcome !== 'busy')
        logger.log(outcome === 'failed' ? 'warn' : 'info', 'entry_reconciled', {
          entry_id: id,
          recovery_outcome: outcome,
          ...(error ? { error } : {}),
        });
    },
  );
  const ingest = new Ingest(
    repository,
    client,
    language,
    admission,
    config,
    () => binding.open && modelSettings.configured,
    (source, reason, id) => {
      metrics.rejected(source, reason);
      logger.log('warn', 'entry_rejected', { entry_id: id, reason });
    },
  );
  const renderer = new Renderer(
    repository,
    source,
    client,
    lock,
    () => binding.lastStatus.version ?? MINIFLUX_SUPPORTED_VERSION,
    () => metrics.rendered(),
  );
  const reprocess = async (id: number, features: FeatureKind[]) => {
    admission.requireEnabled(features);
    return lock.with(id, async () => {
      const entry = repository.entry(id);
      if (!entry) throw new ApiError(404, 'entry_not_found');
      if (repository.activeGeneration(id))
        throw new ApiError(409, 'generation_in_progress');
      const loaded = await source.load(id),
        count = extractSemanticBlocks(parseSource(loaded.content)).blocks
          .length;
      const plan = admission.plan(entry, count, features, { force: true });
      admission.apply(repository, id, plan);
      return plan.outcomes;
    });
  };
  const summaries = async () => {
    admission.requireEnabled(['summary']);
    const rows = db.all<{ entry_id: number }>(
      config.features.summary.schedule.cron
        ? "SELECT entry_id FROM entry_feature_states WHERE kind='summary' AND state='scheduled' ORDER BY created_at,entry_id"
        : "SELECT entry_id FROM entry_feature_states WHERE kind='summary' AND current_artifact_id IS NULL ORDER BY created_at,entry_id",
    );
    let count = 0;
    for (const row of rows)
      await lock.with(row.entry_id, () => {
        if (repository.activeGeneration(row.entry_id)) return;
        const entry = repository.entry(row.entry_id)!;
        const plan = admission.plan(entry, 0, ['summary'], {
          force: true,
          ignoreScope: true,
        });
        admission.apply(repository, row.entry_id, plan);
        if (plan.payload) count++;
      });
    return count;
  };
  const queue = new Queue(
    repository,
    {
      generate_artifacts: async (task, context) => {
        const payload = generatePayloadSchema.parse(task.payload),
          entry = repository.entry(task.entry_id)!;
        const loaded = await source.load(entry.entry_id, context.signal),
          root = parseSource(loaded.content),
          plan = payload.translation
            ? extractTranslationBlocks(root)
            : extractSemanticBlocks(root),
          input = { title: loaded.title, blocks: plan.blocks };
        assertSourceCurrent(entry.source_fingerprint, loaded);
        const fingerprint = sourceFingerprint(loaded);
        const evidence = `${loaded.title}\n${root.textContent}\n${Array.from(
          root.querySelectorAll('*'),
        )
          .flatMap((el) => Array.from(el.attributes).map((a) => a.value))
          .join('\n')}`;
        const specs = {
          ...(payload.translation
            ? {
                translation: translationSpecification(
                  payload.translation,
                  input,
                ),
              }
            : {}),
          ...(payload.summary
            ? { summary: summarySpecification(payload.summary, evidence) }
            : {}),
        };
        const result = await generator.generate(input, specs, {
          ai: payload.ai,
          order: task,
          signal: context.signal,
          context: {
            feed_title: entry.source_feed_title,
            primary_language: entry.primary_language,
          },
          sections: plan.sections().map((section) => section.map((b) => b.id)),
        });
        await lock.with(
          entry.entry_id,
          async () => {
            context.assertOwned();
            const latest = await source.load(entry.entry_id, context.signal);
            assertSourceCurrent(fingerprint, latest);
            context.assertOwned();
            repository.establishSourceFingerprint(entry.entry_id, fingerprint);
            repository.completeGeneration(
              task,
              result.artifacts.map((artifact): ArtifactInput =>
                artifact.kind === 'translation'
                  ? {
                      ...artifact,
                      output_language: payload.translation!.target_language,
                      render_spec: {
                        schema_version: 1,
                        title_template: payload.translation!.title_template,
                      },
                    }
                  : {
                      ...artifact,
                      output_language: payload.summary!.output_language,
                      render_spec: {
                        schema_version: 1,
                        heading: payload.summary!.heading,
                      },
                    },
              ),
              result.failures,
            );
          },
          context.signal,
        );
      },
      render: (task, context) => renderer.run(task, context.signal),
      ingest_backfill: (task, context) => ingest.backfill(task, context.signal),
      digest: (task, context) => digest.run(task, context),
    },
    {
      concurrency: config.queue.worker_concurrency,
      leaseMs: durationMs(config.queue.lease_duration),
      gate: () => binding.open && modelSettings.configured,
      terminal: notifyActivation,
      observe: (task) => {
        if (task.last_error)
          logger.log('warn', 'task_settled', {
            task_id: task.id,
            error: task.last_error,
          });
      },
    },
  );
  const scheduler = new Scheduler(
    {
      gate: () => binding.open && modelSettings.configured,
      verify: () => binding.check(),
      bootstrap: () => ingest.bootstrap(),
      poll: (signal) => ingest.poll(signal),
      recoverEntries: (signal) => recovery.scan(signal),
      resumeWindows: () => digest.resumeWindows(),
      reconcileFeeds: () => digest.reconcile(),
      activate: () => digest.activate(),
      summaries: async () => {
        await summaries();
      },
      digest: async (id, occurrence) => {
        await digest.select(id, occurrence.getTime(), 'scheduled');
      },
      failed: (operation) =>
        logger.log('error', 'operation_failed', {
          operation: operation,
        }),
    },
    {
      pollIntervalMs: durationMs(config.ingestion.polling.interval),
      summaryCron: config.features.summary.enabled
        ? config.features.summary.schedule.cron
        : null,
      digestCrons: config.features.digest.enabled
        ? config.features.digest.jobs.map((j) => ({ id: j.id, cron: j.cron }))
        : [],
    },
  );
  return {
    config,
    configuration,
    ai,
    modelSettings,
    scopeSettings: new ScopeSettings(configuration, config),
    db,
    repository,
    client,
    binding,
    source,
    ingest,
    recovery,
    admission,
    digest,
    digestRepository,
    metrics,
    logger,
    queue,
    scheduler,
    reprocess,
    summaries,
    start() {
      if (started) return;
      started = true;
      scheduler.start();
      queue.start();
    },
    async ready() {
      try {
        return (
          db.ping() &&
          modelSettings.configured &&
          (await binding.check()).ready &&
          repository.cursor() !== undefined
        );
      } catch {
        return false;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      scheduler.stop();
      binding.stop();
      ingest.stop();
      recovery.stop();
      digest.stop();
      try {
        await queue.stop(durationMs(config.runtime.shutdown_grace_period));
        await Promise.all([
          scheduler.drained(),
          digest.drained(),
          recovery.drained(),
        ]);
      } catch (error) {
        logger.log('error', 'operation_failed', {
          operation: 'shutdown',
          error: safeWorkError(error).detail,
        });
      } finally {
        db.close();
      }
    },
  };
}
