import { z } from 'zod';
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
import type { Config } from '../config/index.js';
import type { MinifluxClient } from '../miniflux/client.js';
import type { LanguageAnalyzer, LanguageEvidence } from '../lang/review.js';
import type { ArticleLanguageFacts } from '../lang/index.js';
import type {
  AiExecution,
  BackfillPayload,
  BackfillProgress,
} from '../db/documents.js';
import type { AdmissionPlan, AdmissionPolicy } from '../runtime/admission.js';
import type { CompactEntry, Repository, Task } from '../db/repository.js';
import {
  backfillPayloadSchema,
  backfillProgressSchema,
} from '../db/documents.js';
import { ApiError, WorkError } from '../obs/errors.js';

export type RejectionReason =
  | 'entry_metadata_invalid'
  | 'feed_metadata_invalid'
  | 'category_metadata_invalid';
class MetadataError extends Error {
  constructor(readonly reason: RejectionReason) {
    super(reason);
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
interface Prepared {
  entry: CompactEntry;
  fingerprint: string;
  blockCount: number;
  language: LanguageEvidence;
}
export class Ingest {
  readonly status = {
    rejected_entry_count: 0,
    last_rejected_entry_at: null as number | null,
    poller_state: 'initializing',
    poller_reason: null as string | null,
    last_poll_failure_at: null as number | null,
  };
  private bootstrapFlight?: Promise<void>;
  private pollFlight?: Promise<void>;
  private readonly controller = new AbortController();
  stop(): void {
    this.controller.abort();
  }
  constructor(
    private readonly repository: Repository,
    private readonly client: MinifluxClient,
    private readonly detector: LanguageAnalyzer,
    private readonly admission: AdmissionPolicy,
    private readonly config: Config,
    private readonly gate: () => boolean,
    private readonly observe: (
      source: 'poll' | 'backfill',
      reason: RejectionReason,
      entryId: number,
    ) => void = () => {},
  ) {}
  private reject(
    source: 'poll' | 'backfill',
    reason: RejectionReason,
    id: number,
  ): void {
    this.status.rejected_entry_count++;
    this.status.last_rejected_entry_at = this.repository.now();
    this.observe(source, reason, id);
  }
  private safeIds(page: unknown[]): number[] {
    const values = page.map((v) => record(v).id);
    if (values.some((v) => !safeId.safeParse(v).success))
      throw new WorkError(
        'miniflux_entry_id_out_of_range',
        'invalid_response',
        true,
      );
    return values as number[];
  }
  private normalize(raw: unknown, resolvedFeed?: unknown): Prepared {
    const object = record(raw),
      id = safeId.parse(object.id);
    const entry = entryFields.safeParse(raw);
    if (!entry.success) throw new MetadataError('entry_metadata_invalid');
    let published: number;
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
  private async resolveLanguages(
    prepared: Prepared[],
    signal: AbortSignal,
    snapshot: AiExecution = aiSnapshot(),
  ): Promise<void> {
    signal.throwIfAborted();
    if (!this.gate()) throw new ApiError(503, 'ingestion_not_ready');
    const budget = AbortSignal.timeout(LANGUAGE_REVIEW_BATCH_TIMEOUT_MS);
    const unique = new Map<number, Promise<ArticleLanguageFacts>>();
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
  bootstrap(): Promise<void> {
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
  async webhook(body: unknown, signal?: AbortSignal): Promise<void> {
    signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (!this.gate() || this.repository.cursor() === undefined)
      throw new ApiError(503, 'ingestion_not_ready');
    const payload = record(body);
    if (!Array.isArray(payload.entries))
      throw new ApiError(503, 'webhook_batch_invalid');
    const entries: unknown[] = payload.entries;
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
    const feeds = new Map<number, unknown>();
    for (const id of ids as number[])
      feeds.set(id, await this.client.feed(id, signal));
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
  poll(signal?: AbortSignal): Promise<void> {
    if (this.pollFlight) return this.pollFlight;
    this.pollFlight = this.pollCycle(signal).finally(() => {
      this.pollFlight = undefined;
    });
    return this.pollFlight;
  }
  private async pollCycle(signal?: AbortSignal): Promise<void> {
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
  private async pollPage(
    page: unknown[],
    ids: number[],
    signal: AbortSignal,
  ): Promise<void> {
    const outputs = this.repository.outputFeedIds();
    const normalized: Prepared[] = [],
      rejected: Array<{ id: number; reason: RejectionReason }> = [];
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
  private backfillSelected(
    entry: CompactEntry,
    snapshot: BackfillPayload,
  ): boolean {
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
  private backfillCandidates(
    page: unknown[],
    snapshot: BackfillPayload,
    next: BackfillProgress,
  ) {
    const outputs = this.repository.outputFeedIds();
    const candidates: Prepared[] = [];
    const rejected: Array<{ id: number; reason: RejectionReason }> = [];
    for (const raw of page) {
      const object = record(raw);
      const id = Number(object.id);
      next.after_entry_id = id;
      if (outputs.has(Number(object.feed_id))) continue;
      let prepared: Prepared;
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
  private backfillOperations(
    candidates: Prepared[],
    snapshot: BackfillPayload,
    next: BackfillProgress,
  ) {
    const operations: Array<{
      entry: CompactEntry;
      fingerprint: string;
      plan: AdmissionPlan;
    }> = [];
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
  async backfill(task: Task, signal: AbortSignal): Promise<void> {
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
          (id, i) => id <= (i === 0 ? progress.after_entry_id : ids[i - 1]!),
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
