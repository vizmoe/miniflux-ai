import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const times = () => ({
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});
export const adminSessions = sqliteTable('admin_sessions', {
  token_hash: text().primaryKey(),
  expires_at: integer().notNull(),
});
export const entries = sqliteTable(
  'entries',
  {
    entry_id: integer().primaryKey(),
    feed_id: integer().notNull(),
    category_id: integer().notNull(),
    entry_url: text().notNull(),
    published_at: integer().notNull(),
    source_author: text().notNull(),
    source_feed_title: text().notNull(),
    source_feed_url: text().notNull(),
    source_feed_site_url: text().notNull(),
    source_category_title: text().notNull(),
    source_title: text().notNull(),
    source_content_units: integer().notNull(),
    primary_language: text(),
    language_confidence: real(),
    source_fingerprint: text(),
    source_revision: integer().notNull().default(1),
    recovery_checked_at: integer().notNull().default(0),
    recovery_outcome: text(),
    rendered_title: text(),
    render_generation: integer().notNull().default(0),
    rendered_generation: integer().notNull().default(0),
    rendered_at: integer(),
    ...times(),
  },
  (t) => [
    check(
      'entry_ids',
      sql`${t.entry_id} > 0 AND ${t.entry_id} <= 9007199254740991 AND ${t.feed_id} > 0 AND ${t.category_id} > 0`,
    ),
    check('entry_source_units', sql`${t.source_content_units} >= 0`),
    check(
      'entry_metadata',
      sql`length(trim(${t.source_feed_title})) > 0 AND length(trim(${t.source_feed_url})) > 0 AND length(trim(${t.source_category_title})) > 0`,
    ),
    check(
      'entry_language',
      sql`(${t.primary_language} IS NULL) = (${t.language_confidence} IS NULL) AND (${t.language_confidence} IS NULL OR ${t.language_confidence} BETWEEN 0 AND 1)`,
    ),
    check(
      'entry_generations',
      sql`0 <= ${t.rendered_generation} AND ${t.rendered_generation} <= ${t.render_generation}`,
    ),
    index('entries_published_at').on(t.published_at),
    index('entries_feed_id').on(t.feed_id),
    index('entries_recovery_due').on(t.recovery_checked_at, t.entry_id),
    index('entries_render_pending')
      .on(t.entry_id)
      .where(sql`${t.render_generation} > ${t.rendered_generation}`),
  ],
);
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    dedup_key: text().notNull(),
    entry_id: integer().references(() => entries.entry_id),
    payload: text().notNull(),
    progress: text(),
    state: text().notNull(),
    priority: integer().notNull(),
    attempts: integer().notNull().default(0),
    run_after: integer().notNull(),
    lease_owner: text(),
    lease_expires_at: integer(),
    last_error: text(),
    ...times(),
  },
  (t) => [
    uniqueIndex('tasks_active_dedup')
      .on(t.dedup_key)
      .where(sql`${t.state} IN ('pending','leased')`),
    index('tasks_pending_claim_order')
      .on(sql`${t.priority} DESC`, t.created_at, t.id)
      .where(sql`${t.state} = 'pending'`),
    index('tasks_pending_due')
      .on(t.run_after)
      .where(sql`${t.state} = 'pending'`),
    index('tasks_leased_priority')
      .on(t.priority)
      .where(sql`${t.state} = 'leased'`),
    index('tasks_leased_expiry')
      .on(t.lease_expires_at)
      .where(sql`${t.state} = 'leased'`),
    check(
      'task_type',
      sql`${t.type} IN ('generate_artifacts','render','digest','ingest_backfill')`,
    ),
    check('task_state', sql`${t.state} IN ('pending','leased','done','dead')`),
    check(
      'task_entry',
      sql`(${t.type} IN ('generate_artifacts','render')) = (${t.entry_id} IS NOT NULL)`,
    ),
    check(
      'task_priority',
      sql`(${t.type} IN ('generate_artifacts','render') AND ${t.priority} = 100) OR (${t.type} IN ('digest','ingest_backfill') AND ${t.priority} = 0)`,
    ),
    check(
      'task_progress',
      sql`(${t.type} = 'ingest_backfill') = (${t.progress} IS NOT NULL)`,
    ),
    check(
      'task_lease',
      sql`(${t.state} = 'leased' AND ${t.lease_owner} IS NOT NULL AND ${t.lease_expires_at} IS NOT NULL) OR (${t.state} <> 'leased' AND ${t.lease_owner} IS NULL AND ${t.lease_expires_at} IS NULL)`,
    ),
    check('task_attempts', sql`${t.attempts} >= 0`),
  ],
);
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    entry_id: integer()
      .notNull()
      .references(() => entries.entry_id),
    kind: text().notNull(),
    marker_token: text().notNull().unique(),
    output_language: text().notNull(),
    payload: text().notNull(),
    render_spec: text().notNull(),
    ai_stats: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    index('artifacts_entry_kind').on(t.entry_id, t.kind),
    check('artifact_kind', sql`${t.kind} IN ('translation','summary')`),
  ],
);
export const featureStates = sqliteTable(
  'entry_feature_states',
  {
    entry_id: integer()
      .notNull()
      .references(() => entries.entry_id),
    kind: text().notNull(),
    state: text().notNull(),
    current_artifact_id: integer().references(() => artifacts.id),
    last_generation_task_id: integer().references(() => tasks.id),
    skip_reason: text(),
    ...times(),
  },
  (t) => [
    primaryKey({ columns: [t.entry_id, t.kind] }),
    index('feature_kind_state').on(t.kind, t.state),
    check('feature_kind', sql`${t.kind} IN ('translation','summary')`),
    check(
      'feature_state',
      sql`${t.state} IN ('scheduled','pending','processing','ready','skipped','failed')`,
    ),
    check(
      'feature_scheduled',
      sql`${t.kind} = 'summary' OR ${t.state} <> 'scheduled'`,
    ),
    check(
      'feature_skip_reason',
      sql`(${t.state} = 'skipped') = (${t.skip_reason} IS NOT NULL)`,
    ),
    check(
      'feature_ready',
      sql`${t.state} <> 'ready' OR ${t.current_artifact_id} IS NOT NULL`,
    ),
    check(
      'feature_no_artifact',
      sql`${t.state} NOT IN ('scheduled','skipped') OR ${t.current_artifact_id} IS NULL`,
    ),
    check(
      'feature_skip_domain',
      sql`${t.skip_reason} IS NULL OR (${t.kind} = 'translation' AND ${t.skip_reason} IN ('no_translatable_content','language_not_required')) OR (${t.kind} = 'summary' AND ${t.skip_reason} = 'content_too_short')`,
    ),
  ],
);
export const digestFeeds = sqliteTable(
  'digest_output_feeds',
  {
    job_id: text().notNull(),
    partition_key: text().notNull(),
    source_category_id: integer(),
    source_category_title: text(),
    destination_category_id: integer(),
    feed_title: text().notNull(),
    feed_url: text().notNull().unique(),
    feed_id: integer().unique(),
    state: text().notNull(),
    reason: text(),
    last_attempt_at: integer(),
    next_attempt_at: integer(),
    ...times(),
  },
  (t) => [
    primaryKey({ columns: [t.job_id, t.partition_key] }),
    check('digest_feed_title', sql`length(trim(${t.feed_title})) > 0`),
    check(
      'digest_feed_state',
      sql`${t.state} IN ('initializing','ready','degraded')`,
    ),
    check(
      'digest_feed_destination',
      sql`${t.destination_category_id} IS NULL OR ${t.destination_category_id} > 0`,
    ),
    check(
      'digest_feed_ready',
      sql`${t.state} <> 'ready' OR (${t.feed_id} > 0 AND ${t.feed_id} IS NOT NULL AND ${t.destination_category_id} IS NOT NULL)`,
    ),
    check(
      'digest_feed_partition',
      sql`(${t.partition_key} = 'all' AND ${t.source_category_id} IS NULL AND ${t.source_category_title} IS NULL) OR (${t.source_category_id} > 0 AND ${t.source_category_id} IS NOT NULL AND ${t.partition_key} = 'category:' || ${t.source_category_id} AND ${t.source_category_title} IS NOT NULL AND length(trim(${t.source_category_title})) > 0)`,
    ),
  ],
);
export const digestWindows = sqliteTable(
  'digest_windows',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    job_id: text().notNull(),
    digest_date: text().notNull(),
    window_start: integer().notNull(),
    window_end: integer().notNull(),
    trigger_type: text().notNull(),
    config_snapshot: text().notNull(),
    last_evaluated_at: integer(),
    created_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex('digest_window_date').on(t.job_id, t.digest_date),
    uniqueIndex('digest_window_end').on(t.job_id, t.window_end),
    check('digest_trigger', sql`${t.trigger_type} IN ('scheduled','manual')`),
    check('digest_bounds', sql`${t.window_start} < ${t.window_end}`),
  ],
);
export const digestRuns = sqliteTable(
  'digest_runs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    digest_window_id: integer()
      .notNull()
      .references(() => digestWindows.id),
    partition_key: text().notNull(),
    source_category_id: integer(),
    source_category_title: text(),
    state: text().notNull(),
    output_feed_id: integer(),
    external_id: text().notNull().unique(),
    miniflux_entry_id: integer(),
    item_count: integer(),
    dropped_count: integer().notNull(),
    ai_stats: text().notNull(),
    ...times(),
  },
  (t) => [
    uniqueIndex('digest_run_partition').on(t.digest_window_id, t.partition_key),
    index('digest_run_activation').on(t.state, t.digest_window_id),
    check(
      'digest_run_state',
      sql`${t.state} IN ('pending','running','imported','failed','tombstoned')`,
    ),
    check(
      'digest_run_feed',
      sql`${t.state} = 'pending' OR ${t.output_feed_id} IS NOT NULL`,
    ),
    check(
      'digest_run_imported',
      sql`${t.state} <> 'imported' OR (${t.miniflux_entry_id} IS NOT NULL AND ${t.item_count} IS NOT NULL AND ${t.item_count} > 0)`,
    ),
    check(
      'digest_run_count',
      sql`${t.item_count} IS NULL OR ${t.item_count} > 0`,
    ),
    check('digest_run_drops', sql`${t.dropped_count} >= 0`),
    check(
      'digest_run_partition_check',
      sql`(${t.partition_key} = 'all' AND ${t.source_category_id} IS NULL AND ${t.source_category_title} IS NULL) OR (${t.source_category_id} IS NOT NULL AND ${t.source_category_id} > 0 AND ${t.partition_key} = 'category:' || ${t.source_category_id} AND ${t.source_category_title} IS NOT NULL AND length(trim(${t.source_category_title})) > 0)`,
    ),
  ],
);
export const digestCandidates = sqliteTable(
  'digest_run_candidates',
  {
    digest_run_id: integer()
      .notNull()
      .references(() => digestRuns.id),
    entry_id: integer()
      .notNull()
      .references(() => entries.entry_id),
    selection_position: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.digest_run_id, t.entry_id] }),
    uniqueIndex('digest_candidate_position').on(
      t.digest_run_id,
      t.selection_position,
    ),
    index('digest_candidate_entry').on(t.entry_id),
    check('digest_candidate_nonnegative', sql`${t.selection_position} >= 0`),
  ],
);
export const serviceState = sqliteTable(
  'service_state',
  {
    key: text().primaryKey(),
    value: text().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [
    check(
      'service_state_key',
      sql`${t.key} IN ('miniflux_account_binding','new_entry_poll_cursor')`,
    ),
  ],
);

export type Entry = typeof entries.$inferSelect;
export type FeatureState = typeof featureStates.$inferSelect;
export type FeedRecord = typeof digestFeeds.$inferSelect;
