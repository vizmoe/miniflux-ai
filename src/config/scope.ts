import { z } from 'zod';
import { nonempty, nonnegative, safeId } from './primitives.js';
import type { Config } from './index.js';

const regex = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
});
const ids = z
  .array(safeId)
  .nonempty()
  .transform((v) => [...new Set(v)].sort((a, b) => a - b));
export const primarySubtag = z
  .string()
  .regex(/^[A-Za-z]{2,8}$/)
  .refine((v) => {
    try {
      Intl.getCanonicalLocales(v);
      return true;
    } catch {
      return false;
    }
  })
  .transform((v) => v.toLowerCase());
export const scopeMatchSchema = z
  .object({
    feed_ids: ids.optional(),
    category_ids: ids.optional(),
    feed_url_regex: regex.optional(),
    site_url_regex: regex.optional(),
    entry_url_regex: regex.optional(),
    title_regex: regex.optional(),
    author_regex: regex.optional(),
    primary_languages: z
      .array(primarySubtag)
      .nonempty()
      .transform((v) => [...new Set(v)])
      .optional(),
    min_source_units: nonnegative.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const scopeSchema = z
  .object({
    fallback_action: z.enum(['allow', 'deny']).prefault('allow'),
    rules: z
      .array(
        z
          .object({
            name: nonempty,
            action: z.enum(['allow', 'deny']),
            match: scopeMatchSchema,
          })
          .strict(),
      )
      .prefault([]),
  })
  .strict()
  .refine((v) => new Set(v.rules.map((r) => r.name)).size === v.rules.length);
export type Scope = z.infer<typeof scopeSchema>;
export function scopeLocation(config: Config, target: string) {
  if (target === 'translation' || target === 'summary')
    return {
      owner: config.features[target],
      path: ['features', target, 'scope'] as Array<string | number>,
    };
  if (!target.startsWith('digest:')) return undefined;
  const index = config.features.digest.jobs.findIndex(
    (job) => job.id === target.slice('digest:'.length),
  );
  if (index < 0) return undefined;
  return {
    owner: config.features.digest.jobs[index]!,
    path: ['features', 'digest', 'jobs', index, 'scope'] as Array<
      string | number
    >,
  };
}
export interface ScopeEntry {
  feed_id: number;
  category_id: number;
  source_feed_url: string;
  source_feed_site_url: string;
  entry_url: string;
  source_title: string;
  source_author: string;
  primary_language: string | null;
  source_content_units: number;
}

export function evaluateScope(
  scope: Scope,
  entry: ScopeEntry,
): { action: 'allow' | 'deny'; matchedRule: string | null } {
  const regexFields = {
    feed_url_regex: 'source_feed_url',
    site_url_regex: 'source_feed_site_url',
    entry_url_regex: 'entry_url',
    title_regex: 'source_title',
    author_regex: 'source_author',
  } as const;
  for (const rule of scope.rules) {
    const m = rule.match;
    if (m.feed_ids && !m.feed_ids.includes(entry.feed_id)) continue;
    if (m.category_ids && !m.category_ids.includes(entry.category_id)) continue;
    if (
      m.primary_languages &&
      (!entry.primary_language ||
        !m.primary_languages.includes(entry.primary_language))
    )
      continue;
    if (
      m.min_source_units !== undefined &&
      entry.source_content_units < m.min_source_units
    )
      continue;
    if (
      Object.entries(regexFields).some(([key, field]) => {
        const pattern = m[key as keyof typeof regexFields];
        return pattern !== undefined && !new RegExp(pattern).test(entry[field]);
      })
    )
      continue;
    return { action: rule.action, matchedRule: rule.name };
  }
  return { action: scope.fallback_action, matchedRule: null };
}
