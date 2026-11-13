CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`kind` text NOT NULL,
	`marker_token` text NOT NULL,
	`output_language` text NOT NULL,
	`payload` text NOT NULL,
	`render_spec` text NOT NULL,
	`ai_stats` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`entry_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "artifact_kind" CHECK("artifacts"."kind" IN ('translation','summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_marker_token_unique` ON `artifacts` (`marker_token`);--> statement-breakpoint
CREATE INDEX `artifacts_entry_kind` ON `artifacts` (`entry_id`,`kind`);--> statement-breakpoint
CREATE TABLE `digest_run_candidates` (
	`digest_run_id` integer NOT NULL,
	`entry_id` integer NOT NULL,
	`selection_position` integer NOT NULL,
	PRIMARY KEY(`digest_run_id`, `entry_id`),
	FOREIGN KEY (`digest_run_id`) REFERENCES `digest_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`entry_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "digest_candidate_nonnegative" CHECK("digest_run_candidates"."selection_position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_candidate_position` ON `digest_run_candidates` (`digest_run_id`,`selection_position`);--> statement-breakpoint
CREATE INDEX `digest_candidate_entry` ON `digest_run_candidates` (`entry_id`);--> statement-breakpoint
CREATE TABLE `digest_output_feeds` (
	`job_id` text NOT NULL,
	`partition_key` text NOT NULL,
	`source_category_id` integer,
	`source_category_title` text,
	`destination_category_id` integer,
	`feed_title` text NOT NULL,
	`feed_url` text NOT NULL,
	`feed_id` integer,
	`state` text NOT NULL,
	`reason` text,
	`last_attempt_at` integer,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `partition_key`),
	CONSTRAINT "digest_feed_title" CHECK(length(trim("digest_output_feeds"."feed_title")) > 0),
	CONSTRAINT "digest_feed_state" CHECK("digest_output_feeds"."state" IN ('initializing','ready','degraded')),
	CONSTRAINT "digest_feed_destination" CHECK("digest_output_feeds"."destination_category_id" IS NULL OR "digest_output_feeds"."destination_category_id" > 0),
	CONSTRAINT "digest_feed_ready" CHECK("digest_output_feeds"."state" <> 'ready' OR ("digest_output_feeds"."feed_id" > 0 AND "digest_output_feeds"."feed_id" IS NOT NULL AND "digest_output_feeds"."destination_category_id" IS NOT NULL)),
	CONSTRAINT "digest_feed_partition" CHECK(("digest_output_feeds"."partition_key" = 'all' AND "digest_output_feeds"."source_category_id" IS NULL AND "digest_output_feeds"."source_category_title" IS NULL) OR ("digest_output_feeds"."source_category_id" > 0 AND "digest_output_feeds"."source_category_id" IS NOT NULL AND "digest_output_feeds"."partition_key" = 'category:' || "digest_output_feeds"."source_category_id" AND "digest_output_feeds"."source_category_title" IS NOT NULL AND length(trim("digest_output_feeds"."source_category_title")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_output_feeds_feed_url_unique` ON `digest_output_feeds` (`feed_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `digest_output_feeds_feed_id_unique` ON `digest_output_feeds` (`feed_id`);--> statement-breakpoint
CREATE TABLE `digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`digest_window_id` integer NOT NULL,
	`partition_key` text NOT NULL,
	`source_category_id` integer,
	`source_category_title` text,
	`state` text NOT NULL,
	`output_feed_id` integer,
	`external_id` text NOT NULL,
	`miniflux_entry_id` integer,
	`item_count` integer,
	`dropped_count` integer NOT NULL,
	`ai_stats` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`digest_window_id`) REFERENCES `digest_windows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "digest_run_state" CHECK("digest_runs"."state" IN ('pending','running','imported','failed','tombstoned')),
	CONSTRAINT "digest_run_feed" CHECK("digest_runs"."state" = 'pending' OR "digest_runs"."output_feed_id" IS NOT NULL),
	CONSTRAINT "digest_run_imported" CHECK("digest_runs"."state" <> 'imported' OR ("digest_runs"."miniflux_entry_id" IS NOT NULL AND "digest_runs"."item_count" IS NOT NULL AND "digest_runs"."item_count" > 0)),
	CONSTRAINT "digest_run_count" CHECK("digest_runs"."item_count" IS NULL OR "digest_runs"."item_count" > 0),
	CONSTRAINT "digest_run_drops" CHECK("digest_runs"."dropped_count" >= 0),
	CONSTRAINT "digest_run_partition_check" CHECK(("digest_runs"."partition_key" = 'all' AND "digest_runs"."source_category_id" IS NULL AND "digest_runs"."source_category_title" IS NULL) OR ("digest_runs"."source_category_id" IS NOT NULL AND "digest_runs"."source_category_id" > 0 AND "digest_runs"."partition_key" = 'category:' || "digest_runs"."source_category_id" AND "digest_runs"."source_category_title" IS NOT NULL AND length(trim("digest_runs"."source_category_title")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_runs_external_id_unique` ON `digest_runs` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `digest_run_partition` ON `digest_runs` (`digest_window_id`,`partition_key`);--> statement-breakpoint
CREATE INDEX `digest_run_activation` ON `digest_runs` (`state`,`digest_window_id`);--> statement-breakpoint
CREATE TABLE `digest_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`digest_date` text NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`trigger_type` text NOT NULL,
	`config_snapshot` text NOT NULL,
	`last_evaluated_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "digest_trigger" CHECK("digest_windows"."trigger_type" IN ('scheduled','manual')),
	CONSTRAINT "digest_bounds" CHECK("digest_windows"."window_start" < "digest_windows"."window_end")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_window_date` ON `digest_windows` (`job_id`,`digest_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `digest_window_end` ON `digest_windows` (`job_id`,`window_end`);--> statement-breakpoint
CREATE TABLE `entries` (
	`entry_id` integer PRIMARY KEY NOT NULL,
	`feed_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`entry_url` text NOT NULL,
	`published_at` integer NOT NULL,
	`source_author` text NOT NULL,
	`source_feed_title` text NOT NULL,
	`source_feed_url` text NOT NULL,
	`source_feed_site_url` text NOT NULL,
	`source_category_title` text NOT NULL,
	`source_title` text NOT NULL,
	`source_content_units` integer NOT NULL,
	`primary_language` text,
	`language_confidence` real,
	`render_generation` integer DEFAULT 0 NOT NULL,
	`rendered_generation` integer DEFAULT 0 NOT NULL,
	`rendered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "entry_ids" CHECK("entries"."entry_id" > 0 AND "entries"."entry_id" <= 9007199254740991 AND "entries"."feed_id" > 0 AND "entries"."category_id" > 0),
	CONSTRAINT "entry_source_units" CHECK("entries"."source_content_units" >= 0),
	CONSTRAINT "entry_metadata" CHECK(length(trim("entries"."source_feed_title")) > 0 AND length(trim("entries"."source_feed_url")) > 0 AND length(trim("entries"."source_category_title")) > 0),
	CONSTRAINT "entry_language" CHECK(("entries"."primary_language" IS NULL) = ("entries"."language_confidence" IS NULL) AND ("entries"."language_confidence" IS NULL OR "entries"."language_confidence" BETWEEN 0 AND 1)),
	CONSTRAINT "entry_generations" CHECK(0 <= "entries"."rendered_generation" AND "entries"."rendered_generation" <= "entries"."render_generation")
);
--> statement-breakpoint
CREATE INDEX `entries_published_at` ON `entries` (`published_at`);--> statement-breakpoint
CREATE INDEX `entries_feed_id` ON `entries` (`feed_id`);--> statement-breakpoint
CREATE INDEX `entries_render_pending` ON `entries` (`entry_id`) WHERE "entries"."render_generation" > "entries"."rendered_generation";--> statement-breakpoint
CREATE TABLE `entry_feature_states` (
	`entry_id` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`current_artifact_id` integer,
	`last_generation_task_id` integer,
	`skip_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `kind`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`entry_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_generation_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feature_kind" CHECK("entry_feature_states"."kind" IN ('translation','summary')),
	CONSTRAINT "feature_state" CHECK("entry_feature_states"."state" IN ('scheduled','pending','processing','ready','skipped','failed')),
	CONSTRAINT "feature_scheduled" CHECK("entry_feature_states"."kind" = 'summary' OR "entry_feature_states"."state" <> 'scheduled'),
	CONSTRAINT "feature_skip_reason" CHECK(("entry_feature_states"."state" = 'skipped') = ("entry_feature_states"."skip_reason" IS NOT NULL)),
	CONSTRAINT "feature_ready" CHECK("entry_feature_states"."state" <> 'ready' OR "entry_feature_states"."current_artifact_id" IS NOT NULL),
	CONSTRAINT "feature_no_artifact" CHECK("entry_feature_states"."state" NOT IN ('scheduled','skipped') OR "entry_feature_states"."current_artifact_id" IS NULL),
	CONSTRAINT "feature_skip_domain" CHECK("entry_feature_states"."skip_reason" IS NULL OR ("entry_feature_states"."kind" = 'translation' AND "entry_feature_states"."skip_reason" IN ('no_translatable_content','language_not_required')) OR ("entry_feature_states"."kind" = 'summary' AND "entry_feature_states"."skip_reason" = 'content_too_short'))
);
--> statement-breakpoint
CREATE INDEX `feature_kind_state` ON `entry_feature_states` (`kind`,`state`);--> statement-breakpoint
CREATE TABLE `service_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "service_state_key" CHECK("service_state"."key" IN ('miniflux_account_binding','new_entry_poll_cursor'))
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`dedup_key` text NOT NULL,
	`entry_id` integer,
	`payload` text NOT NULL,
	`progress` text,
	`state` text NOT NULL,
	`priority` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`entry_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_type" CHECK("tasks"."type" IN ('generate_artifacts','render','digest','ingest_backfill')),
	CONSTRAINT "task_state" CHECK("tasks"."state" IN ('pending','leased','done','dead')),
	CONSTRAINT "task_entry" CHECK(("tasks"."type" IN ('generate_artifacts','render')) = ("tasks"."entry_id" IS NOT NULL)),
	CONSTRAINT "task_priority" CHECK(("tasks"."type" IN ('generate_artifacts','render') AND "tasks"."priority" = 100) OR ("tasks"."type" IN ('digest','ingest_backfill') AND "tasks"."priority" = 0)),
	CONSTRAINT "task_progress" CHECK(("tasks"."type" = 'ingest_backfill') = ("tasks"."progress" IS NOT NULL)),
	CONSTRAINT "task_lease" CHECK(("tasks"."state" = 'leased' AND "tasks"."lease_owner" IS NOT NULL AND "tasks"."lease_expires_at" IS NOT NULL) OR ("tasks"."state" <> 'leased' AND "tasks"."lease_owner" IS NULL AND "tasks"."lease_expires_at" IS NULL)),
	CONSTRAINT "task_attempts" CHECK("tasks"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_active_dedup` ON `tasks` (`dedup_key`) WHERE "tasks"."state" IN ('pending','leased');--> statement-breakpoint
CREATE INDEX `tasks_pending_claim_order` ON `tasks` ("priority" DESC,`created_at`,`id`) WHERE "tasks"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `tasks_pending_due` ON `tasks` (`run_after`) WHERE "tasks"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `tasks_leased_priority` ON `tasks` (`priority`) WHERE "tasks"."state" = 'leased';--> statement-breakpoint
CREATE INDEX `tasks_leased_expiry` ON `tasks` (`lease_expires_at`) WHERE "tasks"."state" = 'leased';