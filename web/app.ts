import type {
  ModelView,
  ProviderView,
  ScopeView,
  ScopeEdit,
  ScopeList,
  ListName,
  ListKey,
  ScopeUpdate,
  ScopeDraft,
  Subscriptions,
  SubscriptionChoice,
  SubscriptionGroup,
  PickerGroup,
  Dashboard,
  SafeTask,
  EntryPage,
  EntryDetail,
  SystemStatus,
} from './types.js';
const escapeHtml = (e: unknown) =>
  String(e ?? '').replace(
    /[&<>"']/g,
    (t) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        t as '&' | '<' | '>' | '"' | "'"
      ],
  );
function subscriptionGroups(
  e: Subscriptions | null,
  t: ScopeList,
): SubscriptionGroup[] {
  const i = new Map<number, SubscriptionGroup>();
  const n = (s: number) => {
    let l = i.get(s);
    if (!l) {
      const g = e?.categories.find((m) => m.id === s)?.title;
      const v: SubscriptionChoice = {
        id: s,
        key: 'category_ids',
        title: g ?? `Category #${s}`,
        detail: g === void 0 ? 'Unavailable' : 'Category',
      };
      l = { key: `category-${s}`, title: v.title, category: v, feeds: [] };
      i.set(s, l);
    }
    return l;
  };
  for (const s of e?.categories ?? []) {
    n(s.id);
  }
  for (const s of e?.feeds ?? []) {
    n(s.category_id).feeds.push({
      id: s.id,
      key: 'feed_ids',
      title: s.title,
      detail: `Feed #${s.id}`,
    });
  }
  for (const s of t.category_ids) {
    n(s);
  }
  const a = [...i.values()];
  for (const s of a) {
    if (s.category!.detail !== 'Unavailable') {
      s.category!.detail = `Category \xB7 ${s.feeds.length} ${s.feeds.length === 1 ? 'feed' : 'feeds'}`;
    }
  }
  const r = t.feed_ids
    .filter((s) => !e?.feeds.some((l) => l.id === s))
    .map((s): SubscriptionChoice => ({
      id: s,
      key: 'feed_ids',
      title: `Feed #${s}`,
      detail: 'Unavailable',
    }));
  if (r.length) {
    a.push({
      key: 'unavailable',
      title: 'Unavailable feeds',
      category: null,
      feeds: r,
    });
  }
  return a;
}
function subscriptionChoices(e: Subscriptions | null, t: ScopeList) {
  return subscriptionGroups(e, t).flatMap((i) =>
    i.category ? [i.category, ...i.feeds] : i.feeds,
  );
}
function choiceHtml(e: SubscriptionChoice) {
  const t = e.key === 'feed_ids' ? 'feed' : 'category';
  const i = `${e.title} (${t} ${e.id})`;
  return `<label class="scope-choice"><input type="checkbox" name="${e.key}" value="${e.id}" aria-label="${escapeHtml(i)}"><span><strong>${escapeHtml(e.title)}</strong><small>${escapeHtml(e.detail)}</small></span></label>`;
}
function groupHtml(e: SubscriptionGroup) {
  const t = `picker-${e.key}`;
  const i = e.feeds.length
    ? `<button type="button" class="scope-disclosure" aria-label="Expand ${escapeHtml(e.title)}" aria-expanded="false" aria-controls="${t}"><span aria-hidden="true">\u203A</span></button>`
    : '<span class="scope-disclosure-spacer"></span>';
  const n = e.category
    ? choiceHtml(e.category)
    : `<strong>${escapeHtml(e.title)}</strong>`;
  const a = e.feeds.map(choiceHtml).join('');
  return `<section class="picker-group" data-group="${e.key}" aria-label="${escapeHtml(e.title)}"><div class="picker-group-head">${i}${n}</div><div id="${t}" class="scope-children" hidden>${a}</div></section>`;
}
function toggleGroup(e: PickerGroup, t: boolean) {
  e.children.hidden = !t;
  e.toggle?.setAttribute('aria-expanded', String(t));
  e.toggle?.setAttribute(
    'aria-label',
    `${t ? 'Collapse' : 'Expand'} ${e.group.title}`,
  );
}
function syncGroupSelection(e: PickerGroup, t: ScopeList) {
  const i =
    e.group.category !== null && t.category_ids.includes(e.group.category.id);
  const n = e.feeds.filter((a) => t.feed_ids.includes(a.choice.id)).length;
  if (e.category) {
    e.category.checked = i;
    e.category.indeterminate = !i && n > 0;
    let a = e.group.category!.detail;
    if (i) {
      a = 'All current and future feeds';
    } else {
      if (n) {
        a = `${n} of ${e.feeds.length} feeds selected`;
      }
    }
    e.category
      .closest<HTMLLabelElement>('label')!
      .querySelector<HTMLElement>('small')!.textContent = a;
  }
  for (const { choice: a, input: r, row: s } of e.feeds) {
    const l = t.feed_ids.includes(a.id);
    r.checked = i || l;
    r.disabled = i;
    let g = a.detail;
    if (i) {
      g = l ? 'Also selected individually' : 'Via category';
    }
    s.querySelector<HTMLElement>('small')!.textContent = g;
  }
}
function filterGroup(e: PickerGroup, t: string) {
  const i = e.group.category;
  const n = `${e.group.title} ${i?.id ?? ''}`.toLowerCase().includes(t);
  let a = 0;
  for (const { choice: r, row: s } of e.feeds) {
    s.hidden = !n && !`${r.title} ${r.id}`.toLowerCase().includes(t);
    if (!s.hidden) {
      a++;
    }
  }
  e.element.hidden = !n && a === 0;
  toggleGroup(e, !!t || e.expanded);
  return !e.element.hidden;
}
function openSubscriptionPicker(
  e: HTMLElement,
  t: ListName,
  i: ScopeList,
  n: Subscriptions,
  a: (selection: ScopeList) => void,
) {
  const r = subscriptionGroups(n, i);
  const s = structuredClone(i);
  const l = document.createElement('dialog');
  l.className = 'scope-picker';
  l.setAttribute('aria-labelledby', 'picker-title');
  const g = r.map(groupHtml).join('');
  l.innerHTML = `<div class="dialog-head"><h2 id="picker-title">Edit ${t}</h2><button type="button" data-picker-close aria-label="Close selection">\xD7</button></div><div class="picker-controls"><input type="search" aria-label="Search subscriptions" placeholder="Search feeds, categories or IDs" autofocus><div class="picker-tree-tools"><p class="help">Categories include current and future feeds.</p><div class="actions"><button type="button" data-expand-all>Expand all</button><button type="button" data-collapse-all>Collapse all</button></div></div></div><div class="picker-results">${g}<p class="scope-empty" hidden>No matching subscriptions.</p></div><div class="picker-footer"><output aria-live="polite"></output><div class="actions"><button type="button" data-picker-close>Cancel</button><button type="button" class="primary" data-picker-apply>Use selection</button></div></div>`;
  const v: PickerGroup[] = r.map((d) => {
    const c = l.querySelector<HTMLElement>(`[data-group="${d.key}"]`)!;
    return {
      group: d,
      element: c,
      expanded: !1,
      children: c.querySelector<HTMLElement>('.scope-children')!,
      toggle: c.querySelector<HTMLButtonElement>('.scope-disclosure')!,
      category: c.querySelector<HTMLInputElement>('[name=category_ids]')!,
      feeds: d.feeds.map((u) => {
        const x = c.querySelector<HTMLInputElement>(
          `[name=feed_ids][value="${u.id}"]`,
        )!;
        return {
          choice: u,
          input: x,
          row: x.closest<HTMLLabelElement>('label')!,
        };
      }),
    };
  });
  let m = '';
  const h = () => {
    for (const d of v) {
      syncGroupSelection(d, s);
    }
    l.querySelector<HTMLElement>('output')!.textContent =
      `${s.feed_ids.length + s.category_ids.length} selected`;
  };
  const p = (d: PickerGroup, c: boolean) => {
    if (!m) {
      d.expanded = c;
    }
    toggleGroup(d, c);
  };
  for (const d of v) {
    d.toggle?.addEventListener('click', () =>
      p(d, d.children.hasAttribute('hidden')),
    );
  }
  for (const [d, c] of [
    ['[data-expand-all]', !0],
    ['[data-collapse-all]', !1],
  ] as const) {
    l.querySelector<HTMLElement>(d)!.addEventListener('click', () => {
      for (const u of v) {
        if (!u.element.hidden) {
          p(u, c);
        }
      }
    });
  }
  l.querySelector<HTMLInputElement>('input[type=search]')!.addEventListener(
    'input',
    (d) => {
      m = (d.target as HTMLInputElement).value.trim().toLowerCase();
      const c = v.map((u) => filterGroup(u, m)).some(Boolean);
      l.querySelector<HTMLElement>('.scope-empty')!.hidden = c;
    },
  );
  l.addEventListener('change', (d) => {
    const c = d.target as HTMLInputElement;
    if (c.type !== 'checkbox' || c.disabled) return;
    const u = c.name as ListKey;
    const x = Number(c.value);
    s[u] = s[u].filter((pe) => pe !== x);
    if (c.checked) {
      s[u].push(x);
    }
    h();
  });
  for (const d of l.querySelectorAll<HTMLButtonElement>(
    '[data-picker-close]',
  )) {
    d.addEventListener('click', () => l.close());
  }
  l.querySelector<HTMLButtonElement>('[data-picker-apply]')!.addEventListener(
    'click',
    () => {
      l.close();
      a(s);
    },
  );
  l.addEventListener(
    'close',
    () => {
      l.remove();
      e.querySelector<HTMLElement>(`[data-edit-list="${t}"]`)?.focus();
    },
    { once: !0 },
  );
  l.addEventListener('keydown', (d) => {
    if (d.key === 'Escape') {
      d.preventDefault();
      l.close();
    }
  });
  h();
  l.querySelector<HTMLElement>('.scope-empty')!.hidden = r.length > 0;
  e.append(l);
  l.showModal();
}
function selectedChoiceHtml(e: SubscriptionChoice, t: ListName, i: boolean) {
  const n = `Remove ${e.title} from ${t}`;
  const a = i
    ? `<button type="button" data-remove-list="${t}" data-key="${e.key}" data-id="${e.id}" aria-label="${escapeHtml(n)}">\xD7</button>`
    : '';
  const r = e.key === 'category_ids' ? 'Whole category' : e.title;
  return `<li class="scope-selected"><span><strong>${escapeHtml(r)}</strong><small>${escapeHtml(e.detail)}</small></span>${a}</li>`;
}
function selectedGroupsHtml(
  e: Subscriptions | null,
  t: ScopeList,
  i: ListName,
  n: Set<string>,
) {
  return subscriptionGroups(e, t)
    .map((a) => {
      const r = a.category !== null && t.category_ids.includes(a.category.id);
      const s = a.feeds.filter((h) => r || t.feed_ids.includes(h.id));
      if (!r && !s.length) return '';
      const l = r
        ? selectedChoiceHtml(
            { ...a.category!, detail: 'Current and future feeds' },
            i,
            !0,
          )
        : '';
      const g = s
        .map((h) => {
          const p = t.feed_ids.includes(h.id);
          let d = h.detail;
          if (r) {
            d = p ? 'Also selected individually' : 'Via category';
          }
          return selectedChoiceHtml({ ...h, detail: d }, i, p);
        })
        .join('');
      const v = r ? 'Whole category' : `${s.length} selected`;
      const m = `${i}:${a.key}`;
      return `<details class="scope-selected-group" data-selection-group="${m}" ${n.has(m) ? 'open' : ''}><summary><span><strong>${escapeHtml(a.title)}</strong><small>${v}</small></span></summary><ul>${l}${g}</ul></details>`;
    })
    .join('');
}
const listNames = ['blocklist', 'allowlist'] as const;
function canonicalScope(e: ScopeEdit): ScopeEdit {
  const t = (i: ScopeList) => ({
    feed_ids: i.feed_ids.toSorted((n, a) => n - a),
    category_ids: i.category_ids.toSorted((n, a) => n - a),
  });
  return {
    fallback_action: e.fallback_action,
    allowlist: t(e.allowlist),
    blocklist: t(e.blocklist),
  };
}
const sameScope = (e: ScopeEdit, t: ScopeEdit) =>
  JSON.stringify(canonicalScope(e)) === JSON.stringify(canonicalScope(t));
