import { describe, expect, it } from 'vitest';
import {
  extractSemanticBlocks,
  computeSourceContentUnits,
} from '../src/html/blocks.js';
import { parseSource, serializeSource } from '../src/html/dom.js';
import { canonicalTree, escapeHtml } from '../src/html/dom.js';
import {
  countContentUnits,
  hasContentUnits,
  isUsableSourceTitle,
  lexicalUnits,
} from '../src/html/units.js';
import { compose } from '../src/html/composition.js';
import {
  computeSourceIntegritySignature,
  projectSource,
  summaryMarker,
  translationMarker,
  markerShapedIdCount,
} from '../src/html/ownership.js';
import {
  sanitize,
  canonicalSanitizerTree,
} from '../src/html/minifluxSanitizer.js';
import type { Artifact } from '../src/db/repository.js';
import {
  translationSpecification,
  translationEligibility,
  inspectTranslation,
} from '../src/features/translation/index.js';
import { summarySpecification } from '../src/features/summary/index.js';
import { generationSnapshot } from '../src/config/snapshots.js';
import { config } from './helpers.js';

it('preserves lexical eligibility when early-exiting long multilingual blocks', () => {
  for (const text of [
    '',
    'https://example.test/only',
    '42 3.14 v1.2.3',
    '— + …',
    'hello 中文',
    '中文 hello',
    '日本語',
    '한국어',
    'ภาษาไทย',
    'မြန်မာစာ',
    'العربية',
    'नमस्ते',
    'hello '.repeat(4000),
  ]) {
    expect(hasContentUnits(text)).toBe(countContentUnits(text) > 0);
  }
  for (let codePoint = 32; codePoint < 0x20000; codePoint += 193) {
    const text = String.fromCodePoint(codePoint).repeat(3);
    expect(hasContentUnits(text), `U+${codePoint.toString(16)}`).toBe(
      countContentUnits(text) > 0,
    );
  }
  const plan = extractSemanticBlocks(
    parseSource('<p>Two words</p><p>中文</p>'),
  );
  plan.insert(plan.blocks[0]!.id, 'generated', 'additional generated text');
  expect(plan.sourceContentUnits).toBe(4);
});

const token = 'a'.repeat(32),
  other = 'b'.repeat(32),
  blockId = '123456abcdef';
