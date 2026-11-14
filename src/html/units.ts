import { absoluteUrlSpans } from '../runtime/text.js';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const words = new Intl.Segmenter('en', { granularity: 'word' });
const cjk =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const fallback =
  /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
export const normalizeText = (text: string): string =>
  text.normalize('NFC').trim().replace(/\s+/gu, ' ');

function withoutUrls(text: string): string {
  const parts: string[] = [];
  let position = 0;
  for (const { start, end } of absoluteUrlSpans(text, /[\s<>]/u, true)) {
    parts.push(text.slice(position, start), ' ');
    position = end;
  }
  parts.push(text.slice(position));
  return parts.join('').replace(/\bwww\.[^\s<>]+/giu, ' ');
}

function emailEnd(text: string, at: number): number | null {
  let end = at + 1;
  while (end < text.length && /[\w.-]/.test(text[end]!)) end++;
  const domain = text.slice(at + 1, end);
  // Greedy domain matching chooses the final valid suffix, keeping later punctuation.
  for (
    let dot = domain.lastIndexOf('.');
    dot > 0;
    dot = domain.lastIndexOf('.', dot - 1)
  ) {
    if (!/^[a-z]{2}/i.test(domain.slice(dot + 1, dot + 3))) continue;
    let suffixEnd = dot + 3;
    while (suffixEnd < domain.length && /[a-z]/i.test(domain[suffixEnd]!))
      suffixEnd++;
    return at + 1 + suffixEnd;
  }
  return null;
}
function withoutEmails(text: string): string {
  const parts: string[] = [];
  let position = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > position && /[\w.+-]/.test(text[start - 1]!)) start--;
    if (start === at) continue;
    const end = emailEnd(text, at);
    if (end === null) continue;
    parts.push(text.slice(position, start), ' ');
    position = end;
  }
  parts.push(text.slice(position));
  return parts.join('');
}

export function cleanLexical(text: string): string {
  return withoutEmails(withoutUrls(text.normalize('NFC')))
    .replace(/(?:\b[a-z]:[\\/]|(?:\.{1,2}|~)?\/)[\w./\\@%+~-]+/giu, ' ')
    .replace(/\bv?\d+(?:[._-]\d+)+(?:[-+][\w.-]+)?\b/giu, ' ')
    .replace(/\b[a-f0-9]{16,}\b/giu, ' ')
    .replace(/\b[a-z0-9_-]{20,}\b/giu, ' ')
    .replace(/\b(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{12,}\b/giu, ' ')
    .replace(/\p{N}+(?:[.,]\p{N}+)*/gu, ' ');
}
export interface LexicalUnits {
  count: number;
  han_units: number;
  kana_units: number;
  hangul_units: number;
  latin_words: number;
  cleaned: string;
}
function countScriptUnit(result: LexicalUnits, segment: string): void {
  result.count++;
  if (/\p{Script=Han}/u.test(segment)) result.han_units++;
  else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(segment))
    result.kana_units++;
  else if (/\p{Script=Hangul}/u.test(segment)) result.hangul_units++;
}
/** One shared segmentation implementation for counting and script evidence. */
function scanLexicalUnits(text: string, firstOnly = false): LexicalUnits {
  const cleaned = cleanLexical(text);
  const result: LexicalUnits = {
    count: 0,
    han_units: 0,
    kana_units: 0,
    hangul_units: 0,
    latin_words: 0,
    cleaned,
  };
  let other = '';
  const flush = () => {
    for (const part of words.segment(other))
      if (part.isWordLike && /\p{L}/u.test(part.segment)) {
        result.count++;
        if (/\p{Script=Latin}/u.test(part.segment)) result.latin_words++;
        if (firstOnly) break;
      }
    other = '';
  };
  // Non-CJK prose uses the exact same word segmenter without constructing a
  // grapheme iterator and testing every individual character's script.
  if (!cjk.test(cleaned) && !fallback.test(cleaned)) {
    other = cleaned;
    flush();
    return result;
  }
  for (const { segment } of graphemes.segment(cleaned)) {
    if (cjk.test(segment) || fallback.test(segment)) {
      flush();
      if (firstOnly && result.count) return result;
      countScriptUnit(result, segment);
      if (firstOnly) return result;
    } else other += segment;
  }
  flush();
  return result;
}
export function lexicalUnits(text: string): LexicalUnits {
  return scanLexicalUnits(text);
}
/** Uses the identical cleaner and segmenters, stopping after the first unit. */
export function hasContentUnits(text: string): boolean {
  return scanLexicalUnits(text, true).count > 0;
}
export function countContentUnits(text: string): number {
  return lexicalUnits(text).count;
}
export function isUsableSourceTitle(title: string): boolean {
  return countContentUnits(normalizeText(title)) >= 1;
}
