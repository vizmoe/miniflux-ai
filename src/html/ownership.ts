import type { FeatureKind } from '../db/types.js';
export interface Ownership {
  marker_token: string;
  kind: FeatureKind;
}
import { WorkError } from '../obs/errors.js';
import {
  canonicalTree,
  isElement,
  meaningfulChildren,
  parseSource,
} from './dom.js';
import { allowedSourceAttributes } from './minifluxSanitizer.js';
const markerPattern =
  /^mfai-v1-(summary|translation)-([a-f0-9]{32})(?:-([a-f0-9]{12}))?$/;
export function translationMarker(token: string, blockId: string) {
  return `mfai-v1-translation-${token}-${blockId}`;
}
export function summaryMarker(token: string) {
  return `mfai-v1-summary-${token}`;
}
function invalid(): never {
  throw new WorkError('source_projection_invalid', 'integrity', false);
}
function ownedMarker(
  el: Element,
  tokens: Map<string, FeatureKind>,
  seen: Set<string>,
) {
  const id = el.getAttribute('id')!;
  const token = /[a-f0-9]{32}/.exec(id)?.[0];
  if (!token || !tokens.has(token)) return null;
  const match = markerPattern.exec(id);
  if (
    match?.[2] !== token ||
    match[1] !== tokens.get(token) ||
    el.localName !== 'sup' ||
    el.childNodes.length ||
    seen.has(id)
  )
    invalid();
  const parent = el.parentElement;
  if (!parent) invalid();
  return { id, kind: match[1], blockId: match[3], parent };
}
function summaryRegion(
  root: Element,
  el: Element,
  parent: Element,
  blockId: string | undefined,
): ChildNode[] {
  if (
    blockId ||
    parent.localName !== 'blockquote' ||
    parent.parentElement !== root ||
    meaningfulChildren(root)[0] !== parent ||
    meaningfulChildren(parent)[0] !== el
  )
    invalid();
  const children = meaningfulChildren(parent);
  if (
    children.length !== 3 ||
    !isElement(children[1]) ||
    children[1].localName !== 'p' ||
    !isElement(children[2]) ||
    !['p', 'ul'].includes(children[2].localName)
  )
    invalid();
  return [parent];
}
function inlineTranslationRegion(el: Element): ChildNode[] {
  const before = el.previousSibling;
  if (!before || !isElement(before) || before.localName !== 'br') invalid();
  const nodes: ChildNode[] = [before, el];
  for (let n = el.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType !== 3) invalid();
    nodes.push(n);
  }
  if (nodes.length === 2 || !nodes.slice(2).some((n) => n.textContent?.trim()))
    invalid();
  return nodes;
}
function blockTranslationRegion(el: Element, parent: Element): ChildNode[] {
  if (
    ![
      'p',
      'figcaption',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'dt',
      'dd',
    ].includes(parent.localName) ||
    meaningfulChildren(parent)[0] !== el
  )
    invalid();
  if (Array.from(parent.childNodes).some((n) => n !== el && n.nodeType !== 3))
    invalid();
  if (!parent.textContent?.trim()) invalid();
  const previous = parent.previousSibling;
  if (
    !previous ||
    (parent.localName !== 'p' &&
      (!isElement(previous) || previous.localName !== parent.localName))
  )
    invalid();
  return [parent];
}
function disjointRegions(regions: ChildNode[][]) {
  const all = regions.flat();
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      if (
        all[i] === all[j] ||
        all[i].contains(all[j]) ||
        all[j].contains(all[i])
      )
        invalid();
  return all;
}
/** Validate every region before removing any; an unknown token is always Source. */
export function projectSource(root: Element, ownership: Ownership[]) {
  const tokens = new Map(ownership.map((o) => [o.marker_token, o.kind]));
  const seen = new Set<string>(),
    translationBlocks = new Set();
  const regions: ChildNode[][] = [],
    markers = [];
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    const marker = ownedMarker(el, tokens, seen);
    if (!marker) continue;
    const { id, kind, blockId, parent } = marker;
    seen.add(id);
    markers.push(id);
    if (kind === 'summary') {
      regions.push(summaryRegion(root, el, parent, blockId));
      continue;
    }
    if (!blockId || translationBlocks.has(blockId)) invalid();
    translationBlocks.add(blockId);
    const inline = ['li', 'td', 'th', 'caption'].includes(parent.localName);
    regions.push(
      inline ? inlineTranslationRegion(el) : blockTranslationRegion(el, parent),
    );
  }
  for (const node of disjointRegions(regions)) node.remove();
  return markers;
}
export function computeSourceIntegritySignature(
  content: string | Element,
  ownership: Ownership[] = [],
) {
  const root = typeof content === 'string' ? parseSource(content) : content;
  projectSource(root, ownership);
  return canonicalTree(root, allowedSourceAttributes);
}
export function markerShapedIdCount(content: string) {
  return Array.from(parseSource(content).querySelectorAll('[id]')).filter((n) =>
    n.id.startsWith('mfai-'),
  ).length;
}
