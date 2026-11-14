import type { dashboard, listEntries } from '../src/admin/queries.js';
import type { ModelSettings } from '../src/admin/model.js';
import type { ScopeSettings } from '../src/admin/scopes.js';
export type Scopes = ReturnType<ScopeSettings['view']>;
export interface Subscriptions {
  feeds: Array<{ id: number; title: string; category_id: number }>;
  categories: Array<{ id: number; title: string }>;
}
export type Dashboard = ReturnType<typeof dashboard>;
export type Model = ReturnType<ModelSettings['view']>;
export type EntryList = Omit<ReturnType<typeof listEntries>, 'entries'> & {
  entries: Entry[];
};
export interface Entry {
  entry_id: number;
  source_title: string;
  source_feed_title: string;
  feed_id: number;
  primary_language: string | null;
  created_at: string;
  entry_url: string;
  translation_state: string | null;
  summary_state: string | null;
  render_status: string;
  translation_skip_reason: string | null;
  summary_skip_reason: string | null;
}
export interface Task {
  id: number;
  entry_id: number | null;
  type: string;
  state: string;
  attempts: number;
  updated_at: string;
  created_at: string;
  run_after: string;
  last_error: {
    code: string;
    integrity_stage: string | null;
    http_status: number | null;
  } | null;
  requeueable: boolean;
  requeue_reason: { code: string } | null;
}
export interface Status {
  core: {
    database: boolean;
    ready: boolean;
    reason?: string;
    version?: string;
  };
  miniflux_account_binding: { state: string; configured_base_url: string };
  ingestion: unknown;
  digest: unknown;
}
