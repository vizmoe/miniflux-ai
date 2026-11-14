import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { ScopeEditor } from '../admin/scopes.js';
import type { Scopes, Subscriptions } from '../admin/types.js';

afterEach(() => vi.unstubAllGlobals());
const catalog: Subscriptions = {
  feeds: [
    { id: 1, title: 'First feed', category_id: 7 },
    { id: 2, title: 'Second feed', category_id: 7 },
    { id: 3, title: 'Other feed', category_id: 8 },
  ],
  categories: [
    { id: 7, title: 'News' },
    { id: 9, title: 'Empty category' },
  ],
};
function settings(): Scopes {
  return {
    source: 'yaml',
    revision: '1'.repeat(64),
    targets: ['translation', 'summary', 'digest:daily'].map((id) => ({
      id,
      name: id,
      enabled: id !== 'digest:daily',
      available: true,
      applied: true,
      fallback_action: 'allow',
      allowlist: { feed_ids: [], category_ids: [] },
      blocklist: { feed_ids: [], category_ids: [] },
      other_rules: [],
    })),
  };
}
function setup(
  initial = settings(),
  subscriptions: Subscriptions | null = catalog,
) {
  const { document, Event } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  vi.stubGlobal('document', document);
  const root = document.querySelector<HTMLElement>('#root')!;
  const save = vi.fn<(data: unknown) => Promise<Scopes>>();
  const saved = vi.fn(),
    failed = vi.fn();
  const editor = new ScopeEditor(initial, subscriptions, save, saved, failed);
  editor.mount(root);
  const click = (selector: string) =>
    root.querySelector<HTMLElement>(selector)!.click();
  const selectMode = (action: string) =>
    root
      .querySelector<HTMLInputElement>(
        `[name=fallback_action][value=${action}]`,
      )!
      .dispatchEvent(new Event('change', { bubbles: true }));
  const submit = () =>
    root
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return {
    editor,
    root,
    save,
    saved,
    failed,
    click,
    selectMode,
    submit,
    Event,
  };
}

