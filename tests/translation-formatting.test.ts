import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  extractSemanticBlocks,
  extractTranslationBlocks,
} from '../src/html/blocks.js';
import { parseSource } from '../src/html/dom.js';
import { compose } from '../src/html/composition.js';
import {
  computeSourceIntegritySignature,
  projectSource,
} from '../src/html/ownership.js';
import {
  canonicalSanitizerTree,
  sanitize,
} from '../src/html/minifluxSanitizer.js';
import {
  translationSpecification,
  inspectTranslation,
} from '../src/features/translation/index.js';
import { translationArtifactSchema } from '../src/db/documents.js';
import { artifactStats } from '../src/ai/stats.js';
import type { TranslationArtifact } from '../src/db/types.js';

const surge = readFileSync(
  new URL('./fixtures/telegram-surge.html', import.meta.url),
  'utf8',
).trim();
const minimal =
  '<p><strong>Beta Updates</strong><br><br>• Added feature.<br>• Fixed bug.</p>';
const rich =
  '<p>Added <em>support</em> for <code>h3=true &amp;&amp; x &lt; 3</code> in <a href="https://example.test/manual" title="Manual" id="source-link">the proxy</a>.</p>';
function translated(source: string) {
  const input = {
    title: '',
    blocks: extractTranslationBlocks(parseSource(source)).blocks,
  };
  const specification = translationSpecification(
    {
      instruction: 'Translate into Chinese.',
      target_language: 'zh-CN',
      title_template: '{translated} ({original})',
    },
    input,
  );
  const response = {
    blocks: input.blocks.map((block) => ({
      id: block.id,
      text: block.text
        .split(/(⟦mfai:[^⟧]*⟧)/u)
        .map((part) =>
          part.startsWith('⟦mfai:')
            ? part
            : part
                .replace('Beta Updates', '测试版更新')
                .replace('Added', '新增')
                .replace('Fixed', '修复'),
        )
        .join(''),
    })),
  };
  const inspected = specification.inspect(response, input, false);
  expect(inspected.valid).toBe(true);
  const artifact: TranslationArtifact = {
    id: 1,
    entry_id: 1,
    kind: 'translation',
    marker_token: 'a'.repeat(32),
    output_language: 'zh-CN',
    created_at: 1,
    payload: specification.build(inspected.value, input, false),
    render_spec: {
      schema_version: 1,
      title_template: '{translated} ({original})',
    },
    ai_stats: artifactStats([
      {
        provider_id: 'fixture',
        model: 'fixture',
        operation: 'generate_artifacts',
        duration_ms: 1,
        finish_reason: 'stop',
        outcome: 'succeeded',
        usage: null,
      },
    ]),
  };
  return {
    root: parseSource(
      compose({ title: '', content: source }, [artifact]).content,
    ),
    artifact,
  };
}

it.each([
  ['the deployed Surge Telegram article', surge],
  ['a minimal Telegram paragraph', minimal],
])(
  'preserves line breaks and emphasis when translating %s',
  (_name, source) => {
    const original = parseSource(source);
    const { root, artifact } = translated(source);
    const generated = root.querySelector('sup')!.parentElement!;
    expect(generated.querySelectorAll('br')).toHaveLength(
      original.querySelectorAll('br').length,
    );
    expect(generated.querySelector('strong')?.textContent).toBe('测试版更新');
    expect(root.textContent).not.toContain('⟦mfai:');
    expect(computeSourceIntegritySignature(root, [artifact])).toEqual(
      computeSourceIntegritySignature(original),
    );
  },
);

it('keeps inline code, emphasis and link destinations through sanitization and repeated rendering', () => {
  const { root, artifact } = translated(rich);
  const stored = sanitize(root.innerHTML, 'https://example.test/article');
  const parsed = parseSource(stored);
  const generated = parsed.querySelector('sup')!.parentElement!;
  expect(generated.querySelector('code')?.textContent).toBe('h3=true && x < 3');
  expect(generated.querySelector('em')?.textContent).toBe('support');
  expect(generated.querySelector('a')?.getAttribute('href')).toBe(
    'https://example.test/manual',
  );
  expect(generated.querySelector('a')?.getAttribute('title')).toBe('Manual');
  expect(parsed.querySelectorAll('#source-link')).toHaveLength(1);
  expect(computeSourceIntegritySignature(parsed, [artifact])).toEqual(
    computeSourceIntegritySignature(rich),
  );
  const again = compose({ title: '', content: parsed.innerHTML }, [artifact]);
  expect(
    canonicalSanitizerTree(
      sanitize(again.content, 'https://example.test/article'),
    ),
  ).toEqual(canonicalSanitizerTree(stored));
});

