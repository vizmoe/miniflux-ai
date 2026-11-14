import { mergeDigestStats } from '../ai/stats.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJson,
  nonempty,
  nonnegative,
  safeId,
  timestamp,
} from '../config/primitives.js';
import {
  ARTIFACT_MARKER_TOKEN_BYTES,
  FOREGROUND_RESERVED_SLOTS,
} from '../config/constants.js';
import { ApiError, LeaseLost, WorkError } from '../obs/errors.js';
import {
  artifactStatsSchema,
  backfillProgressSchema,
  bindingSchema,
  cursorSchema,
  digestPayloadSchema,
  digestStatsSchema,
  generatePayloadSchema,
  lastErrorSchema,
  retryPolicyOf,
  summaryArtifactSchema,
  summaryRenderSchema,
  taskSchemas,
  translationArtifactSchema,
  translationRenderSchema,
} from './documents.js';
import type {
  ArtifactStats,
  BackfillProgress,
  Binding,
  DigestStats,
  FeatureKind,
  GeneratePayload,
  LastError,
  RetryPolicy,
  SummaryPayload,
  TaskPayload,
  TaskType,
  TranslationPayload,
} from './documents.js';
import type { Entry, FeatureState, tasks, artifacts } from './schema.js';
import type { Database } from './database.js';

