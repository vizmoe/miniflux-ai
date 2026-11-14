-- Custom SQL migration file, put your code below! --
CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'artifact_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_window_identity_immutable BEFORE UPDATE OF job_id,digest_date,window_start,window_end,trigger_type,config_snapshot ON digest_windows
BEGIN SELECT RAISE(ABORT, 'digest_window_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_candidate_immutable BEFORE UPDATE ON digest_run_candidates
BEGIN SELECT RAISE(ABORT, 'digest_candidate_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_candidate_no_delete BEFORE DELETE ON digest_run_candidates
BEGIN SELECT RAISE(ABORT, 'digest_candidate_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER digest_run_identity_immutable BEFORE UPDATE OF digest_window_id,partition_key,source_category_id,source_category_title,external_id,dropped_count ON digest_runs
BEGIN SELECT RAISE(ABORT, 'digest_run_identity_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER feed_registry_identity_immutable BEFORE UPDATE OF job_id,partition_key,source_category_id,feed_title,feed_url ON digest_output_feeds
BEGIN SELECT RAISE(ABORT, 'feed_registry_identity_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER feature_artifact_pointer_insert BEFORE INSERT ON entry_feature_states
WHEN NEW.current_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.current_artifact_id AND entry_id=NEW.entry_id AND kind=NEW.kind)
BEGIN SELECT RAISE(ABORT, 'invalid_artifact_pointer'); END;
--> statement-breakpoint
CREATE TRIGGER feature_artifact_pointer_update BEFORE UPDATE OF current_artifact_id,entry_id,kind ON entry_feature_states
WHEN NEW.current_artifact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifacts WHERE id=NEW.current_artifact_id AND entry_id=NEW.entry_id AND kind=NEW.kind)
BEGIN SELECT RAISE(ABORT, 'invalid_artifact_pointer'); END;
