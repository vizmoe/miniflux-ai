import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import Fastify from 'fastify';
import type { Service } from '../runtime/service.js';
interface DigestParams {
  job_id: string;
  category_id?: string;
  date: string;
}
interface IdParams {
  id: string;
}
import { AdminSessions } from '../admin/session.js';
import { registerConsole } from '../admin/assets.js';
import { dashboard, listEntries } from '../admin/queries.js';
import { z } from 'zod';
import { DIGEST_JOB_ID_PATTERN } from '../config/constants.js';
import { backfillSpecs } from '../config/snapshots.js';
import {
  nonnegative,
  parseInstant,
  positive,
  safeId,
  validDate,
} from '../config/primitives.js';
import { evaluateScope } from '../config/scope.js';
import {
  backfillPayloadSchema,
  emptyBackfillProgress,
  featureKind,
} from '../db/documents.js';
import { provisioningAtom } from '../features/digest/render.js';
import { ApiError, WorkError } from '../obs/errors.js';
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function validSignature(
  body: Buffer,
  supplied: unknown,
  secret: string,
) {
  if (typeof supplied !== 'string' || !/^[a-fA-F0-9]{64}$/.test(supplied))
    return false;
  return timingSafeEqual(
    createHmac('sha256', secret).update(body).digest(),
    Buffer.from(supplied, 'hex'),
  );
}
const featureSelection = z
  .array(featureKind)
  .nonempty()
  .refine((v) => new Set(v).size === v.length)
  .transform((v) =>
    (['translation', 'summary'] as const).filter((k) => v.includes(k)),
  );
const idArray = z
  .array(safeId)
  .nonempty()
  .transform((ids) => [...new Set(ids)].sort((a, b) => a - b));
const backfillRequest = z
  .object({
    since: z.string().optional(),
    until: z.string().optional(),
    feed_ids: idArray.optional(),
    category_ids: idArray.optional(),
    limit: positive,
    features: featureSelection,
    dry_run: z.boolean(),
  })
  .strict();
