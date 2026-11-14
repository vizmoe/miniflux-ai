import { esc } from './html.js';
import {
  catalogChoices,
  type ListName,
  type Selection,
} from './scope-catalog.js';
import { openPicker } from './scope-picker.js';
import { selectedGroupsHtml } from './scope-selection.js';
import type { Scopes, Subscriptions } from './types.js';

type Target = Scopes['targets'][number];
type Policy = Pick<Target, 'allowlist' | 'blocklist' | 'fallback_action'>;
type Draft = { baseline: Target; value: Policy; conflict: boolean };
type Save = (
  data: Policy & { revision: string; target: string },
) => Promise<Scopes>;
const listNames: ListName[] = ['blocklist', 'allowlist'];
function policy(target: Policy): Policy {
  const sorted = (list: Selection): Selection => ({
    feed_ids: list.feed_ids.toSorted((a, b) => a - b),
    category_ids: list.category_ids.toSorted((a, b) => a - b),
  });
  return {
    fallback_action: target.fallback_action,
    allowlist: sorted(target.allowlist),
    blocklist: sorted(target.blocklist),
  };
}
const samePolicy = (a: Policy, b: Policy) =>
  JSON.stringify(policy(a)) === JSON.stringify(policy(b));
const changed = (draft: Draft) => !samePolicy(draft.value, draft.baseline);
const matches = (list: Selection, feed: Subscriptions['feeds'][number]) =>
  list.feed_ids.includes(feed.id) ||
  list.category_ids.includes(feed.category_id);
function describePolicy(value: Policy): string {
  const count = (list: Selection) =>
    `${list.feed_ids.length} feeds, ${list.category_ids.length} categories`;
  return `${value.fallback_action === 'allow' ? 'All feeds' : 'Selected feeds'} · Blocklist: ${count(value.blocklist)} · Allowlist: ${count(value.allowlist)}`;
}

