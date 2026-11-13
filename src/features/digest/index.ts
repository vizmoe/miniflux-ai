import type { Config } from '../../config/index.js';
import type { DigestRepository } from '../../db/digest.js';
import type { Repository } from '../../db/repository.js';
import type { DigestFeed, Task } from '../../db/types.js';
import type { MinifluxClient } from '../../miniflux/client.js';
import type { BindingController } from '../../miniflux/binding.js';
import type { MinifluxSourceReader } from '../../source/index.js';
import type { TaskContext } from '../../queue/index.js';
import type { DigestGenerator, DigestInput } from './generation.js';
import {
  canonicalJson,
  durationMs,
  normalizeBaseUrl,
} from '../../config/primitives.js';
import { digestSnapshot } from '../../config/snapshots.js';
import { feedPath } from '../../db/digest.js';
import { backoff } from '../../db/repository.js';
import { digestPayloadSchema } from '../../db/documents.js';
import { renderDigest } from './render.js';
import { extractSemanticBlocks } from '../../html/blocks.js';
import { parseSource } from '../../html/dom.js';
import { digestStats } from '../../ai/stats.js';
import { ApiError, WorkError } from '../../obs/errors.js';
function feedFailure(error: unknown) {
  if (error instanceof ApiError) return error.code;
  if (error instanceof WorkError)
    return error.detail.failure_class === 'not_found'
      ? 'feed_not_found'
      : 'feed_unreachable';
  return 'provisioning_failed';
}
export class DigestController {
  config;
  repository;
  shared;
  client;
  binding;
  source;
  generator;
  notifyActivation;
  timers = new Map<string, NodeJS.Timeout>();
  flights = new Map<string, Promise<void>>();
  attempts = new Map<string, number>();
  controller = new AbortController();
  constructor(
    config: Config,
    repository: DigestRepository,
    shared: Repository,
    client: MinifluxClient,
    binding: BindingController,
    source: MinifluxSourceReader,
    generator: DigestGenerator,
    notifyActivation: () => void,
  ) {
    this.config = config;
    this.repository = repository;
    this.shared = shared;
    this.client = client;
    this.binding = binding;
    this.source = source;
    this.generator = generator;
    this.notifyActivation = notifyActivation;
  }
  currentSnapshot(jobId: string) {
    const job =
      this.config.features.digest.enabled &&
      this.config.features.digest.jobs.find((j) => j.id === jobId);
    return job ? digestSnapshot(this.config, job) : undefined;
  }
  activeFeeds() {
    return this.repository
      .feeds()
      .filter(
        (f) =>
          this.currentSnapshot(f.job_id) ||
          this.repository.continuationSnapshot(f.job_id, f.partition_key),
      );
  }
  async reconcile() {
    if (!this.binding.open || this.controller.signal.aborted) return;
    const core = await this.binding.check();
    if (!core.ready) return;
    if (this.config.features.digest.enabled)
      for (const job of this.config.features.digest.jobs)
        if (job.output.partition_by === 'all')
          this.repository.ensureFeed(
            digestSnapshot(this.config, job),
            'all',
            null,
          );
    await Promise.all(
      this.activeFeeds().map((feed) => this.reconcileFeed(feed)),
    );
  }
  reconcileFeed(feed: DigestFeed) {
    const key = `${feed.job_id}/${feed.partition_key}`;
    if (this.flights.has(key)) return this.flights.get(key);
    const remaining = (feed.next_attempt_at ?? 0) - this.shared.now();
    if (remaining > 0) {
      this.scheduleFeed(feed, remaining);
      return Promise.resolve();
    }
    const promise = this.feedPass(feed).finally(() => this.flights.delete(key));
    this.flights.set(key, promise);
    return promise;
  }
  scheduleFeed(feed: DigestFeed, delay: number) {
    const key = `${feed.job_id}/${feed.partition_key}`;
    if (this.timers.has(key) || this.controller.signal.aborted) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.reconcile().catch(() => {});
      }, delay),
    );
  }
  async resolveFeed(feed: DigestFeed, expectedId: number | null) {
    let found;
    if (expectedId !== null) {
      found = await this.client.feed(expectedId, this.controller.signal);
      if (normalizeBaseUrl(found.feed_url) !== feed.feed_url)
        throw new ApiError(503, 'feed_url_mismatch');
    } else
      found = (await this.client.feeds(this.controller.signal)).find((f) => {
        try {
          return normalizeBaseUrl(f.feed_url) === feed.feed_url;
        } catch {
          return false;
        }
      });
    found ??= await this.client.createFeed(
      feed.feed_url,
      feed.destination_category_id,
      this.controller.signal,
    );
    if (normalizeBaseUrl(found.feed_url) !== feed.feed_url)
      throw new ApiError(503, 'feed_url_mismatch');
    return found;
  }
  async feedPass(feed: DigestFeed) {
    const key = `${feed.job_id}/${feed.partition_key}`;
    const current = this.currentSnapshot(feed.job_id),
      snapshot =
        this.repository.continuationSnapshot(feed.job_id, feed.partition_key) ??
        current;
    if (!snapshot || this.controller.signal.aborted || !this.binding.open)
      return;
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
    let failure = null;
    try {
      if (
        current &&
        `${current.output.public_base_url}${feedPath(feed.job_id, feed.partition_key)}` !==
          feed.feed_url
      )
        throw new ApiError(503, 'feed_url_mismatch');
      const found = await this.resolveFeed(
        feed,
        feed.feed_id ?? snapshot.output.existing_feed_id,
      );
      this.controller.signal.throwIfAborted();
      this.repository.markFeed(
        feed.job_id,
        feed.partition_key,
        'ready',
        null,
        null,
        { id: found.id, categoryId: found.category.id },
      );
      this.attempts.delete(key);
      this.notifyActivation();
    } catch (error) {
      if (this.controller.signal.aborted) return;
      failure = feedFailure(error);
    }
    if (failure) {
      const attempts = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, attempts);
      const wait = Math.ceil(backoff(snapshot.retry_policy, attempts));
      this.repository.markFeed(
        feed.job_id,
        feed.partition_key,
        'degraded',
        failure,
        this.shared.now() + wait,
      );
      this.scheduleFeed(feed, wait);
    }
  }
  async resumeWindows() {
    if (!this.binding.open) return;
    for (const window of this.repository.incompleteWindows())
      this.repository.select(window.id);
  }
  async activate() {
    if (this.controller.signal.aborted) return;
    const core = await this.binding.check();
    this.repository.activate(
      () => this.binding.open && core.ready && !this.controller.signal.aborted,
    );
  }
  async select(
    jobId: string,
    end: number,
    trigger: 'manual' | 'scheduled',
    partition?: string,
  ) {
    this.binding.requireOpen();
    if (!this.config.features.digest.enabled)
      throw new ApiError(409, 'feature_disabled');
    const job = this.config.features.digest.jobs.find((j) => j.id === jobId);
    if (!job) throw new ApiError(404, 'digest_job_not_found');
    const result = this.shared.db.transaction(() => {
      const claimed = this.repository.claimWindow(
        digestSnapshot(this.config, job),
        end,
        durationMs(job.lookback),
        trigger,
      );
      if (
        trigger === 'scheduled' &&
        !claimed.created &&
        claimed.window.last_evaluated_at !== null
      )
        return { window: claimed.window, partitions: [] };
      const partitions = this.repository.select(claimed.window.id, partition);
      return { window: this.repository.window(claimed.window.id)!, partitions };
    });
    this.notifyActivation();
    void this.reconcile().catch(() => {});
    return result;
  }
  async run(task: Task<'digest'>, context: TaskContext) {
    const payload = digestPayloadSchema.parse(task.payload),
      run = this.repository.run(payload.digest_run_id);
    if (run?.output_feed_id == null)
      throw new WorkError('digest_run_invalid', 'validation', false);
    const window = this.repository.window(run.digest_window_id)!,
      snapshot = payload.config_snapshot;
    if (canonicalJson(snapshot) !== canonicalJson(window.config_snapshot))
      throw new WorkError('digest_snapshot_mismatch', 'validation', false);
    const candidates = this.repository.candidates(run.id);
    const items = [];
    // Parallel transports share the process-wide ordered AI semaphore. A failure aborts sibling work before any import.
    const attempt = new AbortController();
    const signal = AbortSignal.any([context.signal, attempt.signal]);
    const promises = candidates.map(async (entry) => {
      const artifact = snapshot.summary_reuse_enabled
        ? this.shared.readySummary(entry.entry_id, snapshot.output_language)
        : undefined;
      let input: DigestInput;
      if (artifact)
        input = {
          kind: 'summary_artifact',
          text:
            artifact.format === 'paragraph'
              ? artifact.text
              : artifact.items.join('\n'),
        };
      else {
        const source = await this.source.load(entry.entry_id, signal);
        input = {
          kind: 'source',
          text: extractSemanticBlocks(parseSource(source.content))
            .blocks.map((b) => b.text)
            .join('\n'),
        };
      }
      const summary = await this.generator.item(
        entry,
        input,
        snapshot,
        task,
        signal,
        context.calls,
      );
      return {
        id: entry.entry_id,
        title: entry.source_title,
        feed_title: entry.source_feed_title,
        summary,
      };
    });
    try {
      items.push(...(await Promise.all(promises)));
    } catch (error) {
      attempt.abort();
      await Promise.allSettled(promises);
      throw error;
    }
    context.assertOwned();
    const overview = await this.generator.overview(
      items,
      run,
      window,
      task,
      context.signal,
      context.calls,
    );
    const rendered = renderDigest(run, window, candidates, items, overview);
    context.assertOwned();
    const id = await this.client.importEntry(
      run.output_feed_id,
      rendered,
      context.signal,
    );
    context.assertOwned();
    this.repository.completeImport(task, id, digestStats(context.calls));
  }
  status() {
    const feeds = this.activeFeeds();
    const active =
      (this.config.features.digest.enabled &&
        this.config.features.digest.jobs.length > 0) ||
      feeds.length > 0;
    let state = 'ready';
    if (!active) state = 'disabled';
    else if (!this.importReady || feeds.some((f) => f.state === 'degraded'))
      state = 'degraded';
    else if (feeds.some((f) => f.state !== 'ready')) state = 'initializing';
    return {
      state,
      reason:
        !active || this.importReady ? null : this.binding.lastStatus.reason,
      output_feeds: feeds.map((feed) => {
        const waiting = this.repository.db.all<{ created_at: number }>(
          "SELECT r.created_at FROM digest_runs r JOIN digest_windows w ON w.id=r.digest_window_id WHERE w.job_id=? AND r.partition_key=? AND r.state='pending' AND r.output_feed_id IS NULL",
          feed.job_id,
          feed.partition_key,
        );
        return {
          ...feed,
          awaiting_output_feed_run_count:
            feed.state === 'ready' ? 0 : waiting.length,
          oldest_awaiting_output_feed_since:
            feed.state === 'ready' || !waiting.length
              ? null
              : Math.min(...waiting.map((r) => r.created_at)),
        };
      }),
    };
  }
  get importReady() {
    return this.binding.lastStatus.ready && this.binding.open;
  }
  stop() {
    this.controller.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
  async drained() {
    await Promise.allSettled(this.flights.values());
  }
}
