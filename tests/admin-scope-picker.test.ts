import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { openPicker, type Selection } from '../admin/scope-picker.js';
import type { Subscriptions } from '../admin/types.js';

afterEach(() => vi.unstubAllGlobals());
const catalog: Subscriptions = {
  feeds: [
    { id: 1, title: 'First feed', category_id: 7 },
    { id: 2, title: '<script>untrusted</script>', category_id: 99 },
    { id: 3, title: 'Next feed', category_id: 7 },
  ],
  categories: [
    { id: 7, title: 'News' },
    { id: 9, title: 'Empty category' },
  ],
};
function setup(
  selection: Selection = { feed_ids: [1, 42], category_ids: [] },
  subscriptions = catalog,
) {
  const { document, Event } = parseHTML(
    '<html><body><div id="root"><button data-edit-list="blocklist">Edit</button></div></body></html>',
  );
  const createElement = document.createElement.bind(document);
  // Linkedom supplies DOM events and selectors, but not native modal behavior.
  // Keyboard focus and real modal dismissal remain covered by Playwright.
  vi.spyOn(document, 'createElement').mockImplementation((name, options) => {
    const node = createElement(name, options);
    if (name === 'dialog')
      Object.assign(node, {
        showModal: () => node.setAttribute('open', ''),
        close: () => {
          node.removeAttribute('open');
          node.dispatchEvent(new Event('close'));
        },
      });
    return node;
  });
  vi.stubGlobal('document', document);
  const root = document.querySelector<HTMLElement>('#root')!;
  const apply = vi.fn<(selection: Selection) => void>();
  openPicker(root, 'blocklist', selection, subscriptions, apply);
  const dialog = root.querySelector('dialog')!;
  const change = (key: keyof Selection, id: number, checked: boolean) => {
    const input = dialog.querySelector<HTMLInputElement>(
      `[name=${key}][value="${id}"]`,
    )!;
    input.checked = checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const search = (value: string) => {
    const input = dialog.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return { root, dialog, apply, change, search, Event };
}

describe('Subscription picker selection contract', () => {
  it('groups feeds inside collapsed categories and distinguishes category rules from individual selections', () => {
    const p = setup({ feed_ids: [1], category_ids: [] });
    const expand = p.dialog.querySelector<HTMLButtonElement>(
      '[aria-label="Expand News"]',
    );
    expect(
      expand,
      'each Miniflux category has its own disclosure',
    ).not.toBeNull();
    const children = p.dialog.querySelector<HTMLElement>(
      `#${expand!.getAttribute('aria-controls')}`,
    )!;
    expect(children.hidden).toBe(true);
    expect(children.querySelector('[name=feed_ids][value="1"]')).not.toBeNull();
    expect(children.querySelector('[name=feed_ids][value="2"]')).toBeNull();
    expand!.click();
    expect(expand!.getAttribute('aria-expanded')).toBe('true');
    expect(children.hidden).toBe(false);
    const category = p.dialog.querySelector<HTMLInputElement>(
      '[name=category_ids][value="7"]',
    )!;
    expect(category.indeterminate).toBe(true);
    p.change('category_ids', 7, true);
    const feed = children.querySelector<HTMLInputElement>('[name=feed_ids]')!;
    expect(category.indeterminate).toBe(false);
    expect(feed.checked).toBe(true);
    expect(feed.disabled).toBe(true);
    const inherited = children.querySelector<HTMLInputElement>('[value="3"]')!;
    expect(inherited.checked).toBe(true);
    expect(inherited.disabled).toBe(true);
    expect(children.textContent).toContain('Via category');
    p.change('feed_ids', 3, false);
    p.change('category_ids', 7, false);
    expect(feed.disabled).toBe(false);
    expect(feed.checked).toBe(true);
    expect(inherited.checked).toBe(false);
    expect(inherited.disabled).toBe(false);
    p.dialog.querySelector<HTMLElement>('[data-picker-apply]')!.click();
    expect(p.apply).toHaveBeenCalledExactlyOnceWith({
      feed_ids: [1],
      category_ids: [],
    });
  });
  it('searches inside categories, preserves choices and restores manual expansion when search is cleared', () => {
    const p = setup();
    const click = (label: string) =>
      p.dialog.querySelector<HTMLElement>(`[aria-label="${label}"]`)!.click();
    click('Expand News');
    p.search('untrusted');
    const unknown = p.dialog.querySelector<HTMLElement>(
      '[aria-label="Category #99"]',
    )!;
    expect(unknown.hidden).toBe(false);
    expect(unknown.querySelector<HTMLElement>('.scope-children')!.hidden).toBe(
      false,
    );
    expect(
      p.dialog.querySelector<HTMLElement>('[aria-label="News"]')!.hidden,
    ).toBe(true);
    p.dialog.querySelector<HTMLElement>('[data-collapse-all]')!.click();
    expect(unknown.querySelector<HTMLElement>('.scope-children')!.hidden).toBe(
      true,
    );
    p.search('');
    expect(unknown.querySelector<HTMLElement>('.scope-children')!.hidden).toBe(
      true,
    );
    expect(
      p.dialog.querySelector('[aria-label="Collapse News"]'),
    ).not.toBeNull();
    p.search('first');
    const news = p.dialog.querySelector<HTMLElement>('[aria-label="News"]')!;
    expect(news.hidden).toBe(false);
    expect(news.querySelector<HTMLInputElement>('[value="1"]')!.checked).toBe(
      true,
    );
    expect(news.querySelector('[value="3"]')!.closest('label')!.hidden).toBe(
      true,
    );
    p.search('news');
    expect(news.querySelector('[value="3"]')!.closest('label')!.hidden).toBe(
      false,
    );
    p.search('');
    p.dialog.querySelector<HTMLElement>('[data-expand-all]')!.click();
    expect(
      [...p.dialog.querySelectorAll<HTMLElement>('.scope-children')].every(
        (g) => !g.hidden,
      ),
    ).toBe(true);
    p.dialog.querySelector<HTMLElement>('[data-collapse-all]')!.click();
    expect(
      [...p.dialog.querySelectorAll<HTMLElement>('.scope-children')].every(
        (g) => g.hidden,
      ),
    ).toBe(true);
    expect(p.apply).not.toHaveBeenCalled();
  });
  it('can select an empty category for future feeds and safely handles an empty catalog', () => {
    const p = setup({ feed_ids: [], category_ids: [] });
    p.change('category_ids', 9, true);
    p.dialog.querySelector<HTMLElement>('[data-picker-apply]')!.click();
    expect(p.apply).toHaveBeenCalledExactlyOnceWith({
      feed_ids: [],
      category_ids: [9],
    });
    const empty = setup(
      { feed_ids: [], category_ids: [] },
      { feeds: [], categories: [] },
    );
    expect(
      empty.dialog.querySelector<HTMLElement>('.scope-empty')!.hidden,
    ).toBe(false);
    empty.search('news');
    empty.dialog.querySelector<HTMLElement>('[data-picker-apply]')!.click();
    expect(empty.apply).toHaveBeenCalledExactlyOnceWith({
      feed_ids: [],
      category_ids: [],
    });
  });
  it('applies visible and filtered selections together without mutating input or dropping missing IDs', () => {
    const original = { feed_ids: [1, 42], category_ids: [77] };
    const p = setup(original);
    p.change('feed_ids', 2, true);
    p.change('feed_ids', 2, true);
    p.change('feed_ids', 1, false);
    p.search(' NEWS ');
    p.change('category_ids', 7, true);
    expect(
      p.dialog
        .querySelector('[aria-label="Category #99"]')!
        .hasAttribute('hidden'),
    ).toBe(true);
    expect(p.dialog.querySelector('output')!.textContent).toBe('4 selected');
    expect(original).toEqual({ feed_ids: [1, 42], category_ids: [77] });
    expect(p.apply).not.toHaveBeenCalled();
    p.dialog.querySelector<HTMLElement>('[data-picker-apply]')!.click();
    expect(p.apply).toHaveBeenCalledExactlyOnceWith({
      feed_ids: [42, 2],
      category_ids: [77, 7],
    });
    expect(p.root.querySelector('dialog')).toBeNull();
    expect(original).toEqual({ feed_ids: [1, 42], category_ids: [77] });
  });
  it('searches by IDs and shows untrusted titles as text while Cancel or Escape discards temporary choices', () => {
    const p = setup();
    expect(p.dialog.querySelector('script')).toBeNull();
    expect(p.dialog.textContent).toContain('<script>untrusted</script>');
    expect(p.dialog.textContent).toContain('Category #99');
    expect(p.dialog.textContent).toContain('Feed #42');
    p.change('feed_ids', 2, true);
    p.search('42');
    expect(
      p.dialog
        .querySelector('[aria-label="Unavailable feeds"]')!
        .hasAttribute('hidden'),
    ).toBe(false);
    p.search('does not exist');
    expect(p.dialog.querySelector('.scope-empty')!.hasAttribute('hidden')).toBe(
      false,
    );
    p.dialog.dispatchEvent(
      Object.assign(new p.Event('keydown', { cancelable: true }), {
        key: 'ArrowDown',
      }),
    );
    expect(p.root.querySelector('dialog')).not.toBeNull();
    p.dialog.dispatchEvent(
      Object.assign(new p.Event('keydown', { cancelable: true }), {
        key: 'Escape',
      }),
    );
    expect(p.root.querySelector('dialog')).toBeNull();
    expect(p.apply).not.toHaveBeenCalled();
    const next = setup({ feed_ids: [], category_ids: [] });
    next.change('category_ids', 7, true);
    next.dialog.querySelector<HTMLElement>('[data-picker-close]')!.click();
    expect(next.apply).not.toHaveBeenCalled();
    expect(next.root.querySelector('dialog')).toBeNull();
  });
});
