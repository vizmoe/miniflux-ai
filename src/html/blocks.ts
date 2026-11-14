import { createHash } from 'node:crypto';
import { isElement } from './dom.js';
import { inlineFormatter, isInlineFormatting } from './inline.js';
import { countContentUnits, hasContentUnits, normalizeText } from './units.js';
const carriers = new Set(
  'p h1 h2 h3 h4 h5 h6 li dt dd figcaption caption th td'.split(' '),
);
const owners = new Set(['blockquote', 'aside', 'figure']);
const structural = new Set('ul ol dl table thead tbody tfoot tr'.split(' '));
const excluded = new Set(
  'pre code math iframe img picture source audio video script style noscript'.split(
    ' ',
  ),
);
export interface SemanticBlock {
  id: string;
  text: string;
}
export type BlockPlan = ReturnType<typeof extractSemanticBlocks>;
export function extractSemanticBlocks(root: Element) {
  return blockPlan(root, false);
}
export function extractTranslationBlocks(root: Element) {
  return blockPlan(root, true);
}
function blockPlan(root: Element, formatted: boolean) {
  const formatter = formatted ? inlineFormatter(root) : null;
  const blocks: SemanticBlock[] = [];
  let sourceContentUnits;
  const anchors = new Map<
    string,
    {
      owner: Element;
      after: ChildNode;
      full: boolean;
      text: string;
      plainText: string;
    }
  >();
  const paths = new WeakMap<Element, string>();
  paths.set(root, 'root');
  const assign = (el: Element): void =>
    Array.from(el.children).forEach((child, index) => {
      paths.set(
        child,
        el === root ? String(index) : `${paths.get(el)}/${index}`,
      );
      assign(child);
    });
  assign(root);
  const containsBoundary = (el: Element): boolean =>
    Array.from(el.children).some(
      (c) =>
        carriers.has(c.localName) ||
        owners.has(c.localName) ||
        structural.has(c.localName) ||
        containsBoundary(c),
    );
  const processOwner = (owner: Element, isRoot = false): void => {
    let texts: string[] = [];
    let formattedTexts: string[] = [];
    let after: ChildNode | undefined;
    let ordinal = 0;
    const full =
      !isRoot && carriers.has(owner.localName) && !containsBoundary(owner);
    const emit = () => {
      const plainText = normalizeText(texts.join(''));
      const text = formatter
        ? normalizeText(formattedTexts.join(''))
        : plainText;
      if (after && hasContentUnits(plainText)) {
        const id = createHash('sha1')
          .update(`${paths.get(owner)}:${ordinal++}:${text}`, 'utf8')
          .digest('hex')
          .slice(0, 12);
        if (anchors.has(id)) throw new Error('semantic_block_id_collision');
        blocks.push({ id, text });
        anchors.set(id, { owner, after, full, text, plainText });
      }
      texts = [];
      formattedTexts = [];
      after = undefined;
    };
    const walk = (node: Node, branch: ChildNode): void => {
      if (node.nodeType === 3) {
        texts.push(node.textContent ?? '');
        formattedTexts.push(node.textContent ?? '');
        after = branch;
        return;
      }
      if (!isElement(node)) return;
      if (formatter && ['br', 'wbr', 'code'].includes(node.localName)) {
        if (node.localName === 'br') texts.push(' ');
        formattedTexts.push(formatter.leaf(node));
        after = branch;
        return;
      }
      if (excluded.has(node.localName)) return;
      if (carriers.has(node.localName) || owners.has(node.localName)) {
        emit();
        processOwner(node);
        return;
      }
      if (structural.has(node.localName)) {
        emit();
        const containers = (n: Element): void => {
          for (const child of Array.from(n.children)) {
            if (carriers.has(child.localName) || owners.has(child.localName))
              processOwner(child);
            else if (!excluded.has(child.localName)) containers(child);
          }
        };
        containers(node);
        return;
      }
      if (node.localName === 'br') texts.push(' ');
      const wrap =
        formatter && isInlineFormatting(node) && !containsBoundary(node);
      if (wrap) formattedTexts.push(formatter.open(node));
      for (const child of Array.from(node.childNodes)) walk(child, branch);
      if (wrap) {
        formattedTexts.push(formatter.close(node));
        after = branch;
      }
    };
    for (const node of Array.from(owner.childNodes)) walk(node, node);
    emit();
  };
  processOwner(root, true);
  return {
    blocks,
    // Generation and rendering need eligibility and anchors, not a second
    // full count of every block. Ingest asks for this measure once per plan.
    get sourceContentUnits() {
      sourceContentUnits ??= blocks.reduce(
        (sum, block) =>
          sum + countContentUnits(anchors.get(block.id)!.plainText),
        0,
      );
      return sourceContentUnits;
    },
    sections() {
      const result: SemanticBlock[][] = [];
      for (const block of blocks) {
        if (
          !result.length ||
          /^h[1-6]$/.test(anchors.get(block.id)!.owner.localName)
        )
          result.push([]);
        result.at(-1)!.push(block);
      }
      return result;
    },
    insert(id: string, marker: string, text: string) {
      const anchor = anchors.get(id);
      if (!anchor) throw new Error('unknown_block');
      const { owner, after, full } = anchor;
      const document = root.ownerDocument;
      const sup = document.createElement('sup');
      sup.setAttribute('id', marker);
      const generated = formatter
        ? formatter.render(anchor.text, text)
        : [document.createTextNode(text)];
      if (full && ['li', 'td', 'th', 'caption'].includes(owner.localName)) {
        owner.append(document.createElement('br'), sup, ...generated);
        return;
      }
      const tag = full ? owner.localName : 'p';
      const node = document.createElement(tag);
      node.append(sup, ...generated);
      if (full) owner.parentNode!.insertBefore(node, owner.nextSibling);
      else owner.insertBefore(node, after.nextSibling);
    },
  };
}
export function computeSourceContentUnits(root: Element) {
  return extractSemanticBlocks(root).sourceContentUnits;
}