export function artifactsFor(content: string, unchanged = false): Artifact[] {
  const blocks = extractSemanticBlocks(parseSource(content)).blocks;
  return [
    {
      id: 1,
      entry_id: 1,
      kind: 'translation',
      marker_token: token,
      output_language: 'zh-CN',
      created_at: 1,
      payload: {
        schema_version: 1,
        title: unchanged
          ? { status: 'unchanged' }
          : { status: 'translated', text: '译文标题' },
        blocks: blocks.map((b) =>
          unchanged
            ? { id: b.id, status: 'unchanged' }
            : { id: b.id, status: 'translated', text: '对应的完整译文。' },
        ),
      },
      render_spec: {
        schema_version: 1,
        title_template: '{translated} · {original}',
      },
    },
    {
      id: 2,
      entry_id: 1,
      kind: 'summary',
      marker_token: other,
      output_language: 'zh-CN',
      created_at: 1,
      payload: {
        schema_version: 1,
        format: 'bullets',
        items: ['摘要内容。', '第二项。'],
      },
      render_spec: { schema_version: 1, heading: '内容摘要' },
    },
  ] as Artifact[];
}
const fixtures = [
  [
    'paragraph and heading',
    '<h2>First heading</h2><p>First <em>paragraph</em> <a href="https://source.test">linked prose</a>.</p>',
    ['First heading', 'First paragraph linked prose.'],
  ],
  [
    'bare root',
    'Leading prose <b>with emphasis</b><p>Middle prose</p>Trailing prose',
    ['Leading prose with emphasis', 'Middle prose', 'Trailing prose'],
  ],
  [
    'nested lists',
    '<ul><li>Outer before<ul><li>Inner prose</li></ul>Outer after</li><li>Last item</li></ul>',
    ['Outer before', 'Inner prose', 'Outer after', 'Last item'],
  ],
  [
    'table topology',
    '<table><caption>Table caption</caption><tr><th>Heading cell</th><td>Before<p>Nested paragraph</p>After</td><td>Other cell</td></tr></table>',
    [
      'Table caption',
      'Heading cell',
      'Before',
      'Nested paragraph',
      'After',
      'Other cell',
    ],
  ],
  [
    'definition and quotes',
    '<dl><dt>Term heading</dt><dd>Before<p>Definition body</p>After</dd></dl><blockquote>Bare quote<p>Nested quote</p></blockquote>',
    [
      'Term heading',
      'Before',
      'Definition body',
      'After',
      'Bare quote',
      'Nested quote',
    ],
  ],
  [
    'nonprose descendants',
    '<p>Visible <code>excluded inline code</code> text <img src="https://source.test/a.png"> remains</p><pre>excluded preformatted text</pre><math><mi>x</mi></math>',
    ['Visible text remains'],
  ],
  [
    'figure owner',
    '<figure>Leading prose<img src="https://source.test/a.png"><figcaption>A caption</figcaption>Following prose</figure>',
    ['Leading prose', 'A caption', 'Following prose'],
  ],
  [
    'malformed HTML5 normalization',
    '<p>First paragraph<p>Second paragraph',
    ['First paragraph', 'Second paragraph'],
  ],
  [
    'nested inline quote',
    '<p>A <q>quoted phrase</q> with <br> line break.</p>',
    ['A quoted phrase with line break.'],
  ],
] as const;
describe('semantic Source topology and reversible ownership', () => {
  it.each(fixtures)('%s', (_label, content, expected) => {
    const plan = extractSemanticBlocks(parseSource(content));
    expect(plan.blocks.map((b) => b.text)).toEqual(expected);
    expect(new Set(plan.blocks.map((b) => b.id)).size).toBe(expected.length);
    expect(plan.blocks).toEqual(
      extractSemanticBlocks(parseSource(content)).blocks,
    );
    expect(computeSourceContentUnits(parseSource(content))).toBe(
      expected.reduce((n, text) => n + countContentUnits(text), 0),
    );
    const artifacts = artifactsFor(content),
      result = compose({ title: 'Original title', content }, artifacts);
    expect(result.title).toBe('译文标题 · Original title');
    expect(computeSourceIntegritySignature(result.content, artifacts)).toEqual(
      computeSourceIntegritySignature(content),
    );
    const stored = sanitize(result.content, 'https://source.test/article');
    expect(computeSourceIntegritySignature(stored, artifacts)).toEqual(
      computeSourceIntegritySignature(
        sanitize(content, 'https://source.test/article'),
      ),
    );
    expect(projectSource(parseSource(stored), artifacts).sort()).toEqual(
      result.markers,
    );
    expect(compose({ title: 'Original title', content }, artifacts)).toEqual(
      result,
    );
  });
  it('inserts only translated parts, preserves unknown tokens, and detects stale block plans', () => {
    const content = `<p>Original prose</p><p><sup id="${translationMarker('c'.repeat(32), blockId)}"></sup>Unowned prose</p>`;
    const arts = artifactsFor(content, true).slice(0, 1),
      composed = compose({ title: 'Original', content }, arts);
    expect(composed.title).toBe('Original');
    expect(composed.markers).toEqual([]);
    expect(computeSourceIntegritySignature(composed.content, arts)).toEqual(
      computeSourceIntegritySignature(content),
    );
    expect(markerShapedIdCount(content)).toBe(1);
    expect(() =>
      compose({ title: 'Original', content: '<p>Different prose</p>' }, arts),
    ).toThrow('block_plan_mismatch');
    expect(() =>
      extractSemanticBlocks(parseSource(content)).insert(
        'missing',
        'marker',
        'text',
      ),
    ).toThrow('unknown_block');
  });
  it('uses heading boundaries for sections and ignores empty/non-editorial carriers', () => {
    const root = parseSource(
      '<p>Introductory prose</p><h2>First section</h2><p>Its body</p><h2>Next section</h2><p>123 https://host.test v1.2.3</p>',
    );
    expect(
      extractSemanticBlocks(root)
        .sections()
        .map((s) => s.map((b) => b.text)),
    ).toEqual([
      ['Introductory prose'],
      ['First section', 'Its body'],
      ['Next section'],
    ]);
    expect(serializeSource(root)).toContain('Introductory');
  });
  it.each([
    `<p><span id="${translationMarker(token, blockId)}"></span>Text</p>`,
    `<p>Source</p><p><sup id="${translationMarker(token, blockId)}">not empty</sup>Text</p>`,
    `<p>Source</p><p><sup id="mfai-v2-translation-${token}-${blockId}"></sup>Text</p>`,
    `<ul><li>Source<sup id="${translationMarker(token, blockId)}"></sup>Text</li></ul>`,
    `<ul><li>Source<br><sup id="${translationMarker(token, blockId)}"></sup><b>Nested</b></li></ul>`,
    `<p>Source</p><p><sup id="${translationMarker(token, blockId)}"></sup>Text</p><p><sup id="${translationMarker(token, blockId)}"></sup>Duplicate</p>`,
    `<p>Source</p><blockquote><sup id="${summaryMarker(other)}"></sup><p>Heading</p><p>Summary</p></blockquote>`,
    `<blockquote><sup id="${summaryMarker(other)}"></sup><p>Only heading</p></blockquote>`,
  ])(
    'fails closed on known malformed regions without partial removal',
    (content) => {
      const root = parseSource(content),
        before = root.innerHTML;
      expect(() =>
        projectSource(root, [
          { kind: 'translation', marker_token: token },
          { kind: 'summary', marker_token: other },
        ]),
      ).toThrow('source_projection_invalid');
      expect(root.innerHTML).toBe(before);
    },
  );
});
describe('editorial units and Feature validation', () => {
  it('canonicalizes ordinary attributes and escapes generated text exactly once', () => {
    expect(
      canonicalTree(
        parseSource(
          '<p title="test" id="first">e\u0301cole <!-- comment --> text</p>',
        ),
      ),
    ).toEqual([
      {
        tag: 'p',
        attributes: [
          ['id', 'first'],
          ['title', 'test'],
        ],
        children: [{ text: 'école ' }, { text: ' text' }],
      },
    ]);
    expect(escapeHtml('<&"\'>')).toBe('&lt;&amp;&quot;&#39;&gt;');
  });
  it.each([
    '<iframe src="https://www.youtube.com/embed/123" width="560" allowfullscreen>ignored contents</iframe>',
    '<iframe src="https://player.vimeo.com/video/123"></iframe>',
    '<iframe src="https://untrusted.test/video"></iframe><iframe src="bad-url"></iframe>',
    '<video src="https://source.test/video.mp4" poster="https://source.test/poster.jpg"><source src="https://source.test/alternative.mp4"></video><audio src="https://source.test/audio.mp3"></audio>',
    '<picture><source srcset="https://source.test/small.png 1x, https://source.test/large.png 2x" media="(min-width: 500px)"><img src="https://source.test/image.png" height="20" width="30" decoding="async" fetchpriority="high"></picture>',
    '<img src="data:image/png;base64,AAAA" width="invalid" height="-5" decoding="invalid" fetchpriority="invalid">',
    '<img src="https://stats.wordpress.com/tracker"><img src="https://source.test/pixel" width="1" height="1"><img srcset="javascript:bad 1x">',
    '<p hidden>Hidden text</p><p>Visible text<a href="#heading">local</a><a href="mailto:user@example.test">mail</a></p>',
    '<math xmlns="wrong"><mi>x</mi><mo>+</mo><mn>1</mn></math>',
    '<!-- ignored comment --><a href="/relative">relative</a><img src="/relative.png">',
  ])('keeps the sanitizer model idempotent for resources: %s', (content) => {
    const first = sanitize(content, 'https://source.test/article');
    expect(
      canonicalSanitizerTree(sanitize(first, 'https://source.test/article')),
    ).toEqual(canonicalSanitizerTree(first));
    expect(first).not.toMatch(
      /javascript:|untrusted.test|Hidden text|wrong|stats.wordpress.com/,
    );
  });
  it.each([
    'http://example.com',
    'https://example.com?preview=1',
    'http://EXAMPLE.com:80',
    'https://example.com:443/a/../b',
    'https://例子.测试/路径',
    'ftp://example.com:21',
    'mailto:reader@example.com',
  ])('preserves an allowed absolute resource verbatim: %s', (url) => {
    const content = `<p><a href="${url}">Source link</a></p>`;
    for (const base of ['https://source.test/article', ''])
      expect(canonicalSanitizerTree(sanitize(content, base))).toEqual(
        canonicalSanitizerTree(content),
      );
  });
  it('preserves absolute resource attributes and resolves network paths with HTTPS', () => {
    const content =
      '<img src="https://Images.example.com:443" srcset="https://Small.example.com 1x, https://Large.example.com:443 2x"><q cite="http://Example.com">Quote</q><video src="https://Video.example.com" poster="https://Poster.example.com"></video>';
    expect(
      canonicalSanitizerTree(sanitize(content, 'https://source.test/article')),
    ).toEqual(canonicalSanitizerTree(content));
    const links = parseSource(
      sanitize(
        '<a href="//Example.com">Network path</a><a href="/relative">Relative path</a>',
        'http://source.test/article',
      ),
    ).querySelectorAll('a');
    expect(Array.from(links, (a) => a.getAttribute('href'))).toEqual([
      'https://Example.com',
      'http://source.test/relative',
    ]);
  });
  it.each(['img', 'source'])(
    'preserves commas inside %s srcset URLs',
    (tag) => {
      const candidates =
        'https://cdn.test/image/w_320,c_limit/photo.png 320w, https://cdn.test/image/w_640,c_limit/photo.png?crop=1,2 640w';
      const content = `<${tag} srcset="${candidates}">`;
      const cleaned = sanitize(content, 'https://source.test/article');
      expect(
        parseSource(cleaned).querySelector(tag)?.getAttribute('srcset'),
      ).toBe(candidates);
      expect(canonicalSanitizerTree(cleaned)).toEqual(
        canonicalSanitizerTree(content),
      );
    },
  );
  it.each([
    [
      ' , /one,a.png, ,\n /two,b.png\t2x, ',
      'https://source.test/one,a.png, https://source.test/two,b.png 2x',
    ],
    [
      'javascript:bad,still-bad 1x, https://stats.wordpress.com/a,b 2x, https://safe.test/a,b 3x',
      'https://safe.test/a,b 3x',
    ],
    [
      'data:image/png;base64,AAAA 1x, //safe.test/a,b 2x',
      'https://safe.test/a,b 2x',
    ],
    ['https://cdn.test/a,b', 'https://cdn.test/a,b'],
    ['', null],
    [', , \t,', null],
  ])(
    'handles srcset candidate boundaries without orphan URLs: %s',
    (input, expected) => {
      const cleaned = parseSource(
        sanitize(`<img srcset="${input}">`, 'https://source.test/article'),
      );
      expect(cleaned.querySelector('img')?.getAttribute('srcset') ?? null).toBe(
        expected,
      );
    },
  );
  it('preserves absolute resources with an empty captured URL and rejects unsafe nesting', () => {
    expect(
      sanitize(
        '<a href="https://source.test/article">Absolute</a><a href="/relative">Relative</a>',
        '',
      ),
    ).toContain('href="https://source.test/article"');
    expect(() =>
      sanitize('<span>'.repeat(520) + 'deep' + '</span>'.repeat(520), ''),
    ).toThrow('sanitizer_depth_exceeded');
  });
  it.each([
    ['Hello world', 2],
    ['中文日本語', 5],
    ['e\u0301cole école', 2],
    [
      '123 45.6 v1.2.3 https://host.test/path user@host.test /tmp/file abcdef0123456789',
      0,
    ],
    ['👨‍👩‍👧‍👦 !!!', 0],
    ['Привет мир', 2],
  ])('counts %s', (text, count) => expect(countContentUnits(text)).toBe(count));
  it('separates script evidence and ignores number-only titles', () => {
    expect(lexicalUnits('中文かな한글 English')).toMatchObject({
      han_units: 2,
      kana_units: 2,
      hangul_units: 2,
      latin_words: 1,
    });
    expect(countContentUnits('ภาษาไทย')).toBeGreaterThan(0);
    expect(isUsableSourceTitle('123 !!!')).toBe(false);
    expect(translationEligibility('', 0, 'zh', 'zh-CN', [])).toBe(
      'no_translatable_content',
    );
    expect(translationEligibility('Title', 0, 'zh', 'zh-TW', [])).toBe(
      'language_not_required',
    );
    expect(translationEligibility('Title', 0, null, 'zh-CN', [])).toBeNull();
  });
  it('repairs exactly invalid translation members and stores unchanged status without Source prose', () => {
    const source = {
      title: 'Original title',
      blocks: [{ id: blockId, text: 'Original body' }],
    };
    const work = generationSnapshot(config(), ['translation', 'summary'], 100);
    const spec = translationSpecification(work.translation!, source);
    expect(
      inspectTranslation({ title: 'Title', blocks: [] }, source, true),
    ).toMatchObject({ missingTitle: false, missingIds: [blockId] });
    expect(
      inspectTranslation(
        { title: 'Title', blocks: [{ id: 'unknown', text: 'Text' }] },
        source,
        true,
      ).valid,
    ).toBe(false);
    expect(
      inspectTranslation(
        {
          title: '<b>Bad</b>',
          blocks: [
            { id: blockId, text: 'Text' },
            { id: blockId, text: 'Duplicate' },
          ],
        },
        source,
        true,
      ).missingIds,
    ).toEqual([blockId]);
    expect(
      spec.build(
        { title: 'Original title', blocks: source.blocks },
        source,
        true,
      ),
    ).toEqual({
      schema_version: 2,
      title: { status: 'unchanged' },
      blocks: [{ id: blockId, status: 'unchanged' }],
    });
    const summary = summarySpecification(
      { ...work.summary!, max_output_units: 3 },
      'Source link https://source.test/article',
    );
    expect(
      summary.inspect({ format: 'paragraph', text: 'short summary' }).valid,
    ).toBe(true);
    expect(
      summary.inspect({
        format: 'paragraph',
        text: 'four ordinary source words',
      }),
    ).toMatchObject({ reason: 'max_units_exceeded' });
    expect(
      summary.inspect({ format: 'paragraph', text: 'https://invented.test' }),
    ).toMatchObject({ reason: 'url' });
    expect(
      summary.inspect({
        format: 'paragraph',
        text: 'https://source.test/article',
      }).valid,
    ).toBe(true);
    expect(
      summary.inspect({ format: 'bullets', items: ['Wrong format'] }),
    ).toMatchObject({ reason: 'shape' });
  });
  it('models sanitizer removal and allowed resource preservation', () => {
    const source =
      '<script>bad()</script><div class="removed"><p onclick="bad()">Safe <a href="javascript:bad()">link</a><img src="https://source.test/image.png" width="200" alt="Image"></p></div>';
    const safe = sanitize(source, 'https://source.test/article');
    expect(safe).not.toMatch(/script|onclick|javascript/);
    expect(safe).toContain('alt="Image"');
    expect(
      canonicalSanitizerTree(sanitize(safe, 'https://source.test/article')),
    ).toEqual(canonicalSanitizerTree(safe));
  });
});
