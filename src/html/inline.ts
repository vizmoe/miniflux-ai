import { createHash } from 'node:crypto';
import { canonicalTree, isElement } from './dom.js';
import { allowedSourceAttributes } from './minifluxSanitizer.js';

const inlineTags = new Set(
  'a abbr acronym b br cite code del dfn em i ins kbd q s samp small strong sub sup time u var wbr'.split(
    ' ',
  ),
);
const tokenPrefix = '⟦mfai:';
const tokenPattern = /⟦mfai:[^⟧]*⟧/gu;
export function hasFormattingControls(value: string) {
  return value.includes(tokenPrefix);
}
export function isInlineFormatting(element: Element) {
  return inlineTags.has(element.localName);
}
export function matchingFormatting(source: string, translated: string) {
  const expected = source.match(tokenPattern) ?? [];
  const actual = translated.match(tokenPattern) ?? [];
  return (
    expected.length === actual.length &&
    expected.every((token, index) => token === actual[index])
  );
}
export function isGeneratedInline(node: Node): boolean {
  if (node.nodeType === 3) return true;
  if (!isElement(node) || !isInlineFormatting(node)) return false;
  const attributes = new Set(
    allowedSourceAttributes(node).map(([name]) => name),
  );
  if (node.localName === 'a') {
    attributes.add('rel');
    attributes.add('referrerpolicy');
  }
  return (
    Array.from(node.attributes).every(
      (attribute) => attribute.name !== 'id' && attributes.has(attribute.name),
    ) && Array.from(node.childNodes).every(isGeneratedInline)
  );
}

type Action =
  { kind: 'open' | 'leaf'; element: Element } | { kind: 'close'; tag: string };
export function inlineFormatter(root: Element) {
  const document = root.ownerDocument;
  const nonce = createHash('sha256')
    .update(JSON.stringify(canonicalTree(root, allowedSourceAttributes)))
    .digest('hex')
    .slice(0, 12);
  const prefix = `${tokenPrefix}${nonce}:`;
  if (root.textContent?.includes(prefix))
    throw new Error('format_token_collision');
  const actions = new Map<string, Action>();
  const register = (label: string, action: Action) => {
    const token = `${prefix}${actions.size}:${label}⟧`;
    actions.set(token, action);
    return token;
  };
  const copyElement = (source: Element) => {
    const copy = document.createElement(source.localName);
    for (const [name, value] of allowedSourceAttributes(source))
      if (name !== 'id') copy.setAttribute(name, value);
    return copy;
  };
  return {
    open(element: Element) {
      return register(element.localName, { kind: 'open', element });
    },
    close(element: Element) {
      return register('/' + element.localName, {
        kind: 'close',
        tag: element.localName,
      });
    },
    leaf(element: Element) {
      // Keep protected code indivisible when generation splits sentences.
      const code = encodeURIComponent(element.textContent ?? '').replace(
        /[!'()*\.\-~_]/g,
        (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
      );
      return register(
        element.localName === 'code' ? `code=${code}` : element.localName,
        { kind: 'leaf', element },
      );
    },
    render(source: string, translated: string) {
      if (!matchingFormatting(source, translated))
        throw new Error('translation_format_invalid');
      const fragment = document.createDocumentFragment();
      const stack: (Element | DocumentFragment)[] = [fragment];
      for (const part of translated.split(/(⟦mfai:[^⟧]*⟧)/gu)) {
        const action = actions.get(part);
        if (!action) {
          stack.at(-1)!.appendChild(document.createTextNode(part));
          continue;
        }
        if (action.kind === 'close') {
          const current = stack.at(-1)!;
          if (
            stack.length < 2 ||
            !isElement(current) ||
            current.localName !== action.tag
          )
            throw new Error('translation_format_invalid');
          stack.pop();
        } else {
          const node = copyElement(action.element);
          if (action.kind === 'leaf' && action.element.localName === 'code')
            node.textContent = action.element.textContent;
          stack.at(-1)!.appendChild(node);
          if (action.kind === 'open') stack.push(node);
        }
      }
      if (stack.length !== 1) throw new Error('translation_format_invalid');
      return Array.from(fragment.childNodes);
    },
  };
}
