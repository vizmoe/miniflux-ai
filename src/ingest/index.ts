import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { Repository } from '../db/repository.js';
import type {
  CompactEntry,
  Task,
  BackfillPayload,
  BackfillProgress,
} from '../db/types.js';
import type { MinifluxClient, MinifluxFeed } from '../miniflux/client.js';
import type { LanguageAnalyzer } from '../lang/review.js';
import type { LanguageFacts } from '../lang/index.js';
import type { AdmissionPolicy } from '../runtime/admission.js';
type PreparedEntry = ReturnType<Ingest['normalize']>;
interface IngestionStatus {
  rejected_entry_count: number;
  last_rejected_entry_at: number | null;
  poller_state: string;
  poller_reason: string | null;
  last_poll_failure_at: number | null;
}
import {
  LANGUAGE_REVIEW_BATCH_TIMEOUT_MS,
  WEBHOOK_FEED_RESOLUTION_BUDGET,
} from '../config/constants.js';
import { aiSnapshot } from '../config/snapshots.js';
import { nonempty, parseInstant, safeId } from '../config/primitives.js';
import { extractSemanticBlocks } from '../html/blocks.js';
import { parseSource } from '../html/dom.js';
import { markerShapedIdCount } from '../html/ownership.js';
import { sourceFingerprint } from '../source/index.js';
import {
  backfillPayloadSchema,
  backfillProgressSchema,
} from '../db/documents.js';
import { ApiError, WorkError } from '../obs/errors.js';
class MetadataError extends Error {
  reason;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const entryFields = z.object({
  title: z.string(),
  content: z.string(),
  url: z.string(),
  author: z.string().default(''),
  published_at: z.string(),
});
const feedFields = z.object({
  id: safeId,
  title: nonempty,
  feed_url: nonempty,
  site_url: z.string().default(''),
});
const categoryFields = z.object({ id: safeId, title: nonempty });
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export class Ingest {
  repository;
  client;
  detector;
  admission;
  config;
  gate;
  observe;
  status: IngestionStatus = {
    rejected_entry_count: 0,
    last_rejected_entry_at: null,
    poller_state: 'initializing',
    poller_reason: null,
    last_poll_failure_at: null,
  };
  bootstrapFlight?: Promise<void>;
  pollFlight?: Promise<void>;
  controller = new AbortController();
  stop() {
    this.controller.abort();
  }
  constructor(
    repository: Repository,
    client: MinifluxClient,
    detector: LanguageAnalyzer,
    admission: AdmissionPolicy,
    config: Config,
    gate: () => boolean,
    observe: (source: string, reason: string, id: number) => void = () => {},
  ) {
    this.repository = repository;
    this.client = client;
    this.detector = detector;
    this.admission = admission;
    this.config = config;
    this.gate = gate;
    this.observe = observe;
  }
  reject(source: string, reason: string, id: number) {
    this.status.rejected_entry_count++;
    this.status.last_rejected_entry_at = this.repository.now();
    this.observe(source, reason, id);
  }
  safeIds(page: unknown[]): number[] {
    const values = page.map((v) => record(v).id);
    if (values.some((v) => !safeId.safeParse(v).success))
      throw new WorkError(
        'miniflux_entry_id_out_of_range',
        'invalid_response',
        true,
      );
    return values as number[];
  }
  normalize(raw: unknown, resolvedFeed?: MinifluxFeed) {
    const object = record(raw),
      id = safeId.parse(object.id);
    const entry = entryFields.safeParse(raw);
    if (!entry.success) throw new MetadataError('entry_metadata_invalid');
    let published;
    try {
      published = parseInstant(entry.data.published_at);
    } catch {
      throw new MetadataError('entry_metadata_invalid');
    }
    const rawFeed = resolvedFeed ?? object.feed;
    const feed = feedFields.safeParse(rawFeed);
    if (!feed.success || object.feed_id !== feed.data.id)
      throw new MetadataError('feed_metadata_invalid');
    const category = categoryFields.safeParse(record(rawFeed).category);
    if (!category.success) throw new MetadataError('category_metadata_invalid');
    const root = parseSource(entry.data.content),
      plan = extractSemanticBlocks(root),
      blocks = plan.blocks;
    const language = this.detector.prepare(entry.data.title, blocks);
    return {
      fingerprint: sourceFingerprint(entry.data),
      entry: {
        entry_id: id,
        feed_id: feed.data.id,
        category_id: category.data.id,
        entry_url: entry.data.url,
        published_at: published,
        source_author: entry.data.author,
        source_feed_title: feed.data.title,
        source_feed_url: feed.data.feed_url,
        source_feed_site_url: feed.data.site_url,
        source_category_title: category.data.title,
        source_title: entry.data.title,
        source_content_units: plan.sourceContentUnits,
        primary_language: language.facts.primaryLanguage,
        language_confidence: language.facts.languageConfidence,
      },
      blockCount: blocks.length,
      language,
    };
  }
  async resolveLanguages(
    prepared: PreparedEntry[],
    signal: AbortSignal,
    snapshot = aiSnapshot(),
  ) {
    signal.throwIfAborted();
    if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
    const budget = AbortSignal.timeout(LANGUAGE_REVIEW_BATCH_TIMEOUT_MS);
    const unique = new Map<number, Promise<LanguageFacts>>();
    // Validate metadata for the entire batch before any model request. Share one
    // wall-clock budget including time waiting for the common AI semaphore.
    await Promise.all(
      prepared.map(async (item) => {
        if (this.repository.entry(item.entry.entry_id)) return;
        const id = item.entry.entry_id;
        let flight = unique.get(id);
        if (!flight) {
          flight = this.detector.resolve(
            item.language,
            snapshot,
            id,
            signal,
            budget,
          );
          unique.set(id, flight);
        }
        const facts = await flight;
        item.entry.primary_language = facts.primaryLanguage;
        item.entry.language_confidence = facts.languageConfidence;
      }),
    );
    signal.throwIfAborted();
    if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
  }
  bootstrap() {
    if (this.repository.cursor() !== undefined) return Promise.resolve();
    if (this.bootstrapFlight) return this.bootstrapFlight;
    this.bootstrapFlight = (async () => {
      if (!this.gate()) throw new ApiError(503, 'miniflux_unavailable');
      const entries = await this.client.entries(
        {
          order: 'id',
          direction: 'desc',
          limit: 1,
        },
        this.controller.signal,
      );
      const ids = this.safeIds(entries);
      if (ids.length > 1)
        throw new WorkError(
          'miniflux_invalid_response',
          'invalid_response',
          true,
        );
      this.repository.db.transaction(() => {
        if (this.repository.cursor() === undefined)
          this.repository.setCursor(ids[0] ?? 0);
      });
    })().finally(() => {
      this.bootstrapFlight = undefined;
    });
    return this.bootstrapFlight;
  }
  async webhook(body: unknown, signal?: AbortSignal) {
    signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (!this.gate() || this.repository.cursor() === undefined)
      throw new ApiError(503, 'ingestion_not_ready');
    const payload = record(body);
    if (!Array.isArray(payload.entries))
      throw new ApiError(503, 'webhook_batch_invalid');
    const entries = payload.entries;
    this.safeIds(entries);
    const outputs = this.repository.outputFeedIds();
    const candidates = entries.filter(
      (e) =>
        !outputs.has(Number(record(e).feed_id)) &&
        !this.repository.entry(Number(record(e).id)),
    );
    const ids = [...new Set(candidates.map((e) => record(e).feed_id))];
    if (ids.some((id) => !safeId.safeParse(id).success))
      throw new ApiError(503, 'feed_metadata_invalid');
    if (ids.length > WEBHOOK_FEED_RESOLUTION_BUDGET)
      throw new ApiError(503, 'webhook_feed_budget_exceeded');
    const feeds = new Map<number, MinifluxFeed>();
    for (const id of ids)
      feeds.set(id as number, await this.client.feed(id as number, signal));
    const normalized = candidates.map((raw) =>
      this.normalize(raw, feeds.get(Number(record(raw).feed_id))),
    );
    await this.resolveLanguages(normalized, signal);
    const prepared = normalized.map((item) => ({
      ...item,
      plan: this.admission.plan(item.entry, item.blockCount),
    }));
    signal?.throwIfAborted();
    this.repository.db.transaction(() => {
      for (const item of prepared)
        if (this.repository.insertEntry(item.entry, item.fingerprint))
          this.admission.apply(this.repository, item.entry.entry_id, item.plan);
    });
  }
  poll(signal?: AbortSignal) {
    if (this.pollFlight) return this.pollFlight;
    this.pollFlight = this.pollCycle(signal).finally(() => {
      this.pollFlight = undefined;
    });
    return this.pollFlight;
  }
  async pollCycle(signal?: AbortSignal) {
    signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    try {
      if (!this.gate()) return;
      await this.bootstrap();
      while (this.gate()) {
        const cursor = this.repository.cursor()!;
        const page = await this.client.entries(
          {
            order: 'id',
            direction: 'asc',
            after_entry_id: cursor,
            limit: this.config.ingestion.polling.page_size,
          },
          signal,
        );
        const ids = this.safeIds(page);
        if (ids.some((id) => id <= cursor))
          throw new WorkError(
            'miniflux_invalid_response',
            'invalid_response',
            true,
          );
        if (!page.length) break;
        await this.pollPage(page, ids, signal);
        if (page.length < this.config.ingestion.polling.page_size) break;
      }
      this.status.poller_state = 'healthy';
      this.status.poller_reason = null;
    } catch (error) {
      this.status.poller_state = 'degraded';
      this.status.poller_reason =
        error instanceof WorkError
          ? error.detail.code
          : 'repository_unavailable';
      this.status.last_poll_failure_at = this.repository.now();
      throw error;
    }
  }
  async pollPage(page: unknown[], ids: number[], signal: AbortSignal) {
    const outputs = this.repository.outputFeedIds();
    const normalized = [],
      rejected = [];
    for (const raw of page) {
      const id = Number(record(raw).id);
      if (outputs.has(Number(record(raw).feed_id)) || this.repository.entry(id))
        continue;
      try {
        normalized.push(this.normalize(raw));
      } catch (error) {
        if (!(error instanceof MetadataError)) throw error;
        rejected.push({ id, reason: error.reason });
      }
    }
    await this.resolveLanguages(normalized, signal);
    const prepared = normalized.map((item) => ({
      ...item,
      plan: this.admission.plan(item.entry, item.blockCount),
    }));
    signal?.throwIfAborted();
    this.repository.db.transaction(() => {
      for (const item of prepared)
        if (this.repository.insertEntry(item.entry, item.fingerprint))
          this.admission.apply(this.repository, item.entry.entry_id, item.plan);
      this.repository.setCursor(Math.max(...ids));
    });
    for (const r of rejected) this.reject('poll', r.reason, r.id);
  }
  backfillSelected(entry: CompactEntry, snapshot: BackfillPayload) {
    if (snapshot.feed_ids.length && !snapshot.feed_ids.includes(entry.feed_id))
      return false;
    if (
      snapshot.category_ids.length &&
      !snapshot.category_ids.includes(entry.category_id)
    )
      return false;
    if (snapshot.since_ms !== null && entry.published_at < snapshot.since_ms)
      return false;
    return snapshot.until_ms === null || entry.published_at < snapshot.until_ms;
  }
  backfillCandidates(
    page: unknown[],
    snapshot: BackfillPayload,
    next: BackfillProgress,
  ) {
    const outputs = this.repository.outputFeedIds();
    const candidates = [];
    const rejected = [];
    for (const raw of page) {
      const object = record(raw);
      const id = Number(object.id);
      next.after_entry_id = id;
      if (outputs.has(Number(object.feed_id))) continue;
      let prepared;
      try {
        prepared = this.normalize(raw);
      } catch (error) {
        if (!(error instanceof MetadataError)) throw error;
        next.rejected_entries++;
        rejected.push({ id, reason: error.reason });
        continue;
      }
      const stored = this.repository.entry(id),
        entry = stored ?? prepared.entry;
      if (!this.backfillSelected(entry, snapshot)) continue;
      next.examined_entries++;
      if (markerShapedIdCount(String(object.content)) > 0)
        next.marker_shaped_id_count++;
      candidates.push(prepared);
      if (next.examined_entries >= snapshot.limit) break;
    }
    return { candidates, rejected };
  }
  backfillOperations(
    candidates: PreparedEntry[],
    snapshot: BackfillPayload,
    next: BackfillProgress,
  ) {
    const operations = [];
    for (const prepared of candidates) {
      const id = prepared.entry.entry_id;
      // Another intake may have inserted this Entry while the review awaited
      // the provider. First-ingest facts remain authoritative for admission.
      const stored = this.repository.entry(id),
        entry = stored ?? prepared.entry;
      const selected = snapshot.requested_features.filter(
        (kind) =>
          !this.repository.featureStates(id).some((s) => s.kind === kind),
      );
      const plan = this.admission.plan(entry, prepared.blockCount, selected, {
        continuation: snapshot,
      });
      // Active Entry generation remains the admission mutex; an exact repeat can fill it later.
      if (
        !this.repository.activeGeneration(id) &&
        (!stored || plan.decisions.length)
      ) {
        next.admitted_entries++;
        operations.push({
          entry: prepared.entry,
          fingerprint: prepared.fingerprint,
          plan,
        });
      }
    }
    return operations;
  }
  async backfill(task: Task<'ingest_backfill'>, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.controller.signal]);
    const snapshot = backfillPayloadSchema.parse(task.payload);
    let progress = backfillProgressSchema.parse(task.progress);
    while (progress.examined_entries < snapshot.limit) {
      this.repository.assertOwner(task);
      signal.throwIfAborted();
      const page = await this.client.entries(
        {
          order: 'id',
          direction: 'asc',
          after_entry_id: progress.after_entry_id,
          limit: snapshot.page_size,
        },
        signal,
      );
      const ids = this.safeIds(page);
      if (
        ids.some(
          (id, i) => id <= (i === 0 ? progress.after_entry_id : ids[i - 1]),
        )
      )
        throw new WorkError(
          'miniflux_invalid_response',
          'invalid_response',
          true,
        );
      if (!page.length) break;
      const next = { ...progress };
      const { candidates, rejected } = this.backfillCandidates(
        page,
        snapshot,
        next,
      );
      await this.resolveLanguages(candidates, signal, snapshot.ai);
      this.repository.assertOwner(task);
      const operations = this.backfillOperations(candidates, snapshot, next);
      this.repository.updateBackfill(task, next, () => {
        if (snapshot.dry_run) return;
        for (const operation of operations) {
          this.repository.insertEntry(operation.entry, operation.fingerprint);
          this.admission.apply(
            this.repository,
            operation.entry.entry_id,
            operation.plan,
            true,
          );
        }
      });
      for (const r of rejected) this.reject('backfill', r.reason, r.id);
      progress = next;
      if (page.length < snapshot.page_size) break;
    }
    signal.throwIfAborted();
    this.repository.settle(task, 'done');
  }
}
