import { afterEach, describe, expect, it } from 'vitest';
import { computeSourceIntegritySignature } from '../src/html/ownership.js';
import {
  auth,
  chat,
  compact,
  entry,
  generated,
  response,
  serviceFixture,
} from './helpers.js';
import { sourceFingerprint } from '../src/source/index.js';
import { parseSource } from '../src/html/dom.js';
import { retrySnapshot } from '../src/config/snapshots.js';

const fixtures: Awaited<ReturnType<typeof serviceFixture>>[] = [];
async function setup(
  yaml = 'features:\n  summary:\n    min_source_units: 1\n',
  original = entry(),
) {
  const f = await serviceFixture(yaml);
  fixtures.push(f);
  await f.prepare();
  f.upstream.entries.set(1, structuredClone(original));
  await f.service.ingest.poll();
  await f.drain();
  return { ...f, original };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

describe('periodic Entry recovery', () => {
  it('acknowledges Source-only content and cancels obsolete render debt before generating replacement output', async () => {
    const f = await setup();
    const stale = f.service.repository.requestRender(
      1,
      retrySnapshot(f.service.config),
    );
    const changed = {
      ...f.original,
      title: 'A corrected article title',
      content:
        '<p>The corrected article explains a new design and revised conclusions.</p>',
    };
    f.upstream.entries.set(1, changed);
    expect(await f.service.recovery.check(1)).toBe('regenerated');
    expect(f.service.repository.activeRender(1)).toBe(false);
    expect(f.service.repository.task(stale.id)!.state).toBe('dead');
    const saved = f.service.repository.entry(1)!;
    expect(saved.rendered_generation).toBe(saved.render_generation);
    expect(saved.rendered_title).toBe(changed.title);
    expect(f.service.repository.activeGeneration(1)).toBeDefined();
    expect(f.upstream.puts).toBe(1);
    await f.drain();
    expect(f.upstream.aiInputs).toHaveLength(2);
    expect(f.upstream.puts).toBe(2);
    expect(f.upstream.entries.get(1)!.content).toContain('完整的译文内容。');
  });

  it('does not acknowledge a Source snapshot that changes during language review', async () => {
    const f = await setup();
    const before = f.service.repository.entry(1)!;
    const artifacts = f.service.repository.currentArtifacts(1).map((a) => a.id);
    f.upstream.entries.set(1, { ...f.original, title: 'xyz', content: '' });
    let reviewed = false;
    f.upstream.languageHandler = (envelope) => {
      reviewed = true;
      f.upstream.entries.set(1, {
        ...f.original,
        title: 'Another corrected source title',
      });
      return chat(generated(envelope));
    };
    expect(await f.service.recovery.check(1)).toBe('failed');
    expect(reviewed).toBe(true);
    expect(f.service.repository.entry(1)!.source_revision).toBe(
      before.source_revision,
    );
    expect(f.service.repository.currentArtifacts(1).map((a) => a.id)).toEqual(
      artifacts,
    );
    expect(f.service.repository.activeRender(1)).toBe(false);
    expect(f.upstream.puts).toBe(1);
  });

  it.each(['body', 'title'])(
    'still removes obsolete generated %s when the changed Source now skips translation',
    async (remaining) => {
      const f = await setup(
        'features:\n  summary:\n    enabled: false\n',
        entry(1, remaining === 'title' ? '' : undefined),
      );
      const chinese =
        '这篇文章现在完全使用中文，详细介绍可靠服务的设计和实现，也包含足够的中文文本供语言识别使用，不再需要重复翻译成中文。';
      const stored = f.upstream.entries.get(1)!;
      if (remaining === 'body') {
        const root = parseSource(stored.content);
        root.querySelector('p')!.textContent = chinese;
        stored.content = root.innerHTML;
        stored.title = '新的中文标题';
      } else stored.content = `<p>${chinese}</p>`;
      expect(await f.service.recovery.check(1)).toBe('regenerated');
      expect(f.service.repository.activeRender(1)).toBe(true);
      await f.drain();
      expect(f.service.repository.featureStates(1)[0]!.state).toBe('skipped');
      expect(f.upstream.aiInputs).toHaveLength(1);
      expect(f.upstream.puts).toBe(2);
      expect(stored.title).toBe(
        remaining === 'body' ? '新的中文标题' : f.original.title,
      );
      expect(stored.content).not.toContain('完整的译文内容。');
      expect(stored.content).toContain(chinese);
    },
  );

  it('keeps an intact composition idempotent and repairs partial or edited generated regions', async () => {
    const f = await setup();
    expect(await f.service.recovery.check(1)).toBe('unchanged');
    const root = parseSource(f.upstream.entries.get(1)!.content);
    root.querySelector('blockquote')!.remove();
    f.upstream.entries.get(1)!.content = root.innerHTML.replace(
      '完整的译文内容。',
      'Modified generated text',
    );
    expect(await f.service.recovery.check(1)).toBe('restored');
    expect(await f.service.recovery.check(1)).toBe('busy');
    await f.drain();
    expect(await f.service.recovery.check(1)).toBe('unchanged');
    expect(f.upstream.aiInputs).toHaveLength(1);
    expect(f.upstream.entries.get(1)!.content).toContain('文章摘要。');
    expect(f.upstream.entries.get(1)!.content).toContain('完整的译文内容。');
    expect(f.upstream.puts).toBe(2);
  });

  it.each(['translation', 'summary'])(
    'restores %s independently, including read Entries',
    async (kind) => {
      const f = await setup(
        `features:\n  summary:\n    min_source_units: 1\n    enabled: ${kind === 'summary'}\n  translation:\n    enabled: ${kind === 'translation'}\n`,
      );
      f.upstream.entries.set(
        1,
        Object.assign(structuredClone(f.original), { status: 'read' }),
      );
      expect(await f.service.recovery.check(1)).toBe('restored');
      await f.drain();
      expect(f.upstream.aiInputs).toHaveLength(1);
      expect(
        f.service.repository.currentArtifacts(1).map((a) => a.kind),
      ).toEqual([kind]);
      expect(f.upstream.entries.get(1)!.content).toContain(
        kind === 'summary' ? '文章摘要。' : '完整的译文内容。',
      );
    },
  );

  it('restores a title-only translation and regenerates a title-only change', async () => {
    const f = await setup(
      'features:\n  summary:\n    enabled: false\n',
      entry(1, ''),
    );
    f.upstream.entries.get(1)!.title = f.original.title;
    expect(await f.service.recovery.check(1)).toBe('restored');
    await f.drain();
    expect(f.upstream.entries.get(1)!.title).toContain('译文标题');
    expect(f.upstream.aiInputs).toHaveLength(1);
    f.upstream.entries.get(1)!.title = 'A newly corrected headline';
    expect(await f.service.recovery.check(1)).toBe('regenerated');
    await f.drain();
    expect(f.upstream.aiInputs).toHaveLength(2);
    expect(f.upstream.aiInputs[1]).toMatchObject({
      source: { title: 'A newly corrected headline', blocks: [] },
    });
  });

  it('recovers existing translations with an exact block plan before a fingerprint is recorded', async () => {
    const f = await setup();
    f.service.db.run(
      'UPDATE entries SET source_fingerprint=NULL,rendered_title=NULL WHERE entry_id=1',
    );
    f.upstream.entries.set(1, structuredClone(f.original));
    expect(await f.service.recovery.check(1)).toBe('restored');
    await f.drain();
    expect(f.upstream.aiInputs).toHaveLength(1);
    expect(f.service.repository.entry(1)!.source_fingerprint).toBe(
      sourceFingerprint(f.original),
    );
  });

  it('re-evaluates language and eligibility when the Source becomes Chinese', async () => {
    const f = await setup('features:\n  summary:\n    enabled: false\n');
    const updated = {
      ...f.original,
      title: '已经更新的中文文章',
      content:
        '<p>这篇文章现在完全使用中文，详细介绍可靠服务的设计和实现，也包含足够的中文文本供语言识别使用，不再需要重复翻译成中文。</p>',
    };
    f.upstream.entries.set(1, structuredClone(updated));
    expect(await f.service.recovery.check(1)).toBe('regenerated');
    await f.drain();
    expect(f.service.repository.featureStates(1)).toMatchObject([
      {
        state: 'skipped',
        current_artifact_id: null,
        skip_reason: 'language_not_required',
      },
    ]);
    expect(f.upstream.aiInputs).toHaveLength(1);
    expect(f.service.repository.entry(1)).toMatchObject({
      source_title: updated.title,
      primary_language: 'zh',
      source_revision: 2,
    });
    expect(f.upstream.entries.get(1)!.content).toBe(updated.content);
    expect(f.upstream.puts).toBe(1);
  });

  it('fences a late model response after Source changes during generation', async () => {
    const f = await setup();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.upstream.aiHandler = async (envelope) => {
      entered();
      await waiting;
      return chat(generated(envelope));
    };
    await f.service.reprocess(1, ['translation', 'summary']);
    f.service.queue.tick();
    await started;
    const pending = f.service.repository.activeGeneration(1)!;
    const updated = {
      ...f.original,
      title: 'A different source title',
      content:
        '<p>A different source paragraph with corrected facts and a completely new conclusion.</p>',
    };
    f.upstream.entries.set(1, structuredClone(updated));
    expect(await f.service.recovery.check(1)).toBe('regenerated');
    release();
    await f.service.queue.idle();
    expect(f.service.repository.task(pending.id)).toMatchObject({
      state: 'dead',
      last_error: { code: 'source_changed' },
    });
    expect(f.service.repository.currentArtifacts(1)).toHaveLength(0);
    f.upstream.aiHandler = undefined;
    await f.drain();
    expect(f.service.repository.currentArtifacts(1)).toHaveLength(2);
    expect(await f.service.source.load(1)).toEqual({
      title: updated.title,
      content: updated.content,
    });
  });

  it('does not publish a result when Source changes before the model returns', async () => {
    const f = await setup();
    await f.service.reprocess(1, ['translation']);
    const newContent =
      '<p>This correction arrives while the model is still producing the previous translation.</p>';
    f.upstream.aiHandler = (envelope) => {
      f.upstream.entries.set(1, { ...f.original, content: newContent });
      return chat(generated(envelope));
    };
    await f.drain();
    expect(f.upstream.puts).toBe(1);
    expect(f.service.repository.listTasks({ state: 'dead' })[0]).toMatchObject({
      last_error: { code: 'source_changed' },
    });
    f.upstream.aiHandler = undefined;
    expect(await f.service.recovery.check(1)).toBe('regenerated');
    await f.drain();
    expect((await f.service.source.load(1)).content).toBe(newContent);
  });

  it('bounds scans, covers subsequent pages and leaves untracked history alone', async () => {
    const f = await serviceFixture();
    fixtures.push(f);
    await f.prepare();
    for (let id = 1; id <= 102; id++) {
      const e = entry(id);
      f.upstream.entries.set(id, e);
      if (id !== 2)
        f.service.repository.insertEntry(compact(id), sourceFingerprint(e));
    }
    await f.service.recovery.scan();
    expect(f.service.recovery.status.checked).toBe(100);
    expect(f.service.repository.entry(102)!.recovery_checked_at).toBe(0);
    await f.service.recovery.scan();
    expect(f.service.recovery.status.checked).toBe(101);
    expect(f.service.repository.entry(2)).toBeUndefined();
    expect(f.upstream.aiInputs).toHaveLength(0);
    expect(f.upstream.puts).toBe(0);
    await f.service.recovery.scan();
    expect(f.service.recovery.status.checked).toBe(101);
    expect(
      f.upstream.requests
        .filter((r) => r.url.pathname === '/v1/entries')
        .every((r) => !r.url.searchParams.has('status')),
    ).toBe(true);
  });

  it('records missing and failing Entries without preventing another Entry from recovering', async () => {
    const f = await setup();
    f.upstream.entries.delete(1);
    expect(await f.service.recovery.check(1)).toBe('missing');
    f.upstream.entries.set(1, structuredClone(f.original));
    f.upstream.intercept = (url) =>
      url.pathname === '/v1/entries/1' ? response({}, 503) : undefined;
    expect(await f.service.recovery.check(1)).toBe('failed');
    f.upstream.intercept = undefined;
    expect(await f.service.recovery.check(1)).toBe('restored');
    await f.drain();
    expect(f.upstream.aiInputs).toHaveLength(1);
  });

  it('gates recovery and protects its Admin trigger', async () => {
    const f = await setup();
    expect(
      (await f.app.inject({ method: 'POST', url: '/admin/recovery/run' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/admin/recovery/run',
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    f.service.binding.stop();
    f.service.recovery.stop();
    await expect(f.service.recovery.check(1)).rejects.toThrow();
  });

  it('lets Admin recover one tracked Entry immediately without regenerating unchanged Source', async () => {
    const f = await setup();
    await f.service.recovery.check(1);
    const ids = f.service.repository.currentArtifacts(1).map((a) => a.id);
    f.upstream.entries.set(1, structuredClone(f.original));
    const result = await f.app.inject({
      method: 'POST',
      url: '/admin/recovery/run',
      headers: auth,
      payload: { entry_id: 1 },
    });
    expect(result.statusCode).toBe(200);
    await f.drain();
    expect(f.upstream.entries.get(1)!.content).toContain('完整的译文内容。');
    expect(f.upstream.aiInputs).toHaveLength(1);
    expect(f.service.repository.currentArtifacts(1).map((a) => a.id)).toEqual(
      ids,
    );
    for (const [payload, expected] of [
      [{ entry_id: 2 }, 404],
      [{ entry_id: 0 }, 400],
      [{ entry_ids: [1] }, 400],
    ] as const) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/admin/recovery/run',
            headers: auth,
            payload,
          })
        ).statusCode,
      ).toBe(expected);
    }
  });
  it('restores an overwritten completed Entry without generating again', async () => {
    const f = await setup();
    const ids = f.service.repository.currentArtifacts(1).map((a) => a.id);
    f.upstream.entries.set(1, structuredClone(f.original));
    // Exercise the existing periodic scheduling path after the new-entry cursor
    // has passed this ID. Miniflux and the provider are the only fake boundaries.
    await f.service.scheduler['poll']();
    await f.drain();
    expect(f.upstream.entries.get(1)!.content).toContain('完整的译文内容。');
    expect(f.upstream.aiInputs).toHaveLength(1);
    expect(f.service.repository.currentArtifacts(1).map((a) => a.id)).toEqual(
      ids,
    );
    expect(
      computeSourceIntegritySignature(
        f.upstream.entries.get(1)!.content,
        f.service.repository.artifacts(1),
      ),
    ).toEqual(computeSourceIntegritySignature(f.original.content));
  });

  it('regenerates changed Source instead of applying stale Artifacts', async () => {
    const f = await setup();
    const content =
      '<p>The corrected article describes a different design with a new conclusion.</p>';
    f.upstream.entries.set(1, {
      ...f.original,
      title: 'Corrected article title',
      content,
    });
    await f.service.scheduler['poll']();
    await f.drain();
    expect(f.upstream.aiInputs).toHaveLength(2);
    expect(f.upstream.aiInputs[1]).toMatchObject({
      source: { title: 'Corrected article title' },
    });
    expect(f.upstream.entries.get(1)!.content).toContain('完整的译文内容。');
    expect(await f.service.source.load(1)).toEqual({
      title: 'Corrected article title',
      content,
    });
    expect(
      f.upstream.requests
        .filter((r) => r.method === 'PUT')
        .every((r) => /^\/v1\/entries\/\d+$/.test(r.url.pathname)),
    ).toBe(true);
  });
});