export const compactEntrySchema = z
  .object({
    entry_id: safeId,
    feed_id: safeId,
    category_id: safeId,
    entry_url: z.string(),
    published_at: timestamp,
    source_author: z.string(),
    source_feed_title: nonempty,
    source_feed_url: nonempty,
    source_feed_site_url: z.string(),
    source_category_title: nonempty,
    source_title: z.string(),
    source_content_units: nonnegative,
    primary_language: z
      .string()
      .regex(/^[a-z]{2,8}$/)
      .nullable(),
    language_confidence: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .refine(
    (v) => (v.primary_language === null) === (v.language_confidence === null),
  );
export type CompactEntry = z.infer<typeof compactEntrySchema>;
type TaskRow = typeof tasks.$inferSelect;
export type Task = Omit<
  TaskRow,
  'type' | 'payload' | 'progress' | 'last_error' | 'state'
> & {
  type: TaskType;
  payload: TaskPayload;
  progress: BackfillProgress | null;
  last_error: LastError | null;
  state: 'pending' | 'leased' | 'done' | 'dead';
};
type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactBase = Omit<
  ArtifactRow,
  'kind' | 'payload' | 'render_spec' | 'ai_stats'
> & { ai_stats: ArtifactStats };
export type Artifact = ArtifactBase &
  (
    | {
        kind: 'translation';
        payload: TranslationPayload;
        render_spec: z.infer<typeof translationRenderSchema>;
      }
    | {
        kind: 'summary';
        payload: SummaryPayload;
        render_spec: z.infer<typeof summaryRenderSchema>;
      }
  );
export type ArtifactInput = Artifact extends infer T
  ? T extends Artifact
    ? Omit<T, 'id' | 'entry_id' | 'marker_token' | 'created_at'>
    : never
  : never;
export type Admission = {
  kind: FeatureKind;
  state: 'pending' | 'scheduled' | 'skipped';
  skip_reason: string | null;
};
export type RequeueReason = {
  code: string;
  reason?: string;
  feature?: FeatureKind;
};

export function backoff(
  policy: RetryPolicy,
  attempts: number,
  random = Math.random(),
): number {
  return Math.min(
    policy.initial_delay_ms *
      policy.multiplier ** (attempts - 1) *
      (1 - policy.jitter_ratio + 2 * policy.jitter_ratio * random),
    policy.max_delay_ms,
  );
}
export class Repository {
  observe = {
    entry: (_units: number): void => {},
    feature: (_kind: FeatureKind, _state: string): void => {},
    task: (_type: TaskType, _state: string, _duration: number): void => {},
    digest: (_job: string, _partition: string, _state: string): void => {},
  };
  private featureChanged(kind: string, state: string): void {
    this.db.afterCommit(() => this.observe.feature(kind as FeatureKind, state));
  }
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {}
  entry(id: number): Entry | undefined {
    safeId.parse(id);
    return this.db.get<Entry>('SELECT * FROM entries WHERE entry_id = ?', id);
  }
  entriesInWindow(start: number, end: number): Entry[] {
    return this.db.all<Entry>(
      'SELECT * FROM entries WHERE published_at >= ? AND published_at < ? ORDER BY published_at DESC,entry_id DESC',
      start,
      end,
    );
  }
  insertEntry(input: CompactEntry, fingerprint: string | null = null): boolean {
    const data = compactEntrySchema.parse(input);
    const columns = Object.keys(data);
    const inserted =
      this.db.run(
        `INSERT INTO entries (${columns.join(',')},created_at,updated_at) VALUES (${columns.map(() => '?').join(',')},?,?) ON CONFLICT(entry_id) DO NOTHING`,
        ...Object.values(data),
        this.now(),
        this.now(),
      ).changes === 1;
    if (inserted) {
      this.db.run(
        'UPDATE entries SET source_fingerprint=? WHERE entry_id=?',
        fingerprint,
        data.entry_id,
      );
      this.db.afterCommit(() => this.observe.entry(data.source_content_units));
    }
    return inserted;
  }
  recoveryCandidates(before: number, limit: number): Entry[] {
    return this.db.all<Entry>(
      'SELECT * FROM entries WHERE recovery_checked_at<=? ORDER BY recovery_checked_at,entry_id LIMIT ?',
      before,
      limit,
    );
  }
  checkedEntry(id: number, outcome: string): void {
    this.db.run(
      'UPDATE entries SET recovery_checked_at=?,recovery_outcome=? WHERE entry_id=?',
      this.now(),
      outcome,
      id,
    );
  }
  activeRender(entryId: number): boolean {
    return Boolean(
      this.db.get(
        "SELECT id FROM tasks WHERE entry_id=? AND type='render' AND state IN ('pending','leased') LIMIT 1",
        entryId,
      ),
    );
  }
  establishSourceFingerprint(id: number, fingerprint: string): void {
    this.db.run(
      'UPDATE entries SET source_fingerprint=? WHERE entry_id=? AND source_fingerprint IS NULL',
      fingerprint,
      id,
    );
  }
  acknowledgeSourceOnly(id: number, title: string): void {
    this.db.run(
      'UPDATE entries SET rendered_generation=render_generation,rendered_title=? WHERE entry_id=?',
      title,
      id,
    );
  }
  refreshSource(
    id: number,
    facts: Pick<
      CompactEntry,
      | 'source_title'
      | 'source_content_units'
      | 'primary_language'
      | 'language_confidence'
    >,
    fingerprint: string,
  ): void {
    this.db.transaction(() => {
      // Revoking ownership fences in-flight model responses and obsolete render
      // tasks. Old Artifact tokens remain available for Source projection.
      this.db.run(
        "UPDATE tasks SET state='dead',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE entry_id=? AND state IN ('pending','leased')",
        canonicalJson(
          new WorkError('source_changed', 'validation', false).detail,
        ),
        this.now(),
        id,
      );
      this.db.run(
        "UPDATE entry_feature_states SET state='failed',current_artifact_id=NULL,last_generation_task_id=NULL,skip_reason=NULL,updated_at=? WHERE entry_id=?",
        this.now(),
        id,
      );
      this.db.run(
        'UPDATE entries SET source_title=?,source_content_units=?,primary_language=?,language_confidence=?,source_fingerprint=?,source_revision=source_revision+1,updated_at=? WHERE entry_id=?',
        facts.source_title,
        facts.source_content_units,
        facts.primary_language,
        facts.language_confidence,
        fingerprint,
        this.now(),
        id,
      );
    });
  }
  binding(): Binding | undefined {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM service_state WHERE key = 'miniflux_account_binding'",
    );
    return row ? bindingSchema.parse(JSON.parse(row.value)) : undefined;
  }
  bind(value: Binding, expected?: Binding): void {
    const encoded = canonicalJson(bindingSchema.parse(value));
    this.db.transaction(() => {
      const current = this.binding();
      if (canonicalJson(current ?? null) !== canonicalJson(expected ?? null))
        throw new ApiError(409, 'miniflux_binding_conflict');
      this.db.run(
        "INSERT INTO service_state(key,value,updated_at) VALUES('miniflux_account_binding',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        encoded,
        this.now(),
      );
    });
  }
  cursor(): number | undefined {
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM service_state WHERE key = 'new_entry_poll_cursor'",
    );
    return row
      ? cursorSchema.parse(JSON.parse(row.value)).after_entry_id
      : undefined;
  }
  setCursor(value: number): void {
    const payload = cursorSchema.parse({
      schema_version: 1,
      after_entry_id: value,
    });
    if (value < (this.cursor() ?? 0)) throw new Error('cursor_regression');
    this.db.run(
      "INSERT INTO service_state(key,value,updated_at) VALUES('new_entry_poll_cursor',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      canonicalJson(payload),
      this.now(),
    );
  }
  outputFeedIds(): Set<number> {
    return new Set(
      this.db
        .all<{ feed_id: number }>(
          'SELECT feed_id FROM digest_output_feeds WHERE feed_id IS NOT NULL',
        )
        .map((f) => f.feed_id),
    );
  }
  featureStates(entryId: number): FeatureState[] {
    return this.db.all<FeatureState>(
      'SELECT * FROM entry_feature_states WHERE entry_id = ? ORDER BY kind DESC',
      entryId,
    );
  }
  activeGeneration(entryId: number): Task | undefined {
    return this.decodeTask(
      this.db.get<TaskRow>(
        "SELECT * FROM tasks WHERE type = 'generate_artifacts' AND entry_id = ? AND state IN ('pending','leased')",
        entryId,
      ),
    );
  }
  private decodeTask(row: TaskRow | undefined): Task | undefined {
    if (!row) return undefined;
    const type = row.type as TaskType;
    if (!(type in taskSchemas)) throw new Error('invalid_task_type');
    return {
      ...row,
      type,
      state: z.enum(['pending', 'leased', 'done', 'dead']).parse(row.state),
      payload: taskSchemas[type].parse(JSON.parse(row.payload)),
      progress:
        row.progress === null
          ? null
          : backfillProgressSchema.parse(JSON.parse(row.progress)),
      last_error:
        row.last_error === null
          ? null
          : lastErrorSchema.parse(JSON.parse(row.last_error)),
    };
  }
  task(id: number): Task | undefined {
    return this.decodeTask(
      this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id),
    );
  }
  listTasks(
    filter: {
      state?: string;
      type?: string;
      entry_id?: number;
      limit?: number;
      before_id?: number;
    } = {},
  ): Task[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const key of ['state', 'type', 'entry_id'] as const)
      if (filter[key] !== undefined) {
        clauses.push(`${key} = ?`);
        params.push(filter[key]);
      }
    if (filter.before_id !== undefined) {
      clauses.push('id < ?');
      params.push(filter.before_id);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    return this.db
      .all<TaskRow>(
        `SELECT * FROM tasks ${where} ORDER BY id DESC LIMIT ?`,
        ...params,
        filter.limit ?? 100,
      )
      .map((r) => this.decodeTask(r)!);
  }
  createTask(
    type: TaskType,
    key: string,
    entryId: number | null,
    payload: TaskPayload,
    progress: BackfillProgress | null = null,
    attempts = 0,
    runAfter = this.now(),
  ): Task {
    const parsed = taskSchemas[type].parse(payload);
    const result = this.db.run(
      'INSERT INTO tasks(type,dedup_key,entry_id,payload,progress,state,priority,attempts,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      type,
      key,
      entryId,
      canonicalJson(parsed),
      progress === null
        ? null
        : canonicalJson(backfillProgressSchema.parse(progress)),
      'pending',
      ['generate_artifacts', 'render'].includes(type) ? 100 : 0,
      attempts,
      Math.ceil(runAfter),
      this.now(),
      this.now(),
    );
    return this.task(Number(result.lastInsertRowid))!;
  }
  admit(
    entryId: number,
    decisions: Admission[],
    payload: GeneratePayload | null,
    onlyMissing = false,
    retryPolicy?: RetryPolicy,
  ): { admitted: boolean; task: Task | null } {
    return this.db.transaction(() => {
      const prior = this.featureStates(entryId);
      const allowed = decisions.filter(
        (d) => !onlyMissing || !prior.some((p) => p.kind === d.kind),
      );
      const due = allowed
        .filter((d) => d.state === 'pending')
        .map((d) => d.kind);
      if (allowed.length && this.activeGeneration(entryId))
        throw new ApiError(409, 'generation_in_progress');
      const removed = this.admitFeatures(entryId, allowed, prior);
      let task: Task | null = null;
      if (due.length) {
        if (!payload) throw new Error('generation_snapshot_required');
        const narrowed = this.narrowPayload(payload, due);
        task = this.createTask(
          'generate_artifacts',
          `generate:${entryId}`,
          entryId,
          narrowed,
        );
        for (const kind of due)
          this.db.run(
            'UPDATE entry_feature_states SET last_generation_task_id=? WHERE entry_id=? AND kind=?',
            task.id,
            entryId,
            kind,
          );
      }
      if (removed) {
        const retry = retryPolicy ?? payload?.retry_policy;
        if (!retry) throw new Error('render_retry_policy_required');
        this.requestRender(entryId, retry);
      }
      return { admitted: allowed.length > 0, task };
    });
  }
  private admitFeatures(
    entryId: number,
    allowed: Admission[],
    prior: ReturnType<Repository['featureStates']>,
  ): boolean {
    let removed = false;
    for (const d of allowed) {
      const old = prior.find((p) => p.kind === d.kind);
      if (old?.state !== d.state) this.featureChanged(d.kind, d.state);
      if (d.state === 'skipped' && old?.current_artifact_id) removed = true;
      this.db.run(
        `INSERT INTO entry_feature_states(entry_id,kind,state,current_artifact_id,last_generation_task_id,skip_reason,created_at,updated_at) VALUES(?,?,?,NULL,NULL,?,?,?) ON CONFLICT(entry_id,kind) DO UPDATE SET state=excluded.state,skip_reason=excluded.skip_reason,current_artifact_id=CASE WHEN excluded.state IN ('skipped','scheduled') THEN NULL ELSE entry_feature_states.current_artifact_id END,updated_at=excluded.updated_at`,
        entryId,
        d.kind,
        d.state,
        d.skip_reason,
        this.now(),
        this.now(),
      );
    }
    return removed;
  }
  narrowPayload(
    payload: GeneratePayload,
    kinds: FeatureKind[],
  ): GeneratePayload {
    return generatePayloadSchema.parse({
      schema_version: 1,
      requested_features: ['translation', 'summary'].filter((k) =>
        kinds.includes(k as FeatureKind),
      ),
      ai: payload.ai,
      retry_policy: payload.retry_policy,
      ...(kinds.includes('translation')
        ? { translation: payload.translation }
        : {}),
      ...(kinds.includes('summary') ? { summary: payload.summary } : {}),
    });
  }
  requestRender(entryId: number, retry: RetryPolicy): Task {
    return this.db.transaction(() => {
      const row = this.db.get<{ render_generation: number }>(
        'UPDATE entries SET render_generation=render_generation+1,updated_at=? WHERE entry_id=? RETURNING render_generation',
        this.now(),
        entryId,
      );
      if (!row) throw new Error('entry_not_found');
      return this.createTask(
        'render',
        `render:${entryId}:${row.render_generation}`,
        entryId,
        {
          schema_version: 1,
          render_generation: row.render_generation,
          retry_policy: retry,
        },
      );
    });
  }
  artifacts(entryId: number): Artifact[] {
    return this.db
      .all<ArtifactRow>(
        'SELECT * FROM artifacts WHERE entry_id = ? ORDER BY id',
        entryId,
      )
      .map((r) => {
        const common = {
          ...r,
          ai_stats: artifactStatsSchema.parse(JSON.parse(r.ai_stats)),
        };
        return r.kind === 'translation'
          ? {
              ...common,
              kind: 'translation',
              payload: translationArtifactSchema.parse(JSON.parse(r.payload)),
              render_spec: translationRenderSchema.parse(
                JSON.parse(r.render_spec),
              ),
            }
          : {
              ...common,
              kind: 'summary',
              payload: summaryArtifactSchema.parse(JSON.parse(r.payload)),
              render_spec: summaryRenderSchema.parse(JSON.parse(r.render_spec)),
            };
      });
  }
  currentArtifacts(entryId: number): Artifact[] {
    const pointers = this.featureStates(entryId).filter(
      (s) => s.current_artifact_id !== null,
    );
    const artifacts = this.artifacts(entryId);
    return pointers.map((s) => {
      const result = artifacts.find(
        (a) => a.id === s.current_artifact_id && a.kind === s.kind,
      );
      if (!result) throw new Error('invalid_artifact_pointer');
      return result;
    });
  }
  readySummary(
    entryId: number,
    outputLanguage: string,
  ): SummaryPayload | undefined {
    const state = this.featureStates(entryId).find((s) => s.kind === 'summary');
    if (state?.state !== 'ready') return undefined;
    const artifact = this.currentArtifacts(entryId).find(
      (a) => a.kind === 'summary' && a.output_language === outputLanguage,
    );
    return artifact?.kind === 'summary' ? artifact.payload : undefined;
  }
  assertOwner(task: Task): void {
    if (
      !task.lease_owner ||
      !this.db.get(
        "SELECT id FROM tasks WHERE id=? AND state='leased' AND lease_owner=?",
        task.id,
        task.lease_owner,
      )
    )
      throw new LeaseLost();
  }
  claim(concurrency: number, leaseMs: number): Task | undefined {
    return this.db.transaction(() => {
      const active = this.db.get<{ total: number; background: number }>(
        "SELECT count(*) AS total,coalesce(sum(priority=0),0) AS background FROM tasks WHERE state='leased'",
      )!;
      if (active.total >= concurrency) return undefined;
      const row = this.db.get<TaskRow>(
        "SELECT * FROM tasks WHERE state='pending' AND run_after<=? AND (priority=100 OR (priority=0 AND ? < ?)) ORDER BY priority DESC,(type='render') DESC,created_at ASC,id ASC LIMIT 1",
        this.now(),
        active.background,
        concurrency - FOREGROUND_RESERVED_SLOTS,
      );
      const task = this.decodeTask(row);
      if (!task) return undefined;
      if (task.attempts >= retryPolicyOf(task.payload).max_attempts) {
        this.deadPending(
          task,
          new WorkError('attempts_exhausted', 'validation', false).detail,
        );
        return undefined;
      }
      if (task.type === 'generate_artifacts') {
        const p = generatePayloadSchema.parse(task.payload);
        const states = this.featureStates(task.entry_id!);
        if (
          p.requested_features.some(
            (k) =>
              !states.some(
                (s) =>
                  s.kind === k &&
                  s.state === 'pending' &&
                  s.last_generation_task_id === task.id,
              ),
          )
        ) {
          this.deadPending(
            task,
            new WorkError('task_superseded', 'validation', false).detail,
          );
          return undefined;
        }
      }
      const claimed = this.decodeTask(
        this.db.get<TaskRow>(
          "UPDATE tasks SET state='leased',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='pending' RETURNING *",
          randomUUID(),
          this.now() + leaseMs,
          this.now(),
          task.id,
        ),
      )!;
      if (task.type === 'generate_artifacts')
        for (const kind of generatePayloadSchema.parse(task.payload)
          .requested_features)
          this.featureChanged(kind, 'processing');
      if (task.type === 'generate_artifacts')
        this.db.run(
          "UPDATE entry_feature_states SET state='processing',updated_at=? WHERE last_generation_task_id=? AND state='pending'",
          this.now(),
          task.id,
        );
      if (task.type === 'digest') {
        const runId = digestPayloadSchema.parse(task.payload).digest_run_id;
        if (
          this.db.run(
            "UPDATE digest_runs SET state='running',updated_at=? WHERE id=? AND state='pending' AND output_feed_id IS NOT NULL",
            this.now(),
            runId,
          ).changes !== 1
        )
          throw new Error('invalid_digest_claim');
      }
      return claimed;
    });
  }
  renew(task: Task, leaseMs: number): void {
    if (
      this.db.run(
        "UPDATE tasks SET lease_expires_at=? WHERE id=? AND state='leased' AND lease_owner=?",
        this.now() + leaseMs,
        task.id,
        task.lease_owner,
      ).changes !== 1
    )
      throw new LeaseLost();
  }
  private updateRelated(
    task: Task,
    terminal: boolean,
    tombstoned = false,
  ): void {
    if (task.type === 'generate_artifacts') {
      const state = terminal ? 'failed' : 'pending';
      this.updateGenerationRelated(task, state);
      return;
    }
    if (task.type !== 'digest') return;
    let state = terminal ? 'failed' : 'pending';
    if (tombstoned) state = 'tombstoned';
    if (terminal) {
      const run = this.db.get<{ job_id: string; partition_key: string }>(
        'SELECT w.job_id,r.partition_key FROM digest_runs r JOIN digest_windows w ON w.id=r.digest_window_id WHERE r.id=?',
        digestPayloadSchema.parse(task.payload).digest_run_id,
      )!;
      this.db.afterCommit(() =>
        this.observe.digest(run.job_id, run.partition_key, state),
      );
    }
    this.db.run(
      'UPDATE digest_runs SET state=?,updated_at=? WHERE id=?',
      state,
      this.now(),
      digestPayloadSchema.parse(task.payload).digest_run_id,
    );
  }
  private updateGenerationRelated(
    task: Task,
    next: 'failed' | 'pending',
  ): void {
    for (const state of this.featureStates(task.entry_id!).filter(
      (s) =>
        s.last_generation_task_id === task.id &&
        ['processing', 'pending'].includes(s.state),
    ))
      if (state.state !== next) this.featureChanged(state.kind, next);
    this.db.run(
      "UPDATE entry_feature_states SET state=?,updated_at=? WHERE last_generation_task_id=? AND state IN ('processing','pending')",
      next,
      this.now(),
      task.id,
    );
  }
  private deadPending(task: Task, error: LastError): void {
    this.db.run(
      "UPDATE tasks SET state='dead',last_error=?,updated_at=? WHERE id=? AND state='pending'",
      canonicalJson(lastErrorSchema.parse(error)),
      this.now(),
      task.id,
    );
    this.updateRelated(task, true);
    this.db.afterCommit(() => this.observe.task(task.type, 'dead', 0));
  }
  settle(
    task: Task,
    outcome: 'done' | WorkError,
    digestDelta?: DigestStats,
  ): void {
    this.db.transaction(() => {
      this.assertOwner(task);
      if (digestDelta)
        this.addDigestStats(
          digestPayloadSchema.parse(task.payload).digest_run_id,
          digestDelta,
        );
      const terminal =
        outcome === 'done' ||
        !outcome.detail.retryable ||
        task.attempts >= retryPolicyOf(task.payload).max_attempts;
      let state = terminal ? 'dead' : 'pending';
      if (outcome === 'done') state = 'done';
      const after =
        outcome === 'done'
          ? this.now()
          : this.now() +
            Math.max(
              backoff(retryPolicyOf(task.payload), task.attempts),
              outcome.retryAfterMs,
            );
      this.db.run(
        'UPDATE tasks SET state=?,run_after=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND lease_owner=?',
        state,
        Math.ceil(after),
        outcome === 'done' ? null : canonicalJson(outcome.detail),
        this.now(),
        task.id,
        task.lease_owner,
      );
      if (outcome !== 'done')
        this.updateRelated(
          task,
          terminal,
          outcome.detail.failure_class === 'tombstoned',
        );
      this.db.afterCommit(() =>
        this.observe.task(
          task.type,
          state,
          Math.max(0, this.now() - task.updated_at),
        ),
      );
    });
  }
  reap(): number {
    return this.db.transaction(() => {
      const expired = this.db.all<TaskRow>(
        "SELECT * FROM tasks WHERE state='leased' AND lease_expires_at<=?",
        this.now(),
      );
      for (const row of expired)
        this.settle(
          this.decodeTask(row)!,
          new WorkError('lease_expired', 'timeout', true),
        );
      return expired.length;
    });
  }
  private storeArtifact(task: Task, input: ArtifactInput): void {
    const kind = input.kind;
    this.featureChanged(kind, 'ready');
    const body =
      kind === 'translation'
        ? translationArtifactSchema.parse(input.payload)
        : summaryArtifactSchema.parse(input.payload);
    const render =
      kind === 'translation'
        ? translationRenderSchema.parse(input.render_spec)
        : summaryRenderSchema.parse(input.render_spec);
    const id = this.db.run(
      'INSERT INTO artifacts(entry_id,kind,marker_token,output_language,payload,render_spec,ai_stats,created_at) VALUES(?,?,?,?,?,?,?,?)',
      task.entry_id,
      kind,
      randomBytes(ARTIFACT_MARKER_TOKEN_BYTES).toString('hex'),
      input.output_language,
      canonicalJson(body),
      canonicalJson(render),
      canonicalJson(artifactStatsSchema.parse(input.ai_stats)),
      this.now(),
    ).lastInsertRowid;
    this.db.run(
      "UPDATE entry_feature_states SET state='ready',current_artifact_id=?,skip_reason=NULL,updated_at=? WHERE entry_id=? AND kind=?",
      id,
      this.now(),
      task.entry_id,
      kind,
    );
  }
  private saveGenerationMembers(
    task: Task,
    payload: GeneratePayload,
    inputs: ArtifactInput[],
    failures: Partial<Record<FeatureKind, WorkError>>,
  ): { retryKinds: FeatureKind[]; terminalKinds: FeatureKind[] } {
    const retryKinds: FeatureKind[] = [];
    const terminalKinds: FeatureKind[] = [];
    for (const kind of payload.requested_features) {
      const state = this.featureStates(task.entry_id!).find(
        (s) => s.kind === kind,
      );
      if (
        state?.state !== 'processing' ||
        state.last_generation_task_id !== task.id
      )
        throw new LeaseLost();
      const input = inputs.find((a) => a.kind === kind);
      if (input) {
        this.storeArtifact(task, input);
        continue;
      }
      const error = failures[kind];
      if (!error) throw new Error('missing_generation_outcome');
      if (
        error.detail.retryable &&
        task.attempts < payload.retry_policy.max_attempts
      )
        retryKinds.push(kind);
      else terminalKinds.push(kind);
      this.featureChanged(
        kind,
        retryKinds.includes(kind) ? 'pending' : 'failed',
      );
      this.db.run(
        'UPDATE entry_feature_states SET state=?,updated_at=? WHERE entry_id=? AND kind=?',
        retryKinds.includes(kind) ? 'pending' : 'failed',
        this.now(),
        task.entry_id,
        kind,
      );
    }
    return { retryKinds, terminalKinds };
  }
  completeGeneration(
    task: Task,
    inputs: ArtifactInput[],
    failures: Partial<Record<FeatureKind, WorkError>>,
  ): void {
    this.db.transaction(() => {
      this.assertOwner(task);
      const payload = generatePayloadSchema.parse(task.payload);
      const requested = new Set(payload.requested_features);
      if (
        new Set(inputs.map((a) => a.kind)).size !== inputs.length ||
        inputs.some((a) => !requested.has(a.kind))
      )
        throw new Error('invalid_generation_result');
      if (
        !inputs.length &&
        payload.requested_features.every((kind) => failures[kind]) &&
        new Set(
          payload.requested_features.map(
            (kind) => failures[kind]!.detail.retryable,
          ),
        ).size === 1
      ) {
        const first = failures[payload.requested_features[0]!]!;
        this.settle(
          task,
          new WorkError(
            first.detail.code,
            first.detail.failure_class,
            first.detail.retryable,
            Math.max(
              ...payload.requested_features.map(
                (kind) => failures[kind]!.retryAfterMs,
              ),
            ),
            first.detail,
          ),
        );
        return;
      }
      const { retryKinds, terminalKinds } = this.saveGenerationMembers(
        task,
        payload,
        inputs,
        failures,
      );
      this.settle(task, 'done');
      if (inputs.length)
        this.requestRender(task.entry_id!, payload.retry_policy);
      // Every failed member retains its own resumable lineage, even when the
      // joint task is done because its sibling installed an Artifact.
      for (const kind of terminalKinds) {
        const terminal = this.createTask(
          'generate_artifacts',
          task.dedup_key,
          task.entry_id,
          this.narrowPayload(payload, [kind]),
          null,
          task.attempts,
        );
        this.deadPending(terminal, failures[kind]!.detail);
        this.db.run(
          'UPDATE entry_feature_states SET last_generation_task_id=? WHERE entry_id=? AND kind=?',
          terminal.id,
          task.entry_id,
          kind,
        );
      }
      if (retryKinds.length) {
        const next = this.createTask(
          'generate_artifacts',
          task.dedup_key,
          task.entry_id,
          this.narrowPayload(payload, retryKinds),
          null,
          task.attempts,
          this.now() +
            Math.max(
              backoff(payload.retry_policy, task.attempts),
              ...retryKinds.map((k) => failures[k]!.retryAfterMs),
            ),
        );
        for (const kind of retryKinds)
          this.db.run(
            'UPDATE entry_feature_states SET last_generation_task_id=? WHERE entry_id=? AND kind=?',
            next.id,
            task.entry_id,
            kind,
          );
      }
      // Terminal member diagnostics belong to the completed lineage when its sibling succeeded.
      const failed = payload.requested_features
        .map((k) => failures[k])
        .find(Boolean);
      if (failed)
        this.db.run(
          'UPDATE tasks SET last_error=? WHERE id=?',
          canonicalJson(failed.detail),
          task.id,
        );
    });
  }
  completeRender(task: Task, generation: number, title?: string): void {
    this.db.transaction(() => {
      this.assertOwner(task);
      if (
        this.db.run(
          'UPDATE entries SET rendered_generation=?,rendered_at=?,updated_at=? WHERE entry_id=? AND render_generation=? AND rendered_generation<?',
          generation,
          this.now(),
          this.now(),
          task.entry_id,
          generation,
          generation,
        ).changes !== 1
      )
        throw new Error('render_generation_changed');
      if (title !== undefined)
        this.db.run(
          'UPDATE entries SET rendered_title=? WHERE entry_id=?',
          title,
          task.entry_id,
        );
      this.settle(task, 'done');
    });
  }
  updateBackfill(
    task: Task,
    progress: BackfillProgress,
    admissions: () => void,
  ): void {
    this.db.transaction(() => {
      this.assertOwner(task);
      admissions();
      this.db.run(
        'UPDATE tasks SET progress=?,updated_at=? WHERE id=? AND lease_owner=?',
        canonicalJson(backfillProgressSchema.parse(progress)),
        this.now(),
        task.id,
        task.lease_owner,
      );
    });
  }
  addDigestStats(runId: number, delta: DigestStats): void {
    digestStatsSchema.parse(delta);
    const row = this.db.get<{ ai_stats: string }>(
      'SELECT ai_stats FROM digest_runs WHERE id=?',
      runId,
    );
    if (!row) throw new Error('digest_run_not_found');
    const total = mergeDigestStats(
      digestStatsSchema.parse(JSON.parse(row.ai_stats)),
      delta,
    );
    this.db.run(
      'UPDATE digest_runs SET ai_stats=? WHERE id=?',
      canonicalJson(digestStatsSchema.parse(total)),
      runId,
    );
  }
  requeueReason(task: Task): RequeueReason | null {
    if (task.state !== 'dead') return { code: 'task_not_dead' };
    if (task.type === 'generate_artifacts') {
      if (this.activeGeneration(task.entry_id!))
        return { code: 'generation_in_progress' };
      const states = this.featureStates(task.entry_id!);
      for (const kind of generatePayloadSchema.parse(task.payload)
        .requested_features)
        if (
          !states.some(
            (s) =>
              s.kind === kind &&
              s.state === 'failed' &&
              s.last_generation_task_id === task.id,
          )
        )
          return {
            code: 'task_superseded',
            reason: 'feature_superseded',
            feature: kind,
          };
    }
    if (task.type === 'digest') {
      const runId = digestPayloadSchema.parse(task.payload).digest_run_id;
      const run = this.db.get<{
        state: string;
        partition_key: string;
        job_id: string;
      }>(
        'SELECT r.state,r.partition_key,w.job_id FROM digest_runs r JOIN digest_windows w ON w.id=r.digest_window_id WHERE r.id=?',
        runId,
      );
      if (run?.state !== 'failed')
        return { code: 'task_superseded', reason: 'run_tombstoned' };
      if (this.partitionBusy(run.job_id, run.partition_key))
        return { code: 'digest_partition_busy' };
    }
    return null;
  }
  partitionBusy(job: string, partition: string): boolean {
    return Boolean(
      this.db.get(
        "SELECT t.id FROM tasks t JOIN digest_runs r ON r.id=json_extract(t.payload,'$.digest_run_id') JOIN digest_windows w ON w.id=r.digest_window_id WHERE t.type='digest' AND t.state IN ('pending','leased') AND w.job_id=? AND r.partition_key=? LIMIT 1",
        job,
        partition,
      ),
    );
  }
  requeue(id: number): Task {
    return this.db.transaction(() => {
      const task = this.task(id);
      if (!task) throw new ApiError(404, 'task_not_found');
      const reason = this.requeueReason(task);
      if (reason) {
        const { code, ...rest } = reason;
        throw new ApiError(409, code, rest);
      }
      this.db.run(
        "UPDATE tasks SET state='pending',attempts=0,run_after=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
        this.now(),
        this.now(),
        id,
      );
      this.updateRelated(task, false);
      if (task.type === 'generate_artifacts')
        for (const state of this.featureStates(task.entry_id!).filter(
          (s) => s.last_generation_task_id === id && s.state === 'failed',
        ))
          this.featureChanged(state.kind, 'pending');
      if (task.type === 'generate_artifacts')
        this.db.run(
          "UPDATE entry_feature_states SET state='pending',updated_at=? WHERE last_generation_task_id=? AND state='failed'",
          this.now(),
          id,
        );
      return this.task(id)!;
    });
  }
  safeTask(task: Task) {
    const { payload: _payload, progress: _progress, ...safe } = task;
    return {
      ...safe,
      requeueable: this.requeueReason(task) === null,
      requeue_reason: this.requeueReason(task),
    };
  }
}