describe('Scope editor state at the DOM boundary', () => {
  it('shows selected rules in collapsible categories with inherited feeds clearly identified', () => {
    const initial = settings();
    initial.targets[0]!.blocklist = {
      feed_ids: [1, 3, 9999],
      category_ids: [7, 9],
    };
    const s = setup(initial);
    const list = s.root.querySelector('[aria-label=Blocklist]')!;
    const groups = [...list.querySelectorAll('details')];
    expect(groups).toHaveLength(4);
    const news = groups.find((g) =>
      g.querySelector('summary')!.textContent!.includes('News'),
    )!;
    expect(news.hasAttribute('open')).toBe(false);
    expect(news.textContent).toContain('Whole category');
    expect(news.textContent).toContain('First feed');
    expect(news.textContent).toContain('Second feed');
    expect(news.textContent).not.toContain('Other feed');
    expect(news.querySelector('[data-id="2"]')).toBeNull();
    expect(news.textContent).toContain('Via category');
    Object.assign(news, { open: true });
    news.dispatchEvent(new s.Event('toggle'));
    s.click('[data-remove-list=blocklist][data-key=category_ids][data-id="7"]');
    const updated = s.root.querySelector('[aria-label=Blocklist]')!;
    expect(updated.textContent).toContain('First feed');
    expect(updated.textContent).not.toContain('Second feed');
    expect(updated.textContent).toContain('Feed #9999');
    expect(updated.querySelector('details')!.hasAttribute('open')).toBe(true);
    const open = updated.querySelector('details')!;
    Object.assign(open, { open: false });
    open.dispatchEvent(new s.Event('toggle'));
    s.selectMode('deny');
    expect(
      s.root
        .querySelector('[aria-label=Blocklist] details')!
        .hasAttribute('open'),
    ).toBe(false);
    Object.assign(open, { open: true });
    open.dispatchEvent(new s.Event('toggle'));
    s.selectMode('allow');
    expect(
      s.root
        .querySelector('[aria-label=Blocklist] details')!
        .hasAttribute('open'),
    ).toBe(false);
  });
  it('keeps drafts across refreshes without treating unrelated changes as conflicts and saves a complete policy', async () => {
    const s = setup();
    s.selectMode('deny');
    expect(s.editor.hasUnsaved()).toBe(true);
    const latest = settings();
    latest.revision = '2'.repeat(64);
    latest.targets[1]!.blocklist.feed_ids = [2];
    s.editor.refresh(latest, catalog);
    s.editor.mount(s.root);
    expect(s.root.textContent).toContain('Nothing is included.');
    expect(
      s.root.querySelector('button[type=submit]')!.hasAttribute('disabled'),
    ).toBe(false);
    const persisted = structuredClone(latest);
    persisted.targets[0]!.fallback_action = 'deny';
    s.save.mockResolvedValue(persisted);
    s.submit();
    s.submit();
    await vi.waitFor(() => expect(s.saved).toHaveBeenCalledOnce());
    expect(s.save).toHaveBeenCalledExactlyOnceWith({
      revision: latest.revision,
      target: 'translation',
      fallback_action: 'deny',
      allowlist: { feed_ids: [], category_ids: [] },
      blocklist: { feed_ids: [], category_ids: [] },
    });
    expect(s.failed).not.toHaveBeenCalled();
    expect(s.editor.hasUnsaved()).toBe(false);
  });
  it('shows both conflicting lists, prevents save, and resets only the selected feature', () => {
    const s = setup();
    s.selectMode('deny');
    s.click('[data-target=summary]');
    s.selectMode('deny');
    s.click('[data-target=translation]');
    const latest = settings();
    latest.targets[0]!.blocklist.feed_ids = [2];
    s.editor.refresh(latest, catalog);
    s.editor.mount(s.root);
    expect(s.root.textContent).toContain('Saved blocklist: Second feed');
    s.submit();
    expect(s.save).not.toHaveBeenCalled();
    s.click('[data-reset]');
    expect(s.root.textContent).toContain('Second feed');
    expect(
      s.root.querySelector('button[type=submit]')!.hasAttribute('disabled'),
    ).toBe(true);
    expect(s.editor.hasUnsaved()).toBe(true);
    s.click('[data-target=summary]');
    expect(s.root.textContent).toContain('Nothing is included.');
    s.click('[data-reset]');
    expect(s.editor.hasUnsaved()).toBe(false);
  });
  it('retains a removed job draft as unavailable and can apply an unchanged saved policy not yet active', async () => {
    const initial = settings();
    initial.targets[0]!.applied = false;
    const s = setup(initial);
    expect(s.root.textContent).toContain('Saved rules are not active');
    s.save.mockResolvedValue(settings());
    s.submit();
    await vi.waitFor(() => expect(s.saved).toHaveBeenCalledOnce());
    s.click('[data-target="digest:daily"]');
    s.selectMode('deny');
    const latest = settings();
    latest.targets.pop();
    s.editor.refresh(latest, catalog);
    s.editor.mount(s.root);
    expect(s.root.textContent).toContain('This job is not active');
    s.submit();
    expect(s.save).toHaveBeenCalledOnce();
    s.click('[data-reset]');
    s.editor.refresh(latest, catalog);
    s.editor.mount(s.root);
    expect(s.root.querySelector('[data-target="digest:daily"]')).toBeNull();
  });
  it('reports custom decisions honestly and retains unknown IDs during catalog failure', () => {
    const initial = settings();
    const t = initial.targets[0]!;
    t.allowlist.category_ids = [7];
    t.blocklist.feed_ids = [1, 9999];
    t.other_rules = [
      {
        name: 'article-condition',
        action: 'allow',
        match: { primary_languages: ['en'] },
      },
    ];
    const s = setup(initial);
    expect(s.root.textContent).toContain('1 included');
    expect(s.root.textContent).toContain('1 excluded');
    expect(s.root.textContent).toContain('1 depend on entry rules');
    expect(s.root.textContent).toContain('1 allowlisted feed is blocked');
    expect(s.root.textContent).toContain('Feed #9999');
    s.editor.refresh(initial, null);
    s.editor.mount(s.root);
    expect(s.root.textContent).toContain('Subscriptions unavailable');
    s.click('[data-remove-list=blocklist][data-id="9999"]');
    expect(s.editor.hasUnsaved()).toBe(true);
    expect(s.root.textContent).not.toContain('Feed #9999');
    s.click('[data-reset]');
    expect(s.root.textContent).toContain('Feed #9999');
  });
  it('retains failed edits for retry and suppresses callbacks after leaving the view', async () => {
    const s = setup();
    s.selectMode('deny');
    s.save.mockRejectedValue(
      Object.assign(new Error('stale'), { code: 'configuration_conflict' }),
    );
    s.submit();
    await vi.waitFor(() => expect(s.failed).toHaveBeenCalledOnce());
    expect(s.root.textContent).toContain('your edits are safe');
    expect(s.editor.hasUnsaved()).toBe(true);
    s.save.mockRejectedValue(new Error('offline'));
    s.submit();
    await vi.waitFor(() => expect(s.failed).toHaveBeenCalledTimes(2));
    expect(s.root.textContent).toContain('Your edits are kept');
    s.save.mockResolvedValue(settings());
    s.submit();
    s.root.remove();
    await vi.waitFor(() => expect(s.editor.hasUnsaved()).toBe(false));
    expect(s.saved).not.toHaveBeenCalled();
  });
});
