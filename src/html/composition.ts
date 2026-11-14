import { isDeepStrictEqual } from 'node:util';
import type { Artifact } from '../db/repository.js';
import { expandTemplate } from '../config/primitives.js';
import { parseSource } from './dom.js';
import { extractSemanticBlocks, extractTranslationBlocks } from './blocks.js';
import {
  computeSourceIntegritySignature,
  summaryMarker,
  translationMarker,
} from './ownership.js';

export class BlockPlanMismatch extends Error {
  constructor() {
    super('block_plan_mismatch');
  }
}
function insertSummary(
  root: HTMLElement,
  summary: Extract<Artifact, { kind: 'summary' }>,
): string {
  const document = root.ownerDocument;
  const wrapper = document.createElement('blockquote'),
    marker = document.createElement('sup');
  const id = summaryMarker(summary.marker_token);
  marker.id = id;
  wrapper.append(marker);
  const heading = document.createElement('p'),
    strong = document.createElement('strong');
  strong.textContent = summary.render_spec.heading;
  heading.append(strong);
  wrapper.append(heading);
  if (summary.payload.format === 'paragraph') {
    const p = document.createElement('p');
    p.textContent = summary.payload.text;
    wrapper.append(p);
  } else {
    const ul = document.createElement('ul');
    for (const text of summary.payload.items) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.append(li);
    }
    wrapper.append(ul);
  }
  root.insertBefore(wrapper, root.firstChild);
  return id;
}
export function compose(
  source: { title: string; content: string },
  artifacts: Artifact[],
): {
  title: string;
  content: string;
  markers: string[];
  sourceSignature: unknown;
} {
  const root = parseSource(source.content);
  const translation = artifacts.find((a) => a.kind === 'translation');
  const plan =
    translation?.payload.schema_version === 2
      ? extractTranslationBlocks(root)
      : extractSemanticBlocks(root);
  const markers: string[] = [];
  const sourceSignature = computeSourceIntegritySignature(root);
  let title = source.title;
  if (translation?.kind === 'translation') {
    if (
      !isDeepStrictEqual(
        translation.payload.blocks.map((b) => b.id),
        plan.blocks.map((b) => b.id),
      )
    )
      throw new BlockPlanMismatch();
    if (translation.payload.title?.status === 'translated')
      title = expandTemplate(translation.render_spec.title_template, {
        original: source.title,
        translated: translation.payload.title.text,
      });
    // Reverse insertion preserves adjacency when two residuals have the same owner.
    for (const block of [...translation.payload.blocks].reverse())
      if (block.status === 'translated') {
        const id = translationMarker(
          translation.marker_token,
          block.id,
          translation.payload.schema_version,
        );
        plan.insert(block.id, id, block.text);
        markers.push(id);
      }
  }
  const summary = artifacts.find((a) => a.kind === 'summary');
  if (summary?.kind === 'summary') {
    markers.push(insertSummary(root, summary));
  }
  return {
    title,
    content: root.innerHTML,
    markers: markers.toSorted((a, b) => a.localeCompare(b, 'en')),
    sourceSignature,
  };
}
