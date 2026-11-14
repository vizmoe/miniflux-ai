import { esc } from './html.js';
import {
  catalogGroups,
  type CatalogGroup,
  type Choice,
  type ListName,
  type Selection,
} from './scope-catalog.js';
import type { Subscriptions } from './types.js';

export type { Selection } from './scope-catalog.js';

function choiceHtml(choice: Choice): string {
  const type = choice.key === 'feed_ids' ? 'feed' : 'category';
  const label = `${choice.title} (${type} ${choice.id})`;
  return `<label class="scope-choice"><input type="checkbox" name="${choice.key}" value="${choice.id}" aria-label="${esc(label)}"><span><strong>${esc(choice.title)}</strong><small>${esc(choice.detail)}</small></span></label>`;
}

function groupHtml(group: CatalogGroup): string {
  const id = `picker-${group.key}`;
  const toggle = group.feeds.length
    ? `<button type="button" class="scope-disclosure" aria-label="Expand ${esc(group.title)}" aria-expanded="false" aria-controls="${id}"><span aria-hidden="true">›</span></button>`
    : '<span class="scope-disclosure-spacer"></span>';
  const heading = group.category
    ? choiceHtml(group.category)
    : `<strong>${esc(group.title)}</strong>`;
  const feeds = group.feeds.map(choiceHtml).join('');
  return `<section class="picker-group" data-group="${group.key}" aria-label="${esc(group.title)}"><div class="picker-group-head">${toggle}${heading}</div><div id="${id}" class="scope-children" hidden>${feeds}</div></section>`;
}

type GroupView = {
  group: CatalogGroup;
  element: HTMLElement;
  children: HTMLElement;
  toggle: HTMLButtonElement | null;
  category: HTMLInputElement | null;
  feeds: { choice: Choice; input: HTMLInputElement; row: HTMLElement }[];
  expanded: boolean;
};

function showChildren(view: GroupView, expanded: boolean): void {
  view.children.hidden = !expanded;
  view.toggle?.setAttribute('aria-expanded', String(expanded));
  view.toggle?.setAttribute(
    'aria-label',
    `${expanded ? 'Collapse' : 'Expand'} ${view.group.title}`,
  );
}

function updateSelection(view: GroupView, pending: Selection): void {
  const whole =
    view.group.category !== null &&
    pending.category_ids.includes(view.group.category.id);
  const count = view.feeds.filter((f) =>
    pending.feed_ids.includes(f.choice.id),
  ).length;
  if (view.category) {
    view.category.checked = whole;
    view.category.indeterminate = !whole && count > 0;
    let detail = view.group.category!.detail;
    if (whole) detail = 'All current and future feeds';
    else if (count) detail = `${count} of ${view.feeds.length} feeds selected`;
    view.category.closest('label')!.querySelector('small')!.textContent =
      detail;
  }
  for (const { choice, input, row } of view.feeds) {
    const explicit = pending.feed_ids.includes(choice.id);
    input.checked = whole || explicit;
    input.disabled = whole;
    let detail = choice.detail;
    if (whole)
      detail = explicit ? 'Also selected individually' : 'Via category';
    row.querySelector('small')!.textContent = detail;
  }
}

function filterGroup(view: GroupView, query: string): boolean {
  const category = view.group.category;
  const categoryMatches = `${view.group.title} ${category?.id ?? ''}`
    .toLowerCase()
    .includes(query);
  let visible = 0;
  for (const { choice, row } of view.feeds) {
    row.hidden =
      !categoryMatches &&
      !`${choice.title} ${choice.id}`.toLowerCase().includes(query);
    if (!row.hidden) visible++;
  }
  view.element.hidden = !categoryMatches && visible === 0;
  showChildren(view, Boolean(query) || view.expanded);
  return !view.element.hidden;
}