it.each([
  '<ul><li><strong>Beta Updates</strong><br>Added feature.</li></ul>',
  '<table><tbody><tr><td><strong>Beta Updates</strong><br>Added feature.</td></tr></tbody></table>',
  '<table><caption><strong>Beta Updates</strong><br>Added feature.</caption><tbody><tr><td>Fixed bug.</td></tr></tbody></table>',
  '<h2><strong>Beta Updates</strong></h2><p>Added feature.</p>',
  '<div><strong>Beta Updates</strong><br>Added feature.</div>',
])('preserves source structure and formatted translation in %s', (input) => {
  const source = sanitize(input, 'https://example.test/article');
  const { root, artifact } = translated(source);
  const stored = parseSource(
    sanitize(root.innerHTML, 'https://example.test/article'),
  );
  expect(
    Array.from(stored.querySelectorAll('strong'), (node) => node.textContent),
  ).toEqual(['Beta Updates', '测试版更新']);
  expect(computeSourceIntegritySignature(stored, [artifact])).toEqual(
    computeSourceIntegritySignature(source),
  );
});

it('rejects missing, duplicated, reordered or invented formatting before accepting a translation', () => {
  const source = {
    title: '',
    blocks: extractTranslationBlocks(parseSource(minimal)).blocks,
  };
  const block = source.blocks[0];
  const tokens = block.text.match(/⟦mfai:[^⟧]*⟧/gu)!;
  for (const text of [
    block.text.replace(tokens[0], ''),
    block.text + tokens[0],
    '译文' + [...tokens].reverse().join(''),
    block.text + '⟦mfai:invented⟧',
    block.text + '<img src="https://example.test/tracker">',
  ]) {
    const result = inspectTranslation(
      { blocks: [{ id: block.id, text }] },
      source,
      false,
    );
    expect(result.valid).toBe(false);
    expect(result.missingIds).toEqual([block.id]);
  }
});

it('requires protected inline code to remain unchanged', () => {
  const source = {
    title: '',
    blocks: extractTranslationBlocks(parseSource(rich)).blocks,
  };
  const block = source.blocks[0];
  const text = block.text.replace('h3%3Dtrue', 'h3%3Dfalse');
  expect(text).not.toBe(block.text);
  expect(
    inspectTranslation({ blocks: [{ id: block.id, text }] }, source, false)
      .valid,
  ).toBe(false);
});

it('rejects unsupported elements and forged ownership versions without removing any source', () => {
  for (const tag of ['img', 'iframe', 'p']) {
    const { root, artifact } = translated(minimal);
    root
      .querySelector('sup')!
      .parentElement!.append(root.ownerDocument.createElement(tag));
    const before = root.innerHTML;
    expect(() => projectSource(root, [artifact])).toThrow(
      'source_projection_invalid',
    );
    expect(root.innerHTML).toBe(before);
  }
  const { root, artifact } = translated(minimal);
  const before = root.innerHTML;
  expect(() =>
    projectSource(root, [
      { ...artifact, payload: { ...artifact.payload, schema_version: 1 } },
    ]),
  ).toThrow('source_projection_invalid');
  expect(root.innerHTML).toBe(before);
  const plain = translated('<p>Added feature.</p>');
  const marker = plain.root.querySelector('sup')!;
  marker.id = marker.id.replace('mfai-v2-', 'mfai-v1-');
  expect(() => projectSource(plain.root, [plain.artifact])).toThrow(
    'source_projection_invalid',
  );
});

it('preserves unknown version-two markers as source', () => {
  const { root, artifact } = translated(minimal);
  const marker = root.querySelector('sup')!;
  marker.id = marker.id.replace('a'.repeat(32), 'b'.repeat(32));
  const before = root.innerHTML;
  expect(projectSource(root, [artifact])).toEqual([]);
  expect(root.innerHTML).toBe(before);
});

it('still reads and projects a persisted version-one translation from the deployed article', () => {
  const { artifact } = translated(surge);
  artifact.payload = translationArtifactSchema.parse({
    schema_version: 1,
    title: null,
    blocks: [{ id: '478d800c704a', status: 'translated', text: '旧版译文' }],
  });
  const rendered = compose({ title: '', content: surge }, [artifact]);
  expect(rendered.markers[0]).toMatch(/^mfai-v1-translation-/u);
  expect(rendered.content).toContain('旧版译文');
  expect(computeSourceIntegritySignature(rendered.content, [artifact])).toEqual(
    computeSourceIntegritySignature(surge),
  );
});

it('does not count format controls or protected code as translatable prose', () => {
  for (const source of [surge, rich, '<p><code>h3=true</code></p>']) {
    const original = extractSemanticBlocks(parseSource(source));
    const formatted = extractTranslationBlocks(parseSource(source));
    expect(formatted.blocks.length).toBe(original.blocks.length);
    expect(formatted.sourceContentUnits).toBe(original.sourceContentUnits);
  }
});
