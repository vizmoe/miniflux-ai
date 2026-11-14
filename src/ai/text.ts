import { normalizeText } from '../html/units.js';
import { hasFormattingControls } from '../html/inline.js';
import { absoluteUrlSpans, trimTrailingCharacters } from '../runtime/text.js';
export const plainText = (value: unknown): value is string =>
  typeof value === 'string' &&
  normalizeText(value).length > 0 &&
  !/<\/?[A-Za-z][^>]*>/.test(value);
export const displayText = (value: unknown): value is string =>
  plainText(value) && !hasFormattingControls(value);
export function absoluteUrls(value: string) {
  const result = new Set<string>();
  for (const { start, end } of absoluteUrlSpans(
    value,
    /[\s<>"'\u3001-\u303f]/u,
  )) {
    try {
      result.add(
        new URL(
          trimTrailingCharacters(
            value.slice(start, end),
            '.,;!?，。；！？）)]}',
          ),
        ).toString(),
      );
    } catch {
      /* invalid lexical URL */
    }
  }
  return result;
}
export function splitSentences(value: string) {
  return Array.from(
    new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value),
    (s) => s.segment.trim(),
  ).filter(Boolean);
}
export function halves<T>(values: T[]): [T[], T[]] | null {
  if (values.length < 2) return null;
  const middle = Math.ceil(values.length / 2);
  return [values.slice(0, middle), values.slice(middle)];
}
export function joinTranslation(parts: string[], source: string) {
  return parts.join(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      source,
    )
      ? ''
      : ' ',
  );
}
