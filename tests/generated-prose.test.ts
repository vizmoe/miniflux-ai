import { expect, it } from 'vitest';
import { summarySpecification } from '../src/features/summary/index.js';
import { inspectTranslation } from '../src/features/translation/index.js';
import { extractTranslationBlocks } from '../src/html/blocks.js';
import { parseSource } from '../src/html/dom.js';

const source = {
  title: 'Beta Updates',
  blocks: extractTranslationBlocks(
    parseSource('<p><strong>Added feature.</strong><br>Fixed bug.</p>'),
  ).blocks,
};
const token = source.blocks[0].text.match(/⟦mfai:[^⟧]*⟧/u)![0];
const controls = [
  ['complete', token],
  ['unterminated', token.slice(0, -1)],
];

it.each(controls)(
  'rejects %s formatting controls in summaries',
  (_name, control) => {
    for (const format of ['paragraph', 'bullets'] as const) {
      const specification = summarySpecification(
        {
          instruction: 'Summarize the changes.',
          output_language: 'en',
          format,
          max_output_units: 100,
          heading: 'Summary',
        },
        'Added feature. Fixed bug.',
      );
      const text = `Added a feature ${control} and fixed a bug.`;
      expect(
        specification.inspect(
          format === 'paragraph'
            ? { format, text }
            : { format, items: ['A valid item.', text] },
        ).valid,
      ).toBe(false);
      const clean = 'The notation ⟦x⟧ is supported.';
      expect(
        specification.inspect(
          format === 'paragraph'
            ? { format, text: clean }
            : { format, items: [clean] },
        ).valid,
      ).toBe(true);
    }
  },
);

it.each(controls)(
  'requests title repair for %s controls without discarding valid body formatting',
  (_name, control) => {
    const blocks = source.blocks.map((block) => ({
      ...block,
      text: block.text.replace('Added feature.', '新增功能。'),
    }));
    const inspected = inspectTranslation(
      { title: `测试版更新 ${control}`, blocks },
      source,
      true,
    );
    expect(inspected.valid).toBe(false);
    expect(inspected.missingTitle).toBe(true);
    expect(inspected.missingIds).toEqual([]);
    expect(inspected.value.blocks).toEqual(blocks);
    expect(
      inspectTranslation({ title: '测试版更新 ⟦x⟧', blocks }, source, true)
        .valid,
    ).toBe(true);
  },
);
