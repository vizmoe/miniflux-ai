import { esc } from './html.js';
import {
  catalogGroups,
  type Choice,
  type ListName,
  type Selection,
} from './scope-catalog.js';
import type { Subscriptions } from './types.js';

function selectedRow(
  choice: Choice,
  list: ListName,
  removable: boolean,
): string {
  const label = `Remove ${choice.title} from ${list}`;
  const remove = removable
    ? `<button type="button" data-remove-list="${list}" data-key="${choice.key}" data-id="${choice.id}" aria-label="${esc(label)}">×</button>`
    : '';
  const title = choice.key === 'category_ids' ? 'Whole category' : choice.title;
  return `<li class="scope-selected"><span><strong>${esc(title)}</strong><small>${esc(choice.detail)}</small></span>${remove}</li>`;
}

export function selectedGroupsHtml(
  catalog: Subscriptions | null,
  selection: Selection,
  list: ListName,
  expanded: ReadonlySet<string>,
): string {
  return catalogGroups(catalog, selection)
    .map((group) => {
      const whole =
        group.category !== null &&
        selection.category_ids.includes(group.category.id);
      const feeds = group.feeds.filter(
        (f) => whole || selection.feed_ids.includes(f.id),
      );
      if (!whole && !feeds.length) return '';
      const categoryRow = whole
        ? selectedRow(
            { ...group.category!, detail: 'Current and future feeds' },
            list,
            true,
          )
        : '';
      const rows = feeds
        .map((feed) => {
          const explicit = selection.feed_ids.includes(feed.id);
          let detail = feed.detail;
          if (whole)
            detail = explicit ? 'Also selected individually' : 'Via category';
          return selectedRow({ ...feed, detail }, list, explicit);
        })
        .join('');
      const description = whole ? 'Whole category' : `${feeds.length} selected`;
      const key = `${list}:${group.key}`;
      return `<details class="scope-selected-group" data-selection-group="${key}" ${expanded.has(key) ? 'open' : ''}><summary><span><strong>${esc(group.title)}</strong><small>${description}</small></span></summary><ul>${categoryRow}${rows}</ul></details>`;
    })
    .join('');
}
