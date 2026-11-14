import type { Scopes, Subscriptions } from './types.js';

export type Selection = Scopes['targets'][number]['allowlist'];
export type ListName = 'allowlist' | 'blocklist';
export type Choice = {
  id: number;
  key: keyof Selection;
  title: string;
  detail: string;
};
export type CatalogGroup = {
  key: string;
  title: string;
  category: Choice | null;
  feeds: Choice[];
};

/** Keep Miniflux identities and hierarchy, including selected unavailable IDs. */
export function catalogGroups(
  catalog: Subscriptions | null,
  selection: Selection,
): CatalogGroup[] {
  const groups = new Map<number, CatalogGroup>();
  const category = (id: number): CatalogGroup => {
    let group = groups.get(id);
    if (!group) {
      const title = catalog?.categories.find((c) => c.id === id)?.title;
      const choice: Choice = {
        id,
        key: 'category_ids',
        title: title ?? `Category #${id}`,
        detail: title === undefined ? 'Unavailable' : 'Category',
      };
      group = {
        key: `category-${id}`,
        title: choice.title,
        category: choice,
        feeds: [],
      };
      groups.set(id, group);
    }
    return group;
  };
  for (const c of catalog?.categories ?? []) category(c.id);
  for (const f of catalog?.feeds ?? [])
    category(f.category_id).feeds.push({
      id: f.id,
      key: 'feed_ids',
      title: f.title,
      detail: `Feed #${f.id}`,
    });
  for (const id of selection.category_ids) category(id);
  const result = [...groups.values()];
  for (const group of result)
    if (group.category!.detail !== 'Unavailable')
      group.category!.detail = `Category · ${group.feeds.length} ${group.feeds.length === 1 ? 'feed' : 'feeds'}`;
  const missing = selection.feed_ids
    .filter((id) => !catalog?.feeds.some((f) => f.id === id))
    .map((id): Choice => ({
      id,
      key: 'feed_ids',
      title: `Feed #${id}`,
      detail: 'Unavailable',
    }));
  if (missing.length)
    result.push({
      key: 'unavailable',
      title: 'Unavailable feeds',
      category: null,
      feeds: missing,
    });
  return result;
}

export function catalogChoices(
  catalog: Subscriptions | null,
  selection: Selection,
): Choice[] {
  return catalogGroups(catalog, selection).flatMap((group) =>
    group.category ? [group.category, ...group.feeds] : group.feeds,
  );
}