export class ScopeEditor {
  private target = 'translation';
  private readonly drafts = new Map<string, Draft>();
  private readonly expanded = new Map<string, Set<string>>();
  private saving = false;
  private error = '';
  private root?: HTMLElement;
  constructor(
    private settings: Scopes,
    private subscriptions: Subscriptions | null,
    private readonly save: Save,
    private readonly saved: () => void,
    private readonly failed: (error: unknown) => void,
  ) {
    this.refresh(settings, subscriptions);
  }
  hasUnsaved(): boolean {
    return this.saving || [...this.drafts.values()].some(changed);
  }
  refresh(settings: Scopes, subscriptions: Subscriptions | null): void {
    for (const baseline of settings.targets) {
      const previous = this.drafts.get(baseline.id);
      if (
        previous &&
        changed(previous) &&
        !samePolicy(previous.value, baseline)
      ) {
        const changedElsewhere =
          !samePolicy(previous.baseline, baseline) ||
          JSON.stringify(previous.baseline.other_rules) !==
            JSON.stringify(baseline.other_rules);
        this.drafts.set(baseline.id, {
          ...previous,
          baseline,
          conflict: previous.conflict || changedElsewhere,
        });
      } else
        this.drafts.set(baseline.id, {
          baseline,
          value: policy(baseline),
          conflict: false,
        });
    }
    // Keep a dirty draft if its Digest job disappeared; it cannot be saved.
    for (const [id, draft] of this.drafts) {
      if (settings.targets.some((t) => t.id === id)) continue;
      if (changed(draft))
        draft.baseline = { ...draft.baseline, available: false };
      else this.drafts.delete(id);
    }
    if (!this.drafts.has(this.target)) this.target = 'translation';
    this.settings = settings;
    this.subscriptions = subscriptions;
    this.error = '';
  }
  private draft(): Draft {
    return this.drafts.get(this.target)!;
  }
  private expandedGroups(): Set<string> {
    let groups = this.expanded.get(this.target);
    if (!groups) {
      groups = new Set();
      this.expanded.set(this.target, groups);
    }
    return groups;
  }
  private listCard(list: ListName): string {
    const selection = this.draft().value[list];
    const count = selection.feed_ids.length + selection.category_ids.length;
    const title = list === 'blocklist' ? 'Blocklist' : 'Allowlist';
    const subtitle =
      list === 'blocklist'
        ? 'Always skip. Takes priority.'
        : 'Include these feeds and categories.';
    const groups = selectedGroupsHtml(
      this.subscriptions,
      selection,
      list,
      this.expandedGroups(),
    );
    const empty =
      list === 'blocklist'
        ? 'No blocked subscriptions'
        : 'No selected subscriptions';
    const content = count
      ? `<div class="scope-selected-items">${groups}</div>`
      : `<div class="scope-empty">${empty}</div>`;
    return `<section class="panel scope-list" aria-label="${title}"><div class="scope-list-head"><div><h2>${title} <span class="scope-count">${count}</span></h2><p class="help">${subtitle}</p></div><button type="button" data-edit-list="${list}" aria-label="Edit ${list}" ${this.subscriptions ? '' : 'disabled'}>Edit</button></div>${content}</section>`;
  }
  private modePicker(): string {
    const current = this.draft();
    const additional = current.baseline.other_rules.length > 0;
    const options = [
      {
        value: 'allow',
        title: 'All feeds',
        detail: additional
          ? 'Process unmatched feeds after YAML rules.'
          : 'Process feeds unless blocked.',
      },
      {
        value: 'deny',
        title: 'Selected feeds',
        detail: additional
          ? 'Skip unmatched feeds after YAML rules.'
          : 'Process only the allowlist.',
      },
    ];
    const rows = options
      .map(
        (o) =>
          `<label class="scope-mode-option"><input type="radio" name="fallback_action" value="${o.value}" ${current.value.fallback_action === o.value ? 'checked' : ''}><span><strong>${o.title}</strong><small>${o.detail}</small></span></label>`,
      )
      .join('');
    return `<fieldset class="scope-mode"><legend>Processing range</legend><div>${rows}</div></fieldset>`;
  }
  private preview(): string {
    if (!this.subscriptions)
      return '<p class="error-panel" role="alert">Subscriptions unavailable. Refresh to retry. Your selections are kept.</p>';
    const { value, baseline } = this.draft();
    let included = 0,
      excluded = 0,
      custom = 0,
      overlap = 0;
    const rows = this.subscriptions.feeds
      .map((feed) => {
        const blocked = matches(value.blocklist, feed),
          allowed = matches(value.allowlist, feed);
        let decision: string, reason: string;
        if (blocked) {
          decision = 'Excluded';
          reason = 'Blocklist';
          excluded++;
          if (allowed) overlap++;
        } else if (allowed) {
          decision = 'Included';
          reason = 'Allowlist';
          included++;
        } else if (baseline.other_rules.length) {
          decision = 'Depends on entry';
          reason = 'YAML rules';
          custom++;
        } else if (value.fallback_action === 'allow') {
          decision = 'Included';
          reason = 'All feeds';
          included++;
        } else {
          decision = 'Excluded';
          reason = 'Outside allowlist';
          excluded++;
        }
        return `<li><span>${esc(feed.title)}</span><span class="small">${decision} · ${reason}</span></li>`;
      })
      .join('');
    const extra = custom ? `<span>${custom} depend on entry rules</span>` : '';
    const overlapped = overlap === 1 ? 'feed is' : 'feeds are';
    const warning = overlap
      ? `<p class="help scope-overlap">${overlap} allowlisted ${overlapped} blocked. Blocklist takes priority.</p>`
      : '';
    const empty =
      !included &&
      !custom &&
      value.fallback_action === 'deny' &&
      !value.allowlist.feed_ids.length &&
      !value.allowlist.category_ids.length
        ? '<p class="help scope-overlap">Nothing is included. Add feeds or categories to the allowlist.</p>'
        : '';
    return `<section class="scope-preview" aria-label="Scope preview"><div class="scope-totals" aria-live="polite"><span><strong>${included}</strong> included</span><span><strong>${excluded}</strong> excluded</span>${extra}<span class="small">of ${this.subscriptions.feeds.length} current feeds</span></div>${warning}${empty}<details><summary>Preview feeds</summary><ul>${rows || '<li>No feeds found.</li>'}</ul><p class="help">Current subscriptions only. Existing entries keep their captured category; content and language checks still apply.</p></details></section>`;
  }
  private additionalRules(): string {
    const rules = this.draft().baseline.other_rules;
    if (!rules.length) return '';
    return `<details class="panel scope-rules"><summary>Additional YAML rules · ${rules.length}</summary><p class="help">These ordered rules run after the lists, before the default. They can include or exclude other entries.</p><pre>${esc(JSON.stringify(rules, null, 2))}</pre></details>`;
  }
  private conflictNotice(): string {
    const draft = this.draft();
    if (!draft.conflict) return '';
    const savedLists = listNames
      .map((list) => {
        const selected = draft.baseline[list];
        const names = catalogChoices(this.subscriptions, selected)
          .filter((c) => selected[c.key].includes(c.id))
          .map((c) => c.title);
        return `<p class="help">Saved ${list}: ${esc(names.join(', ') || 'Empty')}</p>`;
      })
      .join('');
    return `<section class="scope-conflict error-panel" role="alert"><strong>Saved rules changed while you were editing.</strong><p class="help">Saved: ${esc(describePolicy(draft.baseline))}</p>${savedLists}<p class="help">Your draft: ${esc(describePolicy(draft.value))}</p><div class="actions"><button type="button" data-reset>Use saved rules</button><button type="button" data-keep>Keep my changes</button></div></section>`;
  }
  private formHtml(): string {
    const current = this.draft(),
      dirty = changed(current);
    const targets = [...this.drafts]
      .map(([id, draft]) => {
        const marker = changed(draft)
          ? ' <span aria-label="unsaved">•</span>'
          : '';
        return `<button type="button" data-target="${esc(id)}" aria-pressed="${id === this.target}">${esc(draft.baseline.name)}${marker}</button>`;
      })
      .join('');
    const disabled = current.baseline.enabled
      ? ''
      : '<span class="badge muted">Feature disabled</span>';
    const unavailable = current.baseline.available
      ? ''
      : '<p class="error-panel" role="alert">This job is not active in the running configuration.</p>';
    let state = current.baseline.applied
      ? 'All changes saved'
      : 'Saved rules are not active';
    if (dirty) state = 'Unsaved changes';
    const saveLabel = this.saving ? 'Saving…' : 'Save changes';
    const saveDisabled =
      this.saving ||
      current.conflict ||
      !current.baseline.available ||
      (!dirty && current.baseline.applied);
    const errorPanel = this.error
      ? `<p class="error-panel" role="alert">${esc(this.error)}</p>`
      : '';
    return `<form id="scope-form"><fieldset class="scope-controls" ${this.saving ? 'disabled' : ''}><div class="scope-targets" role="group" aria-label="Feature">${targets}${disabled}</div>${unavailable}${this.modePicker()}<div class="scope-grid">${this.listCard('blocklist')}${this.listCard('allowlist')}</div>${this.preview()}${this.additionalRules()}${this.conflictNotice()}${errorPanel}<div class="scope-savebar"><div><strong data-save-status tabindex="-1">${state}</strong><small>Applies immediately to new work. Existing tasks continue.</small></div><div class="actions"><button type="button" data-reset ${dirty ? '' : 'disabled'}>Reset changes</button><button type="submit" class="primary" ${saveDisabled ? 'disabled' : ''}>${saveLabel}</button></div></div></fieldset></form>`;
  }
  private redraw(focus?: string): void {
    if (!this.root?.isConnected) return;
    this.mount(this.root);
    if (focus) this.root.querySelector<HTMLElement>(focus)?.focus();
  }
  private reset(): void {
    const draft = this.draft();
    draft.value = policy(draft.baseline);
    draft.conflict = false;
    this.error = '';
    this.redraw('[data-save-status]');
  }
  private editList(list: ListName): void {
    if (!this.subscriptions || !this.root) return;
    const opener = `[data-edit-list="${list}"]`;
    openPicker(
      this.root,
      list,
      this.draft().value[list],
      this.subscriptions,
      (value) => {
        this.draft().value[list] = value;
        this.redraw(opener);
      },
    );
  }
  private async submit(): Promise<void> {
    const current = this.draft();
    if (this.saving || current.conflict || !current.baseline.available) return;
    this.saving = true;
    this.error = '';
    this.redraw();
    try {
      const settings = await this.save({
        revision: this.settings.revision,
        target: this.target,
        ...policy(current.value),
      });
      current.value = policy(
        settings.targets.find((t) => t.id === this.target)!,
      );
      this.refresh(settings, this.subscriptions);
      if (this.root?.isConnected) this.saved();
    } catch (error) {
      const conflict =
        error instanceof Error &&
        'code' in error &&
        error.code === 'configuration_conflict';
      this.error = conflict
        ? 'Settings changed elsewhere. Refresh to compare; your edits are safe.'
        : 'Unable to save. Your edits are kept. Try again.';
      if (this.root?.isConnected) this.failed(error);
    } finally {
      this.saving = false;
      this.redraw('button[type=submit]');
    }
  }
  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = this.formHtml();
    const expanded = this.expandedGroups();
    for (const group of root.querySelectorAll<HTMLDetailsElement>(
      '[data-selection-group]',
    ))
      group.addEventListener('toggle', () => {
        if (!group.isConnected) return;
        const key = group.dataset.selectionGroup!;
        if (group.open) expanded.add(key);
        else expanded.delete(key);
      });
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[data-target]',
    ))
      button.addEventListener('click', () => {
        this.target = button.dataset.target!;
        this.error = '';
        this.redraw(`[data-target="${this.target}"]`);
      });
    for (const radio of root.querySelectorAll<HTMLInputElement>(
      '[name=fallback_action]',
    ))
      radio.addEventListener('change', () => {
        this.draft().value.fallback_action =
          radio.value as Policy['fallback_action'];
        this.redraw(`[name=fallback_action][value="${radio.value}"]`);
      });
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[data-edit-list]',
    ))
      button.addEventListener('click', () =>
        this.editList(button.dataset.editList as ListName),
      );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[data-remove-list]',
    ))
      button.addEventListener('click', () => {
        const list = button.dataset.removeList as ListName,
          key = button.dataset.key as keyof Selection;
        this.draft().value[list][key] = this.draft().value[list][key].filter(
          (id) => id !== Number(button.dataset.id),
        );
        this.redraw(`[data-edit-list="${list}"]`);
      });
    for (const button of root.querySelectorAll('[data-reset]'))
      button.addEventListener('click', () => this.reset());
    root.querySelector('[data-keep]')?.addEventListener('click', () => {
      this.draft().conflict = false;
      this.redraw('button[type=submit]');
    });
    root.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }
}