const isDirty = (e: ScopeDraft) => !sameScope(e.value, e.baseline);
const containsSubscription = (
  e: ScopeList,
  t: Subscriptions['feeds'][number],
) => e.feed_ids.includes(t.id) || e.category_ids.includes(t.category_id);
function describeScope(e: ScopeEdit) {
  const t = (i: ScopeList) =>
    `${i.feed_ids.length} feeds, ${i.category_ids.length} categories`;
  return `${e.fallback_action === 'allow' ? 'All feeds' : 'Selected feeds'} \xB7 Blocklist: ${t(e.blocklist)} \xB7 Allowlist: ${t(e.allowlist)}`;
}
class ScopeEditor {
  constructor(
    t: ScopeView,
    i: Subscriptions | null,
    n: (update: ScopeUpdate) => Promise<ScopeView>,
    a: () => void,
    r: (error: unknown) => void,
  ) {
    this.settings = t;
    this.subscriptions = i;
    this.save = n;
    this.saved = a;
    this.failed = r;
    this.refresh(t, i);
  }
  settings;
  subscriptions;
  save;
  saved;
  failed;
  target = 'translation';
  drafts = new Map<string, ScopeDraft>();
  expanded = new Map<string, Set<string>>();
  saving = !1;
  error = '';
  root?: HTMLElement;
  hasUnsaved() {
    return this.saving || [...this.drafts.values()].some(isDirty);
  }
  refresh(t: ScopeView, i: Subscriptions | null) {
    for (const n of t.targets) {
      const a = this.drafts.get(n.id);
      if (a && isDirty(a) && !sameScope(a.value, n)) {
        const r =
          !sameScope(a.baseline, n) ||
          JSON.stringify(a.baseline.other_rules) !==
            JSON.stringify(n.other_rules);
        this.drafts.set(n.id, { ...a, baseline: n, conflict: a.conflict || r });
      } else {
        this.drafts.set(n.id, {
          baseline: n,
          value: canonicalScope(n),
          conflict: !1,
        });
      }
    }
    for (const [n, a] of this.drafts) {
      if (!t.targets.some((r) => r.id === n)) {
        if (isDirty(a)) {
          a.baseline = { ...a.baseline, available: !1 };
        } else {
          this.drafts.delete(n);
        }
      }
    }
    if (!this.drafts.has(this.target)) {
      this.target = 'translation';
    }
    this.settings = t;
    this.subscriptions = i;
    this.error = '';
  }
  draft() {
    return this.drafts.get(this.target)!;
  }
  expandedGroups() {
    let t = this.expanded.get(this.target);
    if (!t) {
      t = new Set();
      this.expanded.set(this.target, t);
    }
    return t;
  }
  listCard(t: ListName) {
    const i = this.draft().value[t];
    const n = i.feed_ids.length + i.category_ids.length;
    const a = t === 'blocklist' ? 'Blocklist' : 'Allowlist';
    const r =
      t === 'blocklist'
        ? 'Always skip. Takes priority.'
        : 'Include these feeds and categories.';
    const s = selectedGroupsHtml(
      this.subscriptions,
      i,
      t,
      this.expandedGroups(),
    );
    const g = n
      ? `<div class="scope-selected-items">${s}</div>`
      : `<div class="scope-empty">${t === 'blocklist' ? 'No blocked subscriptions' : 'No selected subscriptions'}</div>`;
    return `<section class="panel scope-list" aria-label="${a}"><div class="scope-list-head"><div><h2>${a} <span class="scope-count">${n}</span></h2><p class="help">${r}</p></div><button type="button" data-edit-list="${t}" aria-label="Edit ${t}" ${this.subscriptions ? '' : 'disabled'}>Edit</button></div>${g}</section>`;
  }
  modePicker() {
    const t = this.draft();
    const i = t.baseline.other_rules.length > 0;
    return `<fieldset class="scope-mode"><legend>Processing range</legend><div>${[
      {
        value: 'allow',
        title: 'All feeds',
        detail: i
          ? 'Process unmatched feeds after YAML rules.'
          : 'Process feeds unless blocked.',
      },
      {
        value: 'deny',
        title: 'Selected feeds',
        detail: i
          ? 'Skip unmatched feeds after YAML rules.'
          : 'Process only the allowlist.',
      },
    ]
      .map(
        (r) =>
          `<label class="scope-mode-option"><input type="radio" name="fallback_action" value="${r.value}" ${t.value.fallback_action === r.value ? 'checked' : ''}><span><strong>${r.title}</strong><small>${r.detail}</small></span></label>`,
      )
      .join('')}</div></fieldset>`;
  }
  preview() {
    if (!this.subscriptions)
      return '<p class="error-panel" role="alert">Subscriptions unavailable. Refresh to retry. Your selections are kept.</p>';
    const { value: t, baseline: i } = this.draft();
    let n = 0;
    let a = 0;
    let r = 0;
    let s = 0;
    const l = this.subscriptions.feeds
      .map((p) => {
        const d = containsSubscription(t.blocklist, p);
        const c = containsSubscription(t.allowlist, p);
        let u;
        let x;
        if (d) {
          u = 'Excluded';
          x = 'Blocklist';
          a++;
          if (c) {
            s++;
          }
        } else {
          if (c) {
            u = 'Included';
            x = 'Allowlist';
            n++;
          } else {
            if (i.other_rules.length) {
              u = 'Depends on entry';
              x = 'YAML rules';
              r++;
            } else {
              if (t.fallback_action === 'allow') {
                u = 'Included';
                x = 'All feeds';
                n++;
              } else {
                u = 'Excluded';
                x = 'Outside allowlist';
                a++;
              }
            }
          }
        }
        return `<li><span>${escapeHtml(p.title)}</span><span class="small">${u} \xB7 ${x}</span></li>`;
      })
      .join('');
    const g = r ? `<span>${r} depend on entry rules</span>` : '';
    const m = s
      ? `<p class="help scope-overlap">${s} allowlisted ${s === 1 ? 'feed is' : 'feeds are'} blocked. Blocklist takes priority.</p>`
      : '';
    const h =
      !n &&
      !r &&
      t.fallback_action === 'deny' &&
      !t.allowlist.feed_ids.length &&
      !t.allowlist.category_ids.length
        ? '<p class="help scope-overlap">Nothing is included. Add feeds or categories to the allowlist.</p>'
        : '';
    return `<section class="scope-preview" aria-label="Scope preview"><div class="scope-totals" aria-live="polite"><span><strong>${n}</strong> included</span><span><strong>${a}</strong> excluded</span>${g}<span class="small">of ${this.subscriptions.feeds.length} current feeds</span></div>${m}${h}<details><summary>Preview feeds</summary><ul>${l || '<li>No feeds found.</li>'}</ul><p class="help">Current subscriptions only. Existing entries keep their captured category; content and language checks still apply.</p></details></section>`;
  }
  additionalRules() {
    const t = this.draft().baseline.other_rules;
    return t.length
      ? `<details class="panel scope-rules"><summary>Additional YAML rules \xB7 ${t.length}</summary><p class="help">These ordered rules run after the lists, before the default. They can include or exclude other entries.</p><pre>${escapeHtml(JSON.stringify(t, null, 2))}</pre></details>`
      : '';
  }
  conflictNotice() {
    const t = this.draft();
    if (!t.conflict) return '';
    const i = listNames
      .map((n) => {
        const a = t.baseline[n];
        const r = subscriptionChoices(this.subscriptions, a)
          .filter((s) => a[s.key].includes(s.id))
          .map((s) => s.title);
        return `<p class="help">Saved ${n}: ${escapeHtml(r.join(', ') || 'Empty')}</p>`;
      })
      .join('');
    return `<section class="scope-conflict error-panel" role="alert"><strong>Saved rules changed while you were editing.</strong><p class="help">Saved: ${escapeHtml(describeScope(t.baseline))}</p>${i}<p class="help">Your draft: ${escapeHtml(describeScope(t.value))}</p><div class="actions"><button type="button" data-reset>Use saved rules</button><button type="button" data-keep>Keep my changes</button></div></section>`;
  }
  formHtml() {
    const t = this.draft();
    const i = isDirty(t);
    const n = [...this.drafts]
      .map(([m, h]) => {
        const p = isDirty(h) ? ' <span aria-label="unsaved">\u2022</span>' : '';
        return `<button type="button" data-target="${escapeHtml(m)}" aria-pressed="${m === this.target}">${escapeHtml(h.baseline.name)}${p}</button>`;
      })
      .join('');
    const a = t.baseline.enabled
      ? ''
      : '<span class="badge muted">Feature disabled</span>';
    const r = t.baseline.available
      ? ''
      : '<p class="error-panel" role="alert">This job is not active in the running configuration.</p>';
    let s = t.baseline.applied
      ? 'All changes saved'
      : 'Saved rules are not active';
    if (i) {
      s = 'Unsaved changes';
    }
    const l = this.saving ? 'Saving\u2026' : 'Save changes';
    const g =
      this.saving ||
      t.conflict ||
      !t.baseline.available ||
      (!i && t.baseline.applied);
    const v = this.error
      ? `<p class="error-panel" role="alert">${escapeHtml(this.error)}</p>`
      : '';
    return `<form id="scope-form"><fieldset class="scope-controls" ${this.saving ? 'disabled' : ''}><div class="scope-targets" role="group" aria-label="Feature">${n}${a}</div>${r}${this.modePicker()}<div class="scope-grid">${this.listCard('blocklist')}${this.listCard('allowlist')}</div>${this.preview()}${this.additionalRules()}${this.conflictNotice()}${v}<div class="scope-savebar"><div><strong data-save-status tabindex="-1">${s}</strong><small>Applies immediately to new work. Existing tasks continue.</small></div><div class="actions"><button type="button" data-reset ${i ? '' : 'disabled'}>Reset changes</button><button type="submit" class="primary" ${g ? 'disabled' : ''}>${l}</button></div></div></fieldset></form>`;
  }
  redraw(t?: string) {
    if (this.root?.isConnected) {
      this.mount(this.root);
      if (t) {
        this.root.querySelector<HTMLElement>(t)?.focus();
      }
    }
  }
  reset() {
    const t = this.draft();
    t.value = canonicalScope(t.baseline);
    t.conflict = !1;
    this.error = '';
    this.redraw('[data-save-status]');
  }
  editList(t: ListName) {
    if (!this.subscriptions || !this.root) return;
    const i = `[data-edit-list="${t}"]`;
    openSubscriptionPicker(
      this.root,
      t,
      this.draft().value[t],
      this.subscriptions,
      (n) => {
        this.draft().value[t] = n;
        this.redraw(i);
      },
    );
  }
  async submit() {
    const t = this.draft();
    if (!(this.saving || t.conflict || !t.baseline.available)) {
      this.saving = !0;
      this.error = '';
      this.redraw();
      try {
        const i = await this.save({
          revision: this.settings.revision,
          target: this.target,
          ...canonicalScope(t.value),
        });
        t.value = canonicalScope(i.targets.find((n) => n.id === this.target)!);
        this.refresh(i, this.subscriptions);
        if (this.root?.isConnected) {
          this.saved();
        }
      } catch (i) {
        const n =
          i instanceof Error &&
          'code' in i &&
          i.code === 'configuration_conflict';
        this.error = n
          ? 'Settings changed elsewhere. Refresh to compare; your edits are safe.'
          : 'Unable to save. Your edits are kept. Try again.';
        if (this.root?.isConnected) {
          this.failed(i);
        }
      } finally {
        this.saving = !1;
        this.redraw('button[type=submit]');
      }
    }
  }
  mount(t: HTMLElement) {
    this.root = t;
    t.innerHTML = this.formHtml();
    const i = this.expandedGroups();
    for (const n of t.querySelectorAll<HTMLDetailsElement>(
      '[data-selection-group]',
    )) {
      n.addEventListener('toggle', () => {
        if (!n.isConnected) return;
        const a = n.dataset.selectionGroup!;
        if (n.open) {
          i.add(a);
        } else {
          i.delete(a);
        }
      });
    }
    for (const n of t.querySelectorAll<HTMLButtonElement>('[data-target]')) {
      n.addEventListener('click', () => {
        this.target = n.dataset.target!;
        this.error = '';
        this.redraw(`[data-target="${this.target}"]`);
      });
    }
    for (const n of t.querySelectorAll<HTMLInputElement>(
      '[name=fallback_action]',
    )) {
      n.addEventListener('change', () => {
        this.draft().value.fallback_action =
          n.value as ScopeEdit['fallback_action'];
        this.redraw(`[name=fallback_action][value="${n.value}"]`);
      });
    }
    for (const n of t.querySelectorAll<HTMLButtonElement>('[data-edit-list]')) {
      n.addEventListener('click', () =>
        this.editList(n.dataset.editList as ListName),
      );
    }
    for (const n of t.querySelectorAll<HTMLButtonElement>(
      '[data-remove-list]',
    )) {
      n.addEventListener('click', () => {
        const a = n.dataset.removeList as ListName;
        const r = n.dataset.key as ListKey;
        this.draft().value[a][r] = this.draft().value[a][r].filter(
          (s) => s !== Number(n.dataset.id),
        );
        this.redraw(`[data-edit-list="${a}"]`);
      });
    }
    for (const n of t.querySelectorAll<HTMLButtonElement>('[data-reset]')) {
      n.addEventListener('click', () => this.reset());
    }
    t.querySelector<HTMLButtonElement>('[data-keep]')?.addEventListener(
      'click',
      () => {
        this.draft().conflict = !1;
        this.redraw('button[type=submit]');
      },
    );
    t.querySelector<HTMLFormElement>('form')!.addEventListener(
      'submit',
      (n) => {
        n.preventDefault();
        this.submit();
      },
    );
  }
}
const appRoot = document.querySelector<HTMLElement>('#app')!;
const detailsDialog = document.querySelector<HTMLDialogElement>('#details')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const skipLink = document.querySelector<HTMLAnchorElement>('.skip')!;
const formatNumber = (e: number) => e.toLocaleString('en-US');
const formatDate = (e: string) =>
  new Date(e).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const icons: Record<string, string> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  entries: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6"/>',
  tasks: '<path d="m3 7 2 2 4-4M12 7h9M3 15l2 2 4-4M12 15h9"/>',
  model: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"/>',
  scopes:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  system: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  logout: '<path d="M10 4H4v16h6m4-13 5 5-5 5M9 12h11"/>',
};
const iconHtml = (e: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[e] ?? icons.entries}</svg>`;
const labels: Record<string, string> = {
  ready: 'Ready',
  pending: 'Pending',
  processing: 'Processing',
  scheduled: 'Scheduled',
  skipped: 'Skipped',
  failed: 'Failed',
  leased: 'Running',
  done: 'Done',
  dead: 'Failed',
  current: 'Written',
  never_requested: 'Not requested',
  generate_artifacts: 'Generate artifacts',
  render: 'Write to Miniflux',
  digest: 'Generate digest',
  ingest_backfill: 'Backfill entries',
  no_translatable_content: 'No translatable content',
  language_not_required: 'Language skipped',
  content_too_short: 'Content too short',
};
const labelFor = (e: string | null | undefined) =>
  e ? (labels[e] ?? e) : 'Disabled';
function badgeTone(e: string | null | undefined) {
  return ['ready', 'current', 'done'].includes(e ?? '')
    ? 'success'
    : ['failed', 'dead'].includes(e ?? '')
      ? 'danger'
      : ['processing', 'leased', 'pending', 'scheduled'].includes(e ?? '')
        ? 'waiting'
        : 'muted';
}
const badgeHtml = (e: string | null | undefined) =>
  `<span class="badge ${badgeTone(e)}">${escapeHtml(labelFor(e))}</span>`;
const errors: Record<string, string> = {
  unauthorized: 'Session expired. Sign in again.',
  origin_rejected: 'This address is not allowed.',
  login_rate_limited: 'Too many attempts. Try again in 15 minutes.',
  invalid_request: 'Check the fields and allowed ranges.',
  api_key_required: 'Enter an API key for the new endpoint.',
  https_required: 'Use an HTTPS endpoint.',
  configuration_conflict: 'Configuration changed. Refresh before saving.',
  invalid_configuration: 'Check the configuration fields.',
  configuration_write_unavailable:
    'Unable to save. Check configuration directory permissions.',
  configuration_unavailable: 'Unable to read the configuration file.',
  configuration_alias_conflict:
    'Shared YAML values would change other settings. Separate them before saving.',
  scope_not_found: 'This scope is unavailable. Refresh the configuration.',
  feature_disabled: 'Enable this feature in the configuration first.',
  generation_in_progress: 'This entry is still processing. Try again later.',
  model_not_configured: 'Configure a model first.',
  source_projection_invalid:
    'Source structure changed. Check the entry in Miniflux.',
  entry_not_found: 'Entry not found.',
  service_unavailable: 'Service unavailable. Try again later.',
};
const loginErrors: Record<string, string> = {
  unauthorized: 'Invalid admin token.',
  origin_rejected: 'This address is not allowed.',
  login_rate_limited: 'Too many attempts. Try again in 15 minutes.',
  invalid_request: 'Enter your admin token.',
  service_unavailable: 'Service unavailable. Try again later.',
};
const RequestError = class extends Error {
  constructor(i: number, n: string) {
    super(errors[n] ?? `Request failed: ${n}`);
    this.status = i;
    this.code = n;
  }
  status;
  code;
};
async function request<T = unknown>(
  e: string,
  t = 'GET',
  i?: unknown,
): Promise<T> {
  const n = await fetch(e, {
    method: t,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(6e4),
    ...(i === void 0
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(i),
        }),
  });
  if (!n.ok) {
    const a = await n.json().catch(() => ({ code: 'service_unavailable' }));
    throw (
      n.status === 401 && e.startsWith('/admin/') && showLogin(),
      new RequestError(n.status, a.code)
    );
  }
  return (n.status === 204 ? undefined : await n.json()) as T;
}
function notify(e: string, t = !1) {
  notice.textContent = e;
  notice.className = t ? 'notice error' : 'notice';
}
function loginError(e: unknown) {
  return (
    (e instanceof RequestError ? loginErrors[e.code] : void 0) ??
    'Unable to sign in. Try again.'
  );
}
function reportError(e: unknown) {
  if (!authenticated) {
    notify(
      e instanceof RequestError && e.status === 401
        ? 'Session expired. Sign in again.'
        : loginError(e),
      !0,
    );
    return;
  }
  notify(e instanceof Error ? e.message : 'Request failed. Try again.', !0);
}
function emptyHtml(e: string) {
  return `<div class="empty">${iconHtml('entries')}<strong>${escapeHtml(e)}</strong></div>`;
}
const navigation = [
  ['overview', 'Overview'],
  ['entries', 'Entries'],
  ['tasks', 'Tasks'],
  ['model', 'Models'],
  ['scopes', 'Processing rules'],
  ['system', 'System'],
];
let authenticated = !1;
let renderVersion = 0;
let modelSettings: ModelView | undefined;
let scopeEditor: InstanceType<typeof ScopeEditor> | undefined;
let entryCursor: number | null = null;
let taskCursor: number | null = null;
let entryFilter = { q: '', state: '', feature: 'translation', feed_id: '' };
let taskFilter = { state: '', type: '' };
const currentRoute = () => location.hash.slice(1).split('?')[0] || 'overview';
function showLogin() {
  authenticated = !1;
  scopeEditor = void 0;
  renderVersion++;
  detailsDialog.close();
  notice.textContent = '';
  document.documentElement.lang = 'en';
  document.title = 'Sign in \xB7 miniflux-ai';
  skipLink.textContent = 'Skip to content';
  skipLink.href = '#login-content';
  appRoot.innerHTML = `<main id="login-content" class="login-wrap" tabindex="-1"><section class="login-panel"><div class="wordmark"><span class="logo" aria-hidden="true">m<span>\u2197</span></span><span>miniflux<span class="light"> / ai</span></span></div><h1>Sign in</h1><form id="login-form"><label>Admin token<input name="token" type="password" required autocomplete="current-password" placeholder="Enter your token" aria-describedby="login-error" maxlength="4096" /></label><p class="form-error" role="alert" id="login-error"></p><button class="primary" type="submit">Sign in ${iconHtml('arrow')}</button></form></section></main>`;
  appRoot
    .querySelector<HTMLFormElement>('form')!
    .addEventListener('submit', (e) => {
      e.preventDefault();
      const t = e.currentTarget as HTMLFormElement;
      const i = t.querySelector<HTMLButtonElement>('button')!;
      i.disabled = !0;
      const n = new FormData(t).get('token');
      request('/auth/session', 'POST', { token: n })
        .then(() => {
          t.reset();
          authenticated = !0;
          showShell();
          return renderPage();
        })
        .catch((a) => {
          const r = document.querySelector<HTMLElement>('#login-error')!;
          if (r) {
            r.textContent = loginError(a);
          }
        })
        .finally(() => {
          i.disabled = !1;
        });
    });
}
function showShell() {
  document.documentElement.lang = 'en';
  skipLink.textContent = 'Skip to content';
  skipLink.href = '#content';
  const e = navigation
    .map(
      ([t, i]) =>
        `<a href="#${t}" data-nav="${t}">${iconHtml(t)}<span>${i}</span></a>`,
    )
    .join('');
  appRoot.innerHTML = `<aside class="sidebar"><a class="wordmark" href="#overview"><span class="logo" aria-hidden="true">m<span>\u2197</span></span><span>miniflux<span class="light"> / ai</span></span></a><div class="nav-caption">CONSOLE</div><nav aria-label="Main">${e}</nav><div class="sidebar-bottom"><button class="logout" data-action="logout">${iconHtml('logout')}Sign out</button></div></aside><div class="workspace-main"><header class="topbar"><div><span class="subtle">Console</span><span class="divider">/</span><span id="breadcrumb">Overview</span></div><span class="top-tag"><span class="dot"></span>Admin</span></header><main id="content" tabindex="-1"></main></div>`;
}
function pageHeading(e: string) {
  return `<div class="page-heading"><h1>${e}</h1><button data-action="refresh">${iconHtml('refresh')}Refresh</button></div>`;
}
function errorHtml(e: unknown) {
  const t = e instanceof Error ? e.message : 'Connection failed. Try again.';
  return `${pageHeading('Unable to load')}<div class="error-panel">${escapeHtml(t)}</div>`;
}
async function loadScopes(e: number) {
  const [t, i] = await Promise.all([
    request<ScopeView>('/admin/scopes'),
    request<Subscriptions>('/admin/subscriptions').catch(() => null),
  ]);
  if (!(e !== renderVersion || !authenticated)) {
    if (scopeEditor) {
      scopeEditor.refresh(t, i);
    } else {
      scopeEditor = new ScopeEditor(
        t,
        i,
        (n) => request<ScopeView>('/admin/scopes', 'PUT', n),
        () => notify('Rules saved and applied.'),
        reportError,
      );
    }
    return scopeEditor;
  }
}
async function renderPage() {
  if (!authenticated) return;
  const e = ++renderVersion;
  const t = currentRoute();
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach((a) => {
    const r = a.dataset.nav === t;
    a.classList.toggle('active', r);
    if (r) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.removeAttribute('aria-current');
    }
  });
  const i = navigation.find(([a]) => a === t)?.[1] ?? 'Overview';
  document.querySelector<HTMLElement>('#breadcrumb')!.textContent = i;
  document.title = `${i} \xB7 miniflux-ai`;
  const n = document.querySelector<HTMLElement>('#content')!;
  n.innerHTML = '<output class="loading">Loading\u2026</output>';
  try {
    let a;
    let r;
    if (t === 'model') {
      modelSettings = await request<ModelView>('/admin/model');
      a = modelHtml(modelSettings);
    } else if (t === 'scopes') {
      r = await loadScopes(e);
      a = `${pageHeading('Processing rules')}<div id="scope-editor"></div>`;
    } else if (t === 'entries') {
      a = await entriesHtml();
    } else if (t === 'tasks') {
      a = await tasksHtml();
    } else if (t === 'system') {
      const [s, l] = await Promise.all([
        request<SystemStatus>('/admin/status'),
        request('/admin/config'),
      ]);
      a = systemHtml(s, l);
    } else {
      const [s, l] = await Promise.all([
        request<Dashboard>('/admin/stats'),
        request<ModelView>('/admin/model'),
      ]);
      a = dashboardHtml(s, l);
    }
    if (e === renderVersion && authenticated) {
      n.innerHTML = a;
      r?.mount(n.querySelector<HTMLElement>('#scope-editor')!);
      bindForms();
    }
  } catch (a) {
    if (e === renderVersion && authenticated) {
      n.innerHTML = errorHtml(a);
    }
  }
}
function dashboardHtml(e: Dashboard, t: ModelView) {
  const i = e.features.translation;
  const n = i.ready ?? 0;
  const a = (i.pending ?? 0) + (i.processing ?? 0);
  const r: [string, number, string, string][] = [
    ['Entries', e.entries, 'From Miniflux', 'entries'],
    ['Translations', n, `${formatNumber(i.skipped ?? 0)} skipped`, 'success'],
    [
      'In progress',
      a,
      `${formatNumber(e.render_pending)} pending write-back`,
      'waiting',
    ],
    ['Failed tasks', e.tasks.dead ?? 0, 'Review in Tasks', 'danger'],
  ];
  const s = Math.max(1, ...e.activity.map((p) => p.translation));
  const g = `<svg class="chart" viewBox="0 0 760 200" role="img" aria-label="Daily translations over 14 days (UTC)"><path class="grid" d="M20 20H740M20 80H740M20 140H740"/>${e.activity
    .map((p, d) => {
      const c = (p.translation / s) * 120;
      return `<g><title>${p.date} \xB7 Translations: ${formatNumber(p.translation)}</title><rect class="bar-track" x="${d * 51 + 26}" y="20" width="24" height="120" rx="4"/><rect class="bar" x="${d * 51 + 26}" y="${140 - c}" width="24" height="${c}" rx="4"/><text x="${d * 51 + 38}" y="164" text-anchor="middle">${p.date.slice(5).replace('-', '/')}</text><text class="bar-value" x="${d * 51 + 38}" y="${132 - c}" text-anchor="middle">${p.translation || ''}</text></g>`;
    })
    .join('')}</svg>`;
  const v = r
    .map(
      ([p, d, c, u]) =>
        `<a class="stat-card" href="#${u === 'danger' ? 'tasks' : 'entries'}"><div class="stat-top">${p}<span class="stat-icon ${u}">${iconHtml(u === 'danger' ? 'tasks' : 'entries')}</span></div><div class="stat-number">${formatNumber(d)}</div><span class="small">${c}</span></a>`,
    )
    .join('');
  const m = e.feeds
    .map((p) => {
      const d = p.translation_failed
        ? `<span class="badge danger">${p.translation_failed}</span>`
        : '\u2014';
      return `<tr><td><span class="feed-mark" aria-hidden="true">${escapeHtml(p.title.slice(0, 1).toUpperCase())}</span>${escapeHtml(p.title)}</td><td>${formatNumber(p.entries)}</td><td>${formatNumber(p.translation_ready)}</td><td>${formatNumber(p.translation_skipped)}</td><td>${d}</td><td><button class="icon-button" data-feed="${p.feed_id}" aria-label="View entries from ${escapeHtml(p.title)}">${iconHtml('arrow')}</button></td></tr>`;
    })
    .join('');
  const h = e.feeds.length
    ? `<div class="table-wrap"><table><thead><tr><th>Feed</th><th>Entries</th><th>Generated</th><th>Skipped</th><th>Failed</th><th></th></tr></thead><tbody>${m}</tbody></table></div>`
    : emptyHtml('No entries yet.');
  return `${pageHeading('Overview')}${t.configured ? '' : '<div class="setup-banner"><strong>Add a provider to start processing entries.</strong><a class="button primary" href="#model">Configure \u2192</a></div>'}<div class="stat-grid">${v}</div><div class="overview-grid"><section class="panel activity"><div class="panel-heading"><div><h2>Translation activity</h2><p>Successful generations \xB7 14 days</p></div><span class="tag">UTC</span></div>${g}<div class="chart-foot"><span><i></i> Generated</span><span>Updated ${escapeHtml(formatDate(e.as_of))}</span></div></section><section class="panel pipeline"><div class="panel-heading"><h2>Output</h2></div><div class="pipeline-item"><span>Translations ready</span><strong>${formatNumber(n)}</strong></div><div class="pipeline-item"><span>Summaries ready</span><strong>${formatNumber(e.features.summary.ready ?? 0)}</strong></div><div class="pipeline-item"><span>Written to Miniflux</span><strong>${formatNumber(e.rendered)}</strong></div><div class="pipeline-item"><span>Pending write-back</span><strong>${formatNumber(e.render_pending)}</strong></div><a class="text-link" href="#tasks">View tasks ${iconHtml('arrow')}</a></section></div><section class="panel"><div class="panel-heading"><div><h2>Feeds</h2><p>Up to 20 \xB7 Failures first</p></div><a class="text-link" href="#entries">All entries ${iconHtml('arrow')}</a></div>${h}<div class="panel-foot">Skipped excludes entries outside the configured scope.</div></section>`;
}
const optionsHtml = (e: string[], t: string) =>
  e
    .map(
      (i) =>
        `<option value="${i}" ${i === t ? 'selected' : ''}>${escapeHtml(labelFor(i))}</option>`,
    )
    .join('');
async function entriesHtml() {
  const e = new URLSearchParams({ limit: '30', feature: entryFilter.feature });
  for (const [a, r] of Object.entries(entryFilter)) {
    if (r) {
      e.set(a, r);
    }
  }
  if (entryCursor) {
    e.set('before_id', String(entryCursor));
  }
  const t = await request<EntryPage>(`/admin/entries?${e}`);
  const i = t.entries
    .map(
      (a) =>
        `<tr><td class="entry-title"><button class="title-button" data-entry="${a.entry_id}">${escapeHtml(a.source_title || 'Untitled')}</button><div class="small">${escapeHtml(a.source_feed_title)} <span class="mono">/ #${a.entry_id}</span></div></td><td class="mono">${escapeHtml(a.primary_language ?? 'und')}</td><td title="${escapeHtml(labelFor(a.translation_skip_reason))}">${badgeHtml(a.translation_state)}</td><td title="${escapeHtml(labelFor(a.summary_skip_reason))}">${badgeHtml(a.summary_state)}</td><td>${badgeHtml(a.render_status)}</td><td><button class="icon-button" data-entry="${a.entry_id}" aria-label="View entry ${a.entry_id}">${iconHtml('arrow')}</button></td></tr>`,
    )
    .join('');
  const n = t.entries.length
    ? `<div class="table-wrap"><table><thead><tr><th>Entry</th><th>Language</th><th>Translation</th><th>Summary</th><th>Write-back</th><th></th></tr></thead><tbody>${i}</tbody></table></div>`
    : emptyHtml('No matching entries.');
  return `${pageHeading('Entries')}<section class="panel"><form id="entry-filter" class="filters"><label class="search-label">Search<input name="q" type="search" value="${escapeHtml(entryFilter.q)}" placeholder="Title or entry ID" /></label><label>Feature<select name="feature"><option value="translation" ${entryFilter.feature === 'translation' ? 'selected' : ''}>Translation</option><option value="summary" ${entryFilter.feature === 'summary' ? 'selected' : ''}>Summary</option></select></label><label>Status<select name="state"><option value="">All statuses</option>${optionsHtml(['ready', 'pending', 'processing', 'scheduled', 'skipped', 'failed'], entryFilter.state)}</select></label><button type="submit">Filter</button>${entryFilter.feed_id ? '<button type="button" data-action="clear-feed">Clear feed</button>' : ''}</form>${n}<div class="pagination"><span>Entries: ${formatNumber(t.entries.length)} \xB7 Newest ID first</span><div>${entryCursor ? '<button data-action="entries-first">First page</button>' : ''}<button data-entries-next="${t.next_cursor ?? ''}" ${t.next_cursor ? '' : 'disabled'}>Next \u2192</button></div></div></section>`;
}
function taskErrorHtml(e: SafeTask) {
  if (!e.last_error) return '<span class="small">No errors</span>';
  const t = e.last_error.integrity_stage
    ? ' / ' + escapeHtml(e.last_error.integrity_stage)
    : '';
  return `<div class="task-error mono">${escapeHtml(e.last_error.code)}${t}</div>`;
}
async function tasksHtml() {
  const e = new URLSearchParams({ limit: '30' });
  for (const [a, r] of Object.entries(taskFilter)) {
    if (r) {
      e.set(a, r);
    }
  }
  if (taskCursor) {
    e.set('before_id', String(taskCursor));
  }
  const { tasks: t } = await request<{
    tasks: SafeTask[];
  }>(`/admin/tasks?${e}`);
  const i = t
    .map((a) => {
      const r = a.entry_id ? ` \xB7 Entry ${a.entry_id}` : '';
      return `<tr><td><strong>${escapeHtml(labelFor(a.type))}</strong><div class="small mono">#${a.id}${r}</div></td><td>${badgeHtml(a.state)}</td><td class="mono">${a.attempts}</td><td><div>${escapeHtml(formatDate(a.updated_at))}</div>${taskErrorHtml(a)}</td><td><button data-requeue="${a.id}" ${a.requeueable ? '' : 'disabled'} title="${escapeHtml(a.requeue_reason?.code ?? 'Retry task')}" >Retry</button></td></tr>`;
    })
    .join('');
  const n = t.length
    ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Updated / Error</th><th>Action</th></tr></thead><tbody>${i}</tbody></table></div>`
    : emptyHtml('No matching tasks.');
  return `${pageHeading('Tasks')}<section class="panel"><form id="task-filter" class="filters"><label>Status<select name="state"><option value="">All statuses</option>${optionsHtml(['pending', 'leased', 'done', 'dead'], taskFilter.state)}</select></label><label>Type<select name="type"><option value="">All types</option>${optionsHtml(['generate_artifacts', 'render', 'digest', 'ingest_backfill'], taskFilter.type)}</select></label><button type="submit">Filter</button></form>${n}<div class="pagination"><span>Tasks: ${formatNumber(t.length)}</span><div>${taskCursor ? '<button data-action="tasks-first">First page</button>' : ''}<button data-tasks-next="${t.at(-1)?.id ?? ''}" ${t.length === 30 ? '' : 'disabled'}>Next \u2192</button></div></div></section><p class="help">Check entry details for source mismatches before retrying.</p>`;
}
let providerSequence = 0;
function providerHtml(e?: ProviderView) {
  const t = ++providerSequence;
  const i = (l: string) => `provider_${t}_${l}`;
  const n = e?.health.state ?? 'healthy';
  const a: Record<string, string> = {
    healthy: 'Standby',
    cooling: 'Cooling down',
    recovering: 'Awaiting retry',
    probing: 'Probing',
    disabled: 'Disabled',
  };
  const r = e?.health.retry_at
    ? `<p class="help">Retry after: ${escapeHtml(formatDate(new Date(e.health.retry_at).toISOString()))}</p>`
    : '';
  const s = e?.health.last_failure
    ? `<p class="help">Last error: <span class="mono">${escapeHtml(e.health.last_failure)}</span></p>`
    : '';
  return `<fieldset class="provider-card" data-provider="${t}"><legend>${escapeHtml(e?.id ?? 'New provider')}</legend><div class="provider-heading"><span class="badge ${n === 'cooling' ? 'waiting' : 'muted'}">${a[n]}</span><button type="button" data-action="remove-provider" aria-label="Remove ${escapeHtml(e?.id ?? 'New provider')}">Remove</button></div><div class="provider-pair"><label>Provider ID<input name="${i('id')}" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" value="${escapeHtml(e?.id ?? '')}" placeholder="primary" /></label><label>Priority<input name="${i('priority')}" type="number" required min="0" max="9007199254740991" step="1" value="${e?.priority ?? 100}" /></label></div><label>API Base URL<input name="${i('base_url')}" type="url" required maxlength="2048" value="${escapeHtml(e?.base_url ?? '')}" placeholder="https://api.example.com/v1" /></label><label>Model<input name="${i('model')}" required maxlength="256" value="${escapeHtml(e?.model ?? '')}" placeholder="Model ID" /></label><label>API Key <span class="optional">${e?.api_key_configured ? 'Saved' : 'Required'}</span><input name="${i('api_key')}" type="password" autocomplete="new-password" maxlength="4096" placeholder="${e?.api_key_configured ? 'Leave blank to keep current key' : 'Enter API key'}" /></label><p class="help">New provider IDs or URLs require a key.</p><div class="provider-pair"><label>Timeout (s)<input name="${i('timeout')}" type="number" min="0.001" max="600" step="0.001" required value="${(e?.request_timeout_ms ?? 18e4) / 1e3}" /></label><label class="provider-enabled"><input name="${i('enabled')}" type="checkbox" ${e?.enabled !== !1 ? 'checked' : ''} />Enabled</label></div>${r}${s}</fieldset>`;
}
function modelHtml(e: ModelView) {
  providerSequence = 0;
  return `${pageHeading('Models')}<div class="settings-grid"><section class="panel settings-panel"><div class="panel-heading"><div><h2>Providers</h2><p>Higher priority first; list order breaks ties.</p></div><span class="badge ${e.configured ? 'success' : 'waiting'}">${e.configured ? 'Configured' : 'Not configured'}</span></div><form id="model-form"><div id="provider-list">${e.providers.length ? e.providers.map((t) => providerHtml(t)).join('') : providerHtml()}</div><button type="button" data-action="add-provider">\uFF0B Add provider</button><div class="failover-settings"><h3>Failover</h3><div class="provider-pair"><label>Failure threshold<input name="failure_threshold" type="number" required min="1" max="100" step="1" value="${e.failover.failure_threshold}" /></label><label>Cooldown<input name="cooldown" required pattern="[1-9][0-9]*[smhd]" value="${escapeHtml(e.failover.cooldown)}" placeholder="5m" /></label></div><p class="help">Consecutive failures before cooldown. Use s, m, h or d; upstream retry delays may extend it.</p></div>${e.restart_required ? '<p class="form-error">Restart to apply other configuration changes.</p>' : ''}<div class="form-actions"><span class="small">Applies to new calls</span><button class="primary" type="submit">Save ${iconHtml('arrow')}</button></div></form></section><aside class="settings-aside"><h2>Compatibility</h2><p>Chat Completions with JSON output. Supports JSON and SSE responses.</p><div class="aside-note"><strong>Provider health</strong><p>Based on model calls. Saving does not test connectivity; refresh to update status.</p></div></aside></div>`;
}
function systemHtml(e: SystemStatus, t: unknown) {
  return `${pageHeading('System')}<div class="stat-grid"><div class="stat-card"><div class="stat-top">Database</div><div class="stat-word">${e.core.database ? 'OK' : 'Error'}</div><span class="small">SQLite</span></div><div class="stat-card"><div class="stat-top">Miniflux</div><div class="stat-word">${e.core.ready ? 'Connected' : 'Unavailable'}</div><span class="small">${escapeHtml(e.core.version ?? e.core.reason ?? 'Awaiting check')}</span></div><div class="stat-card wide"><div class="stat-top">Account binding</div><div class="stat-word">${escapeHtml(e.miniflux_account_binding.state)}</div><span class="small">${escapeHtml(e.miniflux_account_binding.configured_base_url)}</span></div></div><section class="panel diagnostic"><h2>Diagnostics</h2><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre></section><section class="panel diagnostic"><h2>Configuration <span class="tag">Read-only \xB7 Keys hidden</span></h2><p class="subtle">Edit providers in <a href="#model">Models</a>. Other changes require a restart.</p><pre>${escapeHtml(JSON.stringify(t, null, 2))}</pre></section>`;
}
function formString(e: FormData, t: string) {
  const i = e.get(t);
  return typeof i == 'string' ? i : '';
}
function bindForms() {
  for (const e of ['entry-filter', 'task-filter', 'model-form']) {
    document.getElementById(e)?.addEventListener('submit', (t) => {
      t.preventDefault();
      const i = t.currentTarget as HTMLFormElement;
      const n = new FormData(i);
      if (e === 'entry-filter') {
        entryFilter = {
          ...entryFilter,
          q: formString(n, 'q'),
          state: formString(n, 'state'),
          feature: formString(n, 'feature'),
        };
        entryCursor = null;
        renderPage();
      } else if (e === 'task-filter') {
        taskFilter = {
          state: formString(n, 'state'),
          type: formString(n, 'type'),
        };
        taskCursor = null;
        renderPage();
      } else {
        const a = i.querySelector<HTMLButtonElement>('button[type=submit]')!;
        a.disabled = !0;
        request<ModelView>('/admin/model', 'PUT', {
          revision: modelSettings!.revision,
          failover: {
            cooldown: formString(n, 'cooldown'),
            failure_threshold: Number(n.get('failure_threshold')),
          },
          providers: [
            ...i.querySelectorAll<HTMLElement>('[data-provider]'),
          ].map((r) => {
            const s = (l: string) =>
              formString(n, `provider_${r.dataset.provider}_${l}`);
            return {
              id: s('id'),
              priority: Number(s('priority')),
              enabled: s('enabled') === 'on',
              base_url: s('base_url'),
              model: s('model'),
              api_key: s('api_key'),
              request_timeout_ms: Math.round(Number(s('timeout')) * 1e3),
            };
          }),
        })
          .then(() => {
            i.reset();
            notify('Settings saved.');
            return renderPage();
          })
          .catch(reportError)
          .finally(() => {
            a.disabled = !1;
          });
      }
    });
  }
}
async function showEntry(e: number) {
  const t = renderVersion;
  const i = await request<EntryDetail>(`/admin/entries/${e}`);
  if (!authenticated || t !== renderVersion) return;
  const n = i.feature_states
    .map((s) => {
      const l = s.skip_reason
        ? `<small>${escapeHtml(labelFor(s.skip_reason))}</small>`
        : '';
      return `<div><span>${s.kind === 'translation' ? 'Translation' : 'Summary'}</span>${badgeHtml(s.state)}${l}</div>`;
    })
    .join('');
  const a = i.tasks
    .filter((s) => s.last_error)
    .map(
      (s) =>
        `<p class="task-error mono">#${s.id} \xB7 ${escapeHtml(s.last_error!.code)} ${escapeHtml(s.last_error!.integrity_stage)}</p>`,
    )
    .join('');
  const r = i.tasks.some((s) => s.last_error) ? `<h3>Task errors</h3>${a}` : '';
  detailsDialog.innerHTML = `<div class="dialog-head"><div><span class="eyebrow">ENTRY / ${e}</span><h2 id="dialog-title">${escapeHtml(i.source_title)}</h2></div><button data-action="close-dialog" aria-label="Close details">\xD7</button></div><div class="dialog-body"><div class="detail-states">${n}<div><span>Write-back</span>${badgeHtml(i.render_status)}</div><div><span>Language</span><strong>${escapeHtml(i.primary_language ?? 'und')}</strong></div></div><h3>Regenerate</h3><p class="help">Replaces generated content in Miniflux. Source is preserved.</p><div class="actions"><button data-reprocess="${e}" data-feature="translation">Retranslate</button><button data-reprocess="${e}" data-feature="summary">Regenerate summary</button></div>${r}<details><summary>Source HTML</summary><pre class="source">${escapeHtml(i.source.content)}</pre></details></div>`;
  detailsDialog.showModal();
}
async function dispatchAction(e: HTMLElement) {
  switch (e.dataset.action) {
    case 'add-provider': {
      const t = document.querySelector<HTMLElement>('#provider-list')!;
      if (t.children.length >= 32)
        throw new Error('Up to 32 providers allowed.');
      t.insertAdjacentHTML('beforeend', providerHtml());
      t.lastElementChild?.querySelector<HTMLInputElement>('input')?.focus();
      break;
    }
    case 'remove-provider':
      e.closest<HTMLElement>('[data-provider]')?.remove();
      break;
    case 'logout':
      if (
        scopeEditor?.hasUnsaved() &&
        !confirm('Discard unsaved rules and sign out?')
      )
        return;
      await request('/auth/session', 'DELETE');
      notice.textContent = '';
      showLogin();
      break;
    case 'refresh':
      await renderPage();
      break;
    case 'close-dialog':
      detailsDialog.close();
      break;
  }
}
async function handleAction(e: HTMLElement) {
  await dispatchAction(e);
  if (e.dataset.feed) {
    entryFilter.feed_id = e.dataset.feed;
    entryCursor = null;
    location.hash = 'entries';
  }
  if (e.dataset.action === 'clear-feed') {
    entryFilter.feed_id = '';
    entryCursor = null;
    await renderPage();
  }
  if (e.dataset.action === 'entries-first' || e.dataset.entriesNext) {
    entryCursor = e.dataset.entriesNext ? Number(e.dataset.entriesNext) : null;
    await renderPage();
  }
  if (e.dataset.action === 'tasks-first' || e.dataset.tasksNext) {
    taskCursor = e.dataset.tasksNext ? Number(e.dataset.tasksNext) : null;
    await renderPage();
  }
  if (e.dataset.entry) {
    await showEntry(Number(e.dataset.entry));
  }
  if (
    e.dataset.requeue &&
    confirm('Retry this task? This may call a model or write to Miniflux.')
  ) {
    await request(`/admin/tasks/${e.dataset.requeue}/requeue`, 'POST');
    notify('Task queued.');
    await renderPage();
  }
  if (
    e.dataset.reprocess &&
    confirm(
      `Regenerate ${e.dataset.feature === 'translation' ? 'translation' : 'summary'}? This calls a model and replaces the current content.`,
    )
  ) {
    const t = await request<{
      outcomes: Record<string, string>;
    }>(
      `/admin/entries/${e.dataset.reprocess}/reprocess?features=${e.dataset.feature}`,
      'POST',
    );
    notify(
      `Result: ${Object.values(t.outcomes)
        .map((i) => labelFor(i))
        .join(', ')}`,
    );
    detailsDialog.close();
    await renderPage();
  }
}
document.addEventListener('click', (e) => {
  const t = (e.target as Element).closest<HTMLButtonElement>(
    '[data-action], [data-feed], [data-requeue], [data-reprocess], [data-entry], [data-entries-next], [data-tasks-next]',
  )!;
  if (!(
    !t ||
    t.disabled ||
    (t.closest<HTMLFormElement>('form')! && t.type === 'submit')
  )) {
    t.setAttribute('disabled', '');
    handleAction(t)
      .catch(reportError)
      .finally(() => t.removeAttribute('disabled'));
  }
});
skipLink.addEventListener('click', (e) => {
  e.preventDefault();
  appRoot.querySelector<HTMLElement>('main')?.focus();
});
window.addEventListener('hashchange', () => {
  notice.textContent = '';
  renderPage();
});
window.addEventListener('beforeunload', (e) => {
  if (scopeEditor?.hasUnsaved()) {
    e.preventDefault();
  }
});
try {
  await request<ModelView>('/admin/model');
  authenticated = !0;
  showShell();
  await renderPage();
} catch (e) {
  showLogin();
  if (!(e instanceof RequestError && e.status === 401)) {
    reportError(e);
  }
}
