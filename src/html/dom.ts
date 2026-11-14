import { parseHTML } from 'linkedom';
import { parse, serialize } from 'parse5';

/** HTML5 tree construction precedes the linkedom editing/extraction surface. */
export function parseSource(content: string): HTMLElement {
  const normalized = serialize(parse(`<body>${content}</body>`));
  return parseHTML(normalized).document.body as unknown as HTMLElement;
}
export function serializeSource(root: HTMLElement): string {
  return root.innerHTML;
}
export function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}
export function meaningfulChildren(node: Node): Node[] {
  return Array.from(node.childNodes).filter(
    (n) => n.nodeType !== 3 || Boolean(n.textContent?.trim()),
  );
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
export function canonicalTree(
  root: Node,
  attributes?: (e: Element) => Array<[string, string]>,
): unknown {
  const visit = (node: Node): unknown => {
    if (node.nodeType === 3)
      return {
        text: (node.textContent ?? '').normalize('NFC').replace(/\s+/gu, ' '),
      };
    if (!isElement(node)) return null;
    return {
      tag: node.localName,
      attributes: (attributes
        ? attributes(node)
        : Array.from(node.attributes).map((a): [string, string] => [
            a.name,
            a.value,
          ])
      ).sort(([a], [b]) => a.localeCompare(b)),
      children: Array.from(node.childNodes)
        .map(visit)
        .filter((v) => v !== null),
    };
  };
  return Array.from(root.childNodes)
    .map(visit)
    .filter((v) => v !== null);
}
