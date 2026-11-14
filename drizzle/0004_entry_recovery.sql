ALTER TABLE `entries` ADD `source_fingerprint` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `source_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `recovery_checked_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `recovery_outcome` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `rendered_title` text;--> statement-breakpoint
CREATE INDEX `entries_recovery_due` ON `entries` (`recovery_checked_at`,`entry_id`);