/** A temporary selection: Cancel/Escape never change the editor's draft. */
export function openPicker(
  root: HTMLElement,
  list: ListName,
  selection: Selection,
  catalog: Subscriptions,
  apply: (value: Selection) => void,
): void {
  const groups = catalogGroups(catalog, selection);
  const pending = structuredClone(selection);
  const dialog = document.createElement('dialog');
  dialog.className = 'scope-picker';
  dialog.setAttribute('aria-labelledby', 'picker-title');
  const rows = groups.map(groupHtml).join('');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="picker-title">Edit ${list}</h2><button type="button" data-picker-close aria-label="Close selection">×</button></div><div class="picker-controls"><input type="search" aria-label="Search subscriptions" placeholder="Search feeds, categories or IDs" autofocus><div class="picker-tree-tools"><p class="help">Categories include current and future feeds.</p><div class="actions"><button type="button" data-expand-all>Expand all</button><button type="button" data-collapse-all>Collapse all</button></div></div></div><div class="picker-results">${rows}<p class="scope-empty" hidden>No matching subscriptions.</p></div><div class="picker-footer"><output aria-live="polite"></output><div class="actions"><button type="button" data-picker-close>Cancel</button><button type="button" class="primary" data-picker-apply>Use selection</button></div></div>`;
  const views: GroupView[] = groups.map((group) => {
    const element = dialog.querySelector<HTMLElement>(
      `[data-group="${group.key}"]`,
    )!;
    return {
      group,
      element,
      expanded: false,
      children: element.querySelector<HTMLElement>('.scope-children')!,
      toggle: element.querySelector<HTMLButtonElement>('.scope-disclosure'),
      category: element.querySelector<HTMLInputElement>('[name=category_ids]'),
      feeds: group.feeds.map((choice) => {
        const input = element.querySelector<HTMLInputElement>(
          `[name=feed_ids][value="${choice.id}"]`,
        )!;
        return { choice, input, row: input.closest('label')! };
      }),
    };
  });
  let query = '';
  const update = () => {
    for (const view of views) updateSelection(view, pending);
    dialog.querySelector('output')!.textContent =
      `${pending.feed_ids.length + pending.category_ids.length} selected`;
  };
  const expand = (view: GroupView, value: boolean) => {
    if (!query) view.expanded = value;
    showChildren(view, value);
  };
  for (const view of views)
    view.toggle?.addEventListener('click', () =>
      expand(view, view.children.hasAttribute('hidden')),
    );
  for (const [selector, value] of [
    ['[data-expand-all]', true],
    ['[data-collapse-all]', false],
  ] as const)
    dialog.querySelector(selector)!.addEventListener('click', () => {
      for (const view of views) if (!view.element.hidden) expand(view, value);
    });
  dialog
    .querySelector<HTMLInputElement>('input[type=search]')!
    .addEventListener('input', (event) => {
      query = (event.target as HTMLInputElement).value.trim().toLowerCase();
      const visible = views
        .map((view) => filterGroup(view, query))
        .some(Boolean);
      dialog.querySelector<HTMLElement>('.scope-empty')!.hidden = visible;
    });
  dialog.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== 'checkbox' || input.disabled) return;
    const key = input.name as keyof Selection,
      id = Number(input.value);
    pending[key] = pending[key].filter((v) => v !== id);
    if (input.checked) pending[key].push(id);
    update();
  });
  for (const button of dialog.querySelectorAll('[data-picker-close]'))
    button.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-picker-apply]')!.addEventListener('click', () => {
    dialog.close();
    apply(pending);
  });
  dialog.addEventListener(
    'close',
    () => {
      dialog.remove();
      root
        .querySelector<HTMLButtonElement>(`[data-edit-list="${list}"]`)
        ?.focus();
    },
    { once: true },
  );
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dialog.close();
    }
  });
  update();
  dialog.querySelector<HTMLElement>('.scope-empty')!.hidden = groups.length > 0;
  root.append(dialog);
  dialog.showModal();
}
