import { z } from 'zod';
import { trimTrailingCharacters } from '../runtime/text.js';
export const nonempty = z.string().refine((s) => s.trim().length > 0);
export const safeId = z.int().positive();
export const nonnegative = z.int().nonnegative();
export const positive = z.int().positive();
export const timestamp = z.int();
export const uniqueIds = z
  .array(safeId)
  .transform((ids) => [...new Set(ids)].sort((a, b) => a - b));
export function durationMs(value: string) {
  const match = /^([1-9]\d*)([smhd])$/.exec(value);
  if (!match) throw new Error('invalid_duration');
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ]!;
  const result = Number(match[1]) * unit;
  if (!Number.isSafeInteger(result)) throw new Error('invalid_duration');
  return result;
}
export function normalizeBaseUrl(value: string) {
  const u = new URL(value);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  ) {
    throw new Error('invalid_base_url');
  }
  return trimTrailingCharacters(u.toString(), '/');
}
export function canonicalLanguage(value: string) {
  const result = Intl.getCanonicalLocales(value);
  if (result.length !== 1 || !result[0]) throw new Error('invalid_language');
  return result[0];
}
export function languageIdentity(value: string) {
  return canonicalLanguage(value).split('-')[0].toLowerCase();
}
export function parseInstant(value: string) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i.exec(
      value,
    );
  if (!m) throw new Error('invalid_instant');
  const [, y, mo, d, h, mi, s, fraction, zone] = m;
  const local = new Date(0);
  local.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  local.setUTCHours(
    Number(h),
    Number(mi),
    Number(s),
    Number((fraction ?? '').padEnd(3, '0').slice(0, 3)),
  );
  if (
    local.getUTCFullYear() !== Number(y) ||
    local.getUTCMonth() + 1 !== Number(mo) ||
    local.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    throw new Error('invalid_instant');
  }
  if (
    zone.toUpperCase() !== 'Z' &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)
  ) {
    throw new Error('invalid_instant');
  }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new Error('invalid_instant');
  return result;
}
export function validDate(value: string) {
  try {
    parseInstant(`${value}T00:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  } catch {
    return false;
  }
}
/** Application-owned template grammar; substituted text is never parsed again. */
export function templateParts(
  value: string,
  allowed: string[],
  required: string[] = [],
) {
  const parts: ({ literal: string } | { key: string })[] = [];
  const found = new Set();
  let literal = '';
  for (let i = 0; i < value.length;) {
    if (value.slice(i, i + 2) === '{{' || value.slice(i, i + 2) === '}}') {
      literal += value[i];
      i += 2;
      continue;
    }
    if (value[i] === '}') throw new Error('invalid_template');
    if (value[i] !== '{') {
      literal += value[i++];
      continue;
    }
    const end = value.indexOf('}', i + 1);
    const key = value.slice(i + 1, end);
    if (end < 0 || !allowed.includes(key)) throw new Error('invalid_template');
    if (literal) {
      parts.push({ literal });
      literal = '';
    }
    parts.push({ key });
    found.add(key);
    i = end + 1;
  }
  if (literal) parts.push({ literal });
  if (required.some((key) => !found.has(key)))
    throw new Error('invalid_template');
  return parts;
}
export function expandTemplate(
  template: string,
  values: Record<string, string | null | undefined>,
) {
  return templateParts(template, Object.keys(values))
    .map((p) => ('literal' in p ? p.literal : values[p.key]))
    .join('');
}
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, sort(x)]),
      );
    return v;
  };
  return JSON.stringify(sort(value));
}
