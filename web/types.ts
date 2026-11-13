import type { ModelSettings } from '../src/admin/model.js';
import type { ScopeSettings } from '../src/admin/scopes.js';
import type { dashboard, EntryListItem } from '../src/admin/queries.js';
import type { Repository } from '../src/db/repository.js';
import type { Entry, FeatureState } from '../src/db/types.js';
import type { Source } from '../src/source/index.js';

export type ModelView = ReturnType<ModelSettings['view']>;
export type ProviderView = ModelView['providers'][number];
export type ScopeView = ReturnType<ScopeSettings['view']>;
export type ScopeTarget = ScopeView['targets'][number];
export type ScopeEdit = Pick<
  ScopeTarget,
  'fallback_action' | 'allowlist' | 'blocklist'
>;
export type ScopeList = ScopeEdit['allowlist'];
export type ListName = 'allowlist' | 'blocklist';
export type ListKey = keyof ScopeList;
export type ScopeUpdate = ScopeEdit & { target: string; revision: string };
export interface ScopeDraft {
  baseline: ScopeTarget;
  value: ScopeEdit;
  conflict: boolean;
}
export interface Subscriptions {
  categories: { id: number; title: string }[];
  feeds: { id: number; title: string; category_id: number }[];
}
export interface SubscriptionChoice {
  id: number;
  key: ListKey;
  title: string;
  detail: string;
}
export interface SubscriptionGroup {
  key: string;
  title: string;
  category: SubscriptionChoice | null;
  feeds: SubscriptionChoice[];
}
export interface PickerGroup {
  group: SubscriptionGroup;
  element: HTMLElement;
  expanded: boolean;
  children: HTMLElement;
  toggle: HTMLButtonElement | null;
  category: HTMLInputElement | null;
  feeds: {
    choice: SubscriptionChoice;
    input: HTMLInputElement;
    row: HTMLLabelElement;
  }[];
}
export type Dashboard = ReturnType<typeof dashboard>;
export type SafeTask = Omit<
  ReturnType<Repository['safeTask']>,
  'updated_at'
> & { updated_at: string };
export interface EntryPage {
  entries: EntryListItem[];
  next_cursor: number | null;
}
export interface EntryDetail extends Pick<
  Entry,
  'source_title' | 'primary_language'
> {
  feature_states: FeatureState[];
  tasks: SafeTask[];
  source: Source;
  render_status: string;
}
export interface SystemStatus {
  core: {
    database: boolean;
    ready: boolean;
    version: string | null;
    reason: string | null;
  };
  miniflux_account_binding: { state: string; configured_base_url: string };
}