const timestampKeys = new Set([
  'created_at',
  'updated_at',
  'published_at',
  'rendered_at',
  'window_start',
  'window_end',
  'last_evaluated_at',
  'last_attempt_at',
  'last_scan_at',
  'recovery_checked_at',
  'next_attempt_at',
  'waiting_since',
  'oldest_awaiting_output_feed_since',
  'last_poll_failure_at',
  'last_rejected_entry_at',
  'run_after',
  'lease_expires_at',
]);
function httpDates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(httpDates);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        timestampKeys.has(k) && typeof v === 'number'
          ? new Date(v).toISOString()
          : httpDates(v),
      ]),
    );
  return value;
}
function json(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) throw new ApiError(400, 'invalid_json');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}
function pathId(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/.test(value) ||
    !safeId.safeParse(Number(value)).success
  )
    throw new ApiError(400, 'invalid_id');
  return Number(value);
}
export function buildServer(service: Service) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024,
    genReqId: () => randomUUID(),
    exposeHeadRoutes: false,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.status)
        .send({ code: error.code, ...error.fields });
    if (error instanceof WorkError) {
      let status = 503;
      if (error.detail.failure_class === 'not_found') status = 404;
      else if (error.detail.code === 'source_projection_invalid') status = 409;
      return reply.code(status).send({ code: error.detail.code });
    }
    if (error instanceof z.ZodError)
      return reply.code(400).send({ code: 'invalid_request' });
    service.logger.log('error', 'operation_failed');
    return reply.code(503).send({ code: 'service_unavailable' });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: 'not_found' }),
  );
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    const ready = await service.ready();
    return reply.code(ready ? 200 : 503).send({ ready });
  });
  app.get('/metrics', async (_request, reply) => {
    service.metrics.refresh(service.repository, service.digest.status());
    return reply
      .type(service.metrics.registry.contentType)
      .send(await service.metrics.registry.metrics());
  });
  if (service.config.ingestion.webhook.enabled)
    app.post('/webhook/miniflux', async (request, reply) => {
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0);
      if (
        !validSignature(
          body,
          request.headers['x-miniflux-signature'],
          service.config.ingestion.webhook.secret!,
        )
      )
        return reply.code(401).send({ code: 'invalid_signature' });
      if (request.headers['x-miniflux-event-type'] !== 'new_entries')
        return reply.code(204).send();
      try {
        if (!service.binding.open || service.repository.cursor() === undefined)
          return reply.code(503).send({ code: 'ingestion_not_ready' });
        await service.ingest.webhook(json(body));
        service.logger.log('info', 'webhook_admitted', {
          request_id: request.id,
        });
        return reply.code(204).send();
      } catch {
        service.logger.log('warn', 'webhook_rejected', {
          request_id: request.id,
        });
        return reply.code(503).send({ code: 'webhook_admission_failed' });
      }
    });
  const partition = (params: DigestParams) => {
    if (!DIGEST_JOB_ID_PATTERN.test(params.job_id))
      throw new ApiError(404, 'not_found');
    let key = 'all';
    if (params.category_id) {
      try {
        key = `category:${pathId(params.category_id)}`;
      } catch {
        throw new ApiError(404, 'not_found');
      }
    }
    return { job: params.job_id, key };
  };
  for (const path of [
    '/digest/feeds/:job_id.xml',
    '/digest/feeds/:job_id/categories/:category_id.xml',
  ])
    app.get<{ Params: DigestParams }>(path, async (request, reply) => {
      const p = partition(request.params),
        feed = service.digestRepository.feed(p.job, p.key);
      if (!feed) return reply.code(404).send({ code: 'not_found' });
      return reply
        .type('application/atom+xml; charset=utf-8')
        .send(provisioningAtom(feed));
    });
  for (const path of [
    '/digest/:job_id/:date',
    '/digest/:job_id/categories/:category_id/:date',
  ])
    app.get<{ Params: DigestParams }>(path, async (request, reply) => {
      const p = partition(request.params);
      if (!validDate(request.params.date))
        return reply.code(404).send({ code: 'not_found' });
      const target = service.digestRepository.resolveDigestPermalink(
        p.job,
        p.key,
        request.params.date,
      );
      if (!target) return reply.code(404).send({ code: 'not_found' });
      return reply
        .code(302)
        .header('Cache-Control', 'no-store')
        .header(
          'Location',
          `${service.config.miniflux.web_url ?? service.config.miniflux.base_url}/feed/${target.outputFeedId}/entry/${target.minifluxEntryId}`,
        )
        .send();
    });
  if (service.config.server.admin_token) {
    registerConsole(app);
    const sessions = new AdminSessions(service);
    sessions.register(app);
    void app.register(
      async (admin) => {
        admin.addHook('onRequest', async (request, reply) => {
          reply.header('Cache-Control', 'no-store');
          sessions.authorize(request);
        });
        admin.get('/stats', async () => dashboard(service.db));
        admin.get('/entries', async (request) =>
          httpDates(listEntries(service.db, request.query)),
        );
        admin.get('/model', async () => service.modelSettings.view());
        admin.put('/model', { bodyLimit: 262144 }, async (request) =>
          service.modelSettings.update(json(request.body)),
        );
        admin.get('/config', async () => service.modelSettings.configView());
        admin.get('/scopes', async () => service.scopeSettings.view());
        admin.put('/scopes', { bodyLimit: 262144 }, async (request) =>
          service.scopeSettings.update(json(request.body)),
        );
        admin.get('/subscriptions', async () => {
          const core = await service.binding.check();
          if (!core.ready)
            throw new ApiError(503, core.reason ?? 'miniflux_unavailable');
          service.binding.requireOpen();
          const [feeds, categories] = await Promise.all([
            service.client.feeds(),
            service.client.categories(),
          ]);
          service.binding.requireOpen();
          const byTitle = (
            a: { title: string; id: number },
            b: { title: string; id: number },
          ) => a.title.localeCompare(b.title, 'en') || a.id - b.id;
          return {
            feeds: feeds
              .map((feed) => ({
                id: feed.id,
                title: feed.title,
                category_id: feed.category.id,
              }))
              .sort(byTitle),
            categories: categories.toSorted(byTitle),
          };
        });
        admin.get('/status', async () => {
          const core = await service.binding.check();
          return httpDates({
            core: {
              database: service.db.ping(),
              ...core,
              poll_cursor_committed: service.repository.cursor() !== undefined,
            },
            miniflux_account_binding: {
              state: service.binding.state,
              stored: service.repository.binding() ?? null,
              configured_base_url: service.config.miniflux.base_url,
            },
            ingestion: service.ingest.status,
            recovery: service.recovery.status,
            digest: service.digest.status(),
          });
        });
        admin.post('/recovery/run', async (request) => {
          service.binding.requireOpen();
          service.modelSettings.requireConfigured();
          const { entry_id } = z
            .object({ entry_id: safeId.optional() })
            .strict()
            .parse(request.body === undefined ? {} : json(request.body));
          if (entry_id === undefined) await service.recovery.scan();
          else {
            if (!service.repository.entry(entry_id))
              throw new ApiError(404, 'entry_not_found');
            await service.recovery.check(entry_id);
          }
          return httpDates(service.recovery.status);
        });
        admin.post('/miniflux/confirm-base-url', async (request) =>
          service.binding.confirm(
            z
              .object({ base_url: z.string() })
              .strict()
              .parse(json(request.body)).base_url,
          ),
        );
        admin.get<{ Params: IdParams }>('/entries/:id', async (request) => {
          const id = pathId(request.params.id),
            entry = service.repository.entry(id);
          if (!entry) throw new ApiError(404, 'entry_not_found');
          const source = await service.source.load(id);
          let renderStatus = 'current';
          if (entry.render_generation === 0) renderStatus = 'never_requested';
          else if (entry.render_generation > entry.rendered_generation)
            renderStatus = 'pending';
          return httpDates({
            ...entry,
            feature_states: service.repository.featureStates(id),
            render_status: renderStatus,
            source,
            artifacts: service.repository.artifacts(id),
            tasks: service.repository
              .listTasks({ entry_id: id })
              .map((t) => service.repository.safeTask(t)),
          });
        });
        admin.post<{ Params: IdParams }>(
          '/entries/:id/reprocess',
          async (request, reply) => {
            const query = z
              .object({ features: z.string().optional() })
              .strict()
              .parse(request.query);
            const features = featureSelection.parse(
              (query.features ?? 'translation,summary').split(','),
            );
            const outcomes = await service.reprocess(
              pathId(request.params.id),
              features,
            );
            return reply.code(202).send({ outcomes });
          },
        );
        admin.get('/tasks', async (request) => {
          const filter = z
            .object({
              state: z.enum(['pending', 'leased', 'done', 'dead']).optional(),
              type: z
                .enum([
                  'generate_artifacts',
                  'render',
                  'digest',
                  'ingest_backfill',
                ])
                .optional(),
              entry_id: z.coerce.number().pipe(safeId).optional(),
              limit: z.coerce.number().int().min(1).max(1000).optional(),
              before_id: z.coerce.number().pipe(safeId).optional(),
            })
            .strict()
            .parse(request.query);
          return httpDates({
            tasks: service.repository
              .listTasks(filter)
              .map((t) => service.repository.safeTask(t)),
          });
        });
        admin.post<{ Params: IdParams }>(
          '/tasks/:id/requeue',
          async (request) =>
            httpDates(
              service.repository.safeTask(
                service.repository.requeue(pathId(request.params.id)),
              ),
            ),
        );
        admin.post('/backfill', async (request, reply) => {
          const input = backfillRequest.parse(json(request.body));
          service.binding.requireOpen();
          if (!input.dry_run) service.admission.requireEnabled(input.features);
          let since, until;
          try {
            since =
              input.since === undefined ? null : parseInstant(input.since);
            until =
              input.until === undefined ? null : parseInstant(input.until);
          } catch {
            throw new ApiError(400, 'invalid_time_bounds');
          }
          if (since !== null && until !== null && since >= until)
            throw new ApiError(400, 'invalid_time_bounds');
          const payload = backfillPayloadSchema.parse({
            schema_version: 1,
            since_ms: since,
            until_ms: until,
            feed_ids: input.feed_ids ?? [],
            category_ids: input.category_ids ?? [],
            limit: input.limit,
            dry_run: input.dry_run,
            page_size: service.config.ingestion.polling.page_size,
            ...backfillSpecs(service.config, input.features),
          });
          const task = service.repository.createTask(
            'ingest_backfill',
            `backfill:${randomUUID()}`,
            null,
            payload,
            emptyBackfillProgress(),
          );
          return reply.code(202).send({ id: task.id });
        });
        admin.get<{ Params: IdParams }>('/backfill/:id', async (request) => {
          const task = service.repository.task(pathId(request.params.id));
          if (task?.type !== 'ingest_backfill')
            throw new ApiError(404, 'task_not_found');
          const payload = backfillPayloadSchema.parse(task.payload);
          return httpDates({
            id: task.id,
            state: task.state,
            attempts: task.attempts,
            dry_run: payload.dry_run,
            requested_features: payload.requested_features,
            progress: task.progress,
            last_error: task.last_error,
          });
        });
        admin.post('/summaries/run', async (_request, reply) =>
          reply.code(202).send({ enqueued: await service.summaries() }),
        );
        admin.post('/digests/run', async (request) => {
          const received = service.repository.now();
          const input = z
            .object({
              job_id: z.string().regex(DIGEST_JOB_ID_PATTERN),
              window_end: z.string().optional(),
              partition_key: z.string().optional(),
            })
            .strict()
            .parse(json(request.body));
          let end = received;
          if (input.window_end !== undefined) {
            try {
              end = parseInstant(input.window_end);
            } catch {
              throw new ApiError(400, 'invalid_window_end');
            }
          }
          if (end > received) throw new ApiError(400, 'window_end_in_future');
          const result = await service.digest.select(
            input.job_id,
            end,
            'manual',
            input.partition_key,
          );
          return httpDates({
            job_id: result.window.job_id,
            digest_date: result.window.digest_date,
            window_start: result.window.window_start,
            window_end: result.window.window_end,
            partitions: result.partitions.map((p) => ({
              partition_key: p.partition_key,
              status: p.status,
              ...(p.run
                ? {
                    run_id: p.run.id,
                    run_state: p.run.state,
                    ...service.digestRepository.waiting(
                      p.run,
                      service.digest.importReady,
                    ),
                  }
                : {}),
            })),
          });
        });
        admin.get('/digests', async () =>
          httpDates({
            windows: service.digestRepository.windows().map((w) => {
              const { config_snapshot: _snapshot, ...safe } = w;
              return {
                ...safe,
                runs: service.digestRepository.runs(w.id).map((r) => ({
                  ...r,
                  ...service.digestRepository.waiting(
                    r,
                    service.digest.importReady,
                  ),
                })),
              };
            }),
          }),
        );
        admin.post('/rules/dry-run', async (request) => {
          const sample = z
            .object({
              feed_id: safeId,
              category_id: safeId,
              source_feed_url: z.string(),
              source_feed_site_url: z.string(),
              entry_url: z.string(),
              source_title: z.string(),
              source_author: z.string(),
              primary_language: z.string().nullable(),
              source_content_units: nonnegative,
            })
            .strict();
          const input = z
            .object({
              feature: z.enum(['translation', 'summary', 'digest']),
              job_id: z.string().regex(DIGEST_JOB_ID_PATTERN).optional(),
              entry_id: safeId.optional(),
              sample: sample.optional(),
            })
            .strict()
            .refine(
              (v) =>
                (v.entry_id !== undefined) !== (v.sample !== undefined) &&
                (v.feature === 'digest') === (v.job_id !== undefined),
            )
            .parse(json(request.body));
          const entry =
            input.sample ?? service.repository.entry(input.entry_id!);
          if (!entry) throw new ApiError(404, 'entry_not_found');
          const scope =
            input.feature === 'digest'
              ? service.config.features.digest.jobs.find(
                  (j) => j.id === input.job_id,
                )?.scope
              : service.config.features[input.feature].scope;
          if (!scope) throw new ApiError(404, 'digest_job_not_found');
          return evaluateScope(scope, entry);
        });
      },
      { prefix: '/admin' },
    );
  }
  return app;
}
