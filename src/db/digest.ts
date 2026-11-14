import {
  canonicalJson,
  expandTemplate,
  safeId,
  validDate,
} from '../config/primitives.js';
import { evaluateScope } from '../config/scope.js';
import {
  digestPayloadSchema,
  digestSnapshotSchema,
  digestStatsSchema,
  zeroDigestStats,
} from './documents.js';
import type { DigestSnapshot, DigestStats } from './documents.js';
import type { Entry, FeedRecord, digestRuns, digestWindows } from './schema.js';
import type { Repository, Task } from './repository.js';
import { ApiError } from '../obs/errors.js';

export type DigestWindow = Omit<
  typeof digestWindows.$inferSelect,
  'config_snapshot'
> & { config_snapshot: DigestSnapshot };
export type DigestRun = Omit<typeof digestRuns.$inferSelect, 'ai_stats'> & {
  ai_stats: DigestStats;
};
export type PartitionKey = 'all' | `category:${number}`;
export function feedPath(jobId: string, key: string): string {
  return key === 'all'
    ? `/digest/feeds/${jobId}.xml`
    : `/digest/feeds/${jobId}/categories/${key.slice(9)}.xml`;
}
export function permalinkPath(
  jobId: string,
  key: string,
  date: string,
): string {
  return key === 'all'
    ? `/digest/${jobId}/${date}`
    : `/digest/${jobId}/categories/${key.slice(9)}/${date}`;
}
export function templateValues(
  snapshot: DigestSnapshot,
  key: string,
  title: string | null,
  date?: string,
): Record<string, string> {
  return {
    job_id: snapshot.job_id,
    ...(date ? { date } : {}),
    ...(key !== 'all'
      ? { category_key: key.slice(9), category_title: title! }
      : {}),
  };
}
function validateTarget(snapshot: DigestSnapshot, target?: string): void {
  if (
    target !== undefined &&
    (snapshot.output.partition_by === 'all'
      ? target !== 'all'
      : !/^category:[1-9]\d*$/.test(target) ||
        !safeId.safeParse(Number(target.slice(9))).success)
  )
    throw new ApiError(400, 'invalid_partition_key');
}
function exclusionReason(
  snapshot: DigestSnapshot,
  entry: Entry,
): string | null {
  let reason: string | null = null;
  if (evaluateScope(snapshot.scope, entry).action === 'deny')
    reason = 'scope_denied';
  else if (
    entry.source_content_units < snapshot.selection.min_item_source_units
  )
    reason = 'content_too_short';
  else if (!entry.source_title.trim()) reason = 'source_title_missing';
  else {
    try {
      if (!['http:', 'https:'].includes(new URL(entry.entry_url).protocol))
        reason = 'entry_url_invalid';
    } catch {
      reason = 'entry_url_invalid';
    }
  }
  return reason;
}
export class DigestRepository {
  constructor(
    readonly repository: Repository,
    private readonly excluded: (
      jobId: string,
      reason: string,
    ) => void = () => {},
  ) {}
  get db() {
    return this.repository.db;
  }
  window(id: number): DigestWindow | undefined {
    const row = this.db.get<typeof digestWindows.$inferSelect>(
      'SELECT * FROM digest_windows WHERE id=?',
      id,
    );
    if (!row) return undefined;
    const snapshot = digestSnapshotSchema.parse(
      JSON.parse(row.config_snapshot),
    );
    if (
      snapshot.job_id !== row.job_id ||
      new Date(row.window_end).toISOString().slice(0, 10) !== row.digest_date
    )
      throw new Error('invalid_digest_window');
    return { ...row, config_snapshot: snapshot };
  }
  windows(limit = 100): DigestWindow[] {
    return this.db
      .all<{ id: number }>(
        'SELECT id FROM digest_windows ORDER BY window_end DESC,id DESC LIMIT ?',
        limit,
      )
      .map((r) => this.window(r.id)!);
  }
  incompleteWindows(): DigestWindow[] {
    return this.db
      .all<{ id: number }>(
        'SELECT id FROM digest_windows WHERE last_evaluated_at IS NULL ORDER BY window_end,id',
      )
      .map((r) => this.window(r.id)!);
  }
  run(id: number): DigestRun | undefined {
    const row = this.db.get<typeof digestRuns.$inferSelect>(
      'SELECT * FROM digest_runs WHERE id=?',
      id,
    );
    return row
      ? { ...row, ai_stats: digestStatsSchema.parse(JSON.parse(row.ai_stats)) }
      : undefined;
  }
  runs(windowId: number): DigestRun[] {
    return this.db
      .all<{ id: number }>(
        'SELECT id FROM digest_runs WHERE digest_window_id=? ORDER BY partition_key',
        windowId,
      )
      .map((r) => this.run(r.id)!);
  }
  candidates(runId: number): Entry[] {
    return this.db.all<Entry>(
      'SELECT e.* FROM digest_run_candidates c JOIN entries e ON e.entry_id=c.entry_id WHERE c.digest_run_id=? ORDER BY c.selection_position',
      runId,
    );
  }
  feed(jobId: string, key: string): FeedRecord | undefined {
    return this.db.get<FeedRecord>(
      'SELECT * FROM digest_output_feeds WHERE job_id=? AND partition_key=?',
      jobId,
      key,
    );
  }
  feeds(): FeedRecord[] {
    return this.db.all<FeedRecord>(
      'SELECT * FROM digest_output_feeds ORDER BY job_id,partition_key',
    );
  }
  ensureFeed(
    snapshot: DigestSnapshot,
    key: string,
    categoryTitle: string | null,
  ): FeedRecord {
    const existing = this.feed(snapshot.job_id, key);
    if (existing) return existing;
    const categoryId =
      key === 'all' ? null : safeId.parse(Number(key.slice(9)));
    if (
      categoryId !== null &&
      (!categoryTitle?.trim() || key !== `category:${categoryId}`)
    )
      throw new Error('invalid_partition');
    const title = expandTemplate(
      snapshot.output.feed_title_template,
      templateValues(snapshot, key, categoryTitle),
    );
    if (!title.trim()) throw new Error('invalid_feed_title');
    this.db.run(
      'INSERT INTO digest_output_feeds(job_id,partition_key,source_category_id,source_category_title,destination_category_id,feed_title,feed_url,feed_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      snapshot.job_id,
      key,
      categoryId,
      categoryTitle,
      snapshot.output.destination_category_id ?? categoryId,
      title,
      `${snapshot.output.public_base_url}${feedPath(snapshot.job_id, key)}`,
      snapshot.output.existing_feed_id,
      'initializing',
      this.repository.now(),
      this.repository.now(),
    );
    return this.feed(snapshot.job_id, key)!;
  }
  claimWindow(
    snapshot: DigestSnapshot,
    end: number,
    lookbackMs: number,
    trigger: 'scheduled' | 'manual',
  ): { window: DigestWindow; created: boolean } {
    return this.db.transaction(() => {
      digestSnapshotSchema.parse(snapshot);
      const exact = this.db.get<{ id: number }>(
        'SELECT id FROM digest_windows WHERE job_id=? AND window_end=?',
        snapshot.job_id,
        end,
      );
      if (exact) return { window: this.window(exact.id)!, created: false };
      const date = new Date(end).toISOString().slice(0, 10);
      if (
        this.db.get(
          'SELECT id FROM digest_windows WHERE job_id=? AND digest_date=?',
          snapshot.job_id,
          date,
        )
      )
        throw new ApiError(409, 'digest_window_conflict');
      const id = this.db.run(
        'INSERT INTO digest_windows(job_id,digest_date,window_start,window_end,trigger_type,config_snapshot,created_at) VALUES(?,?,?,?,?,?,?)',
        snapshot.job_id,
        date,
        end - lookbackMs,
        end,
        trigger,
        canonicalJson(snapshot),
        this.repository.now(),
      ).lastInsertRowid;
      return { window: this.window(Number(id))!, created: true };
    });
  }
  private candidateGroups(
    window: DigestWindow,
    existing: Map<string, DigestRun>,
    target?: string,
  ): Map<string, Entry[]> {
    const snapshot = window.config_snapshot;
    const groups = new Map<string, Entry[]>(),
      outputs = this.repository.outputFeedIds();
    for (const entry of this.repository.entriesInWindow(
      window.window_start,
      window.window_end,
    )) {
      const key =
        snapshot.output.partition_by === 'all'
          ? 'all'
          : `category:${entry.category_id}`;
      if (
        existing.has(key) ||
        (target && target !== key) ||
        outputs.has(entry.feed_id)
      )
        continue;
      const reason = exclusionReason(snapshot, entry);
      if (reason) {
        this.db.afterCommit(() => this.excluded(snapshot.job_id, reason!));
        continue;
      }
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    return groups;
  }
  select(
    windowId: number,
    target?: string,
  ): Array<{
    partition_key: string;
    status: 'created' | 'existing' | 'empty';
    run?: DigestRun;
  }> {
    return this.db.transaction(() => {
      const window = this.window(windowId);
      if (!window) throw new Error('digest_window_not_found');
      const snapshot = window.config_snapshot;
      validateTarget(snapshot, target);
      const existing = new Map(
        this.runs(window.id).map((r) => [r.partition_key, r]),
      );
      const results: Array<{
        partition_key: string;
        status: 'created' | 'existing' | 'empty';
        run?: DigestRun;
      }> = [...existing.values()]
        .filter((r) => !target || r.partition_key === target)
        .map((r) => ({
          partition_key: r.partition_key,
          status: 'existing',
          run: r,
        }));
      const groups = this.candidateGroups(window, existing, target);
      for (const [key, eligible] of groups) {
        const counts = new Map<number, number>();
        const retained = eligible
          .filter((e) => {
            const count = counts.get(e.feed_id) ?? 0;
            counts.set(e.feed_id, count + 1);
            return count < snapshot.selection.max_entries_per_feed;
          })
          .slice(0, snapshot.selection.max_entries);
        if (!retained.length) continue;
        const title = key === 'all' ? null : retained[0]!.source_category_title;
        this.ensureFeed(snapshot, key, title);
        const id = Number(
          this.db.run(
            'INSERT INTO digest_runs(digest_window_id,partition_key,source_category_id,source_category_title,state,external_id,dropped_count,ai_stats,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            window.id,
            key,
            key === 'all' ? null : retained[0]!.category_id,
            title,
            'pending',
            `mfai:digest:${snapshot.job_id}:${key}:${window.digest_date}`,
            eligible.length - retained.length,
            canonicalJson(zeroDigestStats()),
            this.repository.now(),
            this.repository.now(),
          ).lastInsertRowid,
        );
        retained.forEach((e, position) =>
          this.db.run(
            'INSERT INTO digest_run_candidates(digest_run_id,entry_id,selection_position) VALUES(?,?,?)',
            id,
            e.entry_id,
            position,
          ),
        );
        if (title !== null)
          this.db.run(
            'UPDATE digest_output_feeds SET source_category_title=?,updated_at=? WHERE job_id=? AND partition_key=?',
            title,
            this.repository.now(),
            snapshot.job_id,
            key,
          );
        results.push({
          partition_key: key,
          status: 'created',
          run: this.run(id)!,
        });
      }
      this.db.run(
        'UPDATE digest_windows SET last_evaluated_at=? WHERE id=?',
        this.repository.now(),
        window.id,
      );
      if (!results.length && (target || snapshot.output.partition_by === 'all'))
        results.push({ partition_key: target ?? 'all', status: 'empty' });
      return results;
    });
  }
  continuationSnapshot(jobId: string, key: string): DigestSnapshot | undefined {
    const row = this.db.get<{ id: number }>(
      "SELECT w.id FROM digest_windows w JOIN digest_runs r ON r.digest_window_id=w.id WHERE w.job_id=? AND r.partition_key=? AND r.state IN ('pending','running') ORDER BY w.window_end,r.id LIMIT 1",
      jobId,
      key,
    );
    return row ? this.window(row.id)!.config_snapshot : undefined;
  }
  markFeed(
    jobId: string,
    key: string,
    state: 'ready' | 'degraded',
    reason: string | null,
    next: number | null,
    feed?: { id: number; categoryId: number },
  ): void {
    this.db.transaction(() => {
      const previous = this.feed(jobId, key);
      if (!previous) throw new Error('feed_registry_missing');
      if (feed) {
        safeId.parse(feed.id);
        safeId.parse(feed.categoryId);
        if (previous.feed_id !== null && previous.feed_id !== feed.id)
          throw new Error('feed_identity_changed');
      }
      this.db.run(
        'UPDATE digest_output_feeds SET state=?,reason=?,last_attempt_at=?,next_attempt_at=?,feed_id=?,destination_category_id=?,updated_at=? WHERE job_id=? AND partition_key=?',
        state,
        reason,
        this.repository.now(),
        next,
        feed?.id ?? previous.feed_id,
        feed?.categoryId ?? previous.destination_category_id,
        this.repository.now(),
        jobId,
        key,
      );
    });
  }
  activate(capability: () => boolean): number {
    return this.db.transaction(() => {
      if (!capability()) return 0;
      const rows = this.db.all<{ id: number }>(
        "SELECT r.id FROM digest_runs r JOIN digest_windows w ON w.id=r.digest_window_id WHERE r.state='pending' AND r.output_feed_id IS NULL ORDER BY w.window_end,r.id",
      );
      let created = 0;
      for (const row of rows) {
        const run = this.run(row.id)!,
          window = this.window(run.digest_window_id)!,
          feed = this.feed(window.job_id, run.partition_key);
        if (
          feed?.state !== 'ready' ||
          feed.feed_id === null ||
          this.repository.partitionBusy(window.job_id, run.partition_key)
        )
          continue;
        if (
          this.db.get(
            "SELECT id FROM tasks WHERE type='digest' AND json_extract(payload,'$.digest_run_id')=?",
            run.id,
          )
        )
          continue;
        this.db.run(
          'UPDATE digest_runs SET output_feed_id=?,updated_at=? WHERE id=? AND output_feed_id IS NULL',
          feed.feed_id,
          this.repository.now(),
          run.id,
        );
        this.repository.createTask(
          'digest',
          `digest:${window.job_id}:${run.partition_key}:${window.digest_date}`,
          null,
          {
            schema_version: 1,
            digest_run_id: run.id,
            config_snapshot: window.config_snapshot,
          },
        );
        created++;
      }
      return created;
    });
  }
  taskForRun(runId: number): Task | undefined {
    const row = this.db.get<{ id: number }>(
      "SELECT id FROM tasks WHERE type='digest' AND json_extract(payload,'$.digest_run_id')=? ORDER BY id DESC LIMIT 1",
      runId,
    );
    return row ? this.repository.task(row.id) : undefined;
  }
  completeImport(task: Task, entryId: number, stats: DigestStats): void {
    this.db.transaction(() => {
      this.repository.assertOwner(task);
      safeId.parse(entryId);
      const payload = digestPayloadSchema.parse(task.payload),
        run = this.run(payload.digest_run_id)!,
        window = this.window(run.digest_window_id)!;
      if (
        canonicalJson(payload.config_snapshot) !==
        canonicalJson(window.config_snapshot)
      )
        throw new Error('digest_snapshot_mismatch');
      const count = this.candidates(run.id).length;
      if (!count || run.state !== 'running')
        throw new Error('invalid_digest_completion');
      this.db.run(
        "UPDATE digest_runs SET state='imported',miniflux_entry_id=?,item_count=?,updated_at=? WHERE id=?",
        entryId,
        count,
        this.repository.now(),
        run.id,
      );
      this.repository.settle(task, 'done', stats);
      this.db.afterCommit(() =>
        this.repository.observe.digest(
          window.job_id,
          run.partition_key,
          'imported',
        ),
      );
    });
  }
  waiting(run: DigestRun, capability: boolean) {
    const window = this.window(run.digest_window_id)!,
      feed = this.feed(window.job_id, run.partition_key),
      task = this.taskForRun(run.id);
    const unactivated =
      run.state === 'pending' && run.output_feed_id === null && !task;
    const waiting_for_import_capability = unactivated && !capability;
    const awaiting_output_feed = unactivated && feed?.state !== 'ready';
    const waiting_for_partition =
      unactivated &&
      capability &&
      feed?.state === 'ready' &&
      this.repository.partitionBusy(window.job_id, run.partition_key);
    return {
      task_state: task?.state ?? null,
      waiting_for_import_capability,
      awaiting_output_feed,
      waiting_for_partition,
      waiting_since:
        waiting_for_import_capability ||
        awaiting_output_feed ||
        waiting_for_partition
          ? run.created_at
          : null,
    };
  }
  resolveDigestPermalink(
    jobId: string,
    partition: string,
    date: string,
  ): { outputFeedId: number; minifluxEntryId: number } | null {
    if (!validDate(date)) return null;
    const row = this.db.get<{
      output_feed_id: number;
      miniflux_entry_id: number;
    }>(
      "SELECT r.output_feed_id,r.miniflux_entry_id FROM digest_runs r JOIN digest_windows w ON w.id=r.digest_window_id WHERE w.job_id=? AND r.partition_key=? AND w.digest_date=? AND r.state='imported'",
      jobId,
      partition,
      date,
    );
    return row
      ? {
          outputFeedId: safeId.parse(row.output_feed_id),
          minifluxEntryId: safeId.parse(row.miniflux_entry_id),
        }
      : null;
  }
}
