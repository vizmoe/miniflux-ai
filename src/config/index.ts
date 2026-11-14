import { readFileSync } from 'node:fs';
import { ConfigurationError } from './errors.js';
export { ConfigurationError } from './errors.js';
import { Cron } from 'croner';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { DIGEST_JOB_ID_PATTERN } from './constants.js';
import {
  canonicalLanguage,
  durationMs,
  languageIdentity,
  nonempty,
  normalizeBaseUrl,
  safeId,
  templateParts,
} from './primitives.js';
import { DEFAULT_PROMPTS } from './prompts.js';
import { scopeSchema } from './scope.js';

function transformString(fn: (v: string) => string) {
  return z.string().transform((v, ctx) => {
    try {
      return fn(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid value' });
      return z.NEVER;
    }
  });
}
const url = z.string().max(2048).pipe(transformString(normalizeBaseUrl));
const language = transformString(canonicalLanguage);
const number = (min: number, max = Number.MAX_SAFE_INTEGER, integer = true) =>
  integer ? z.int().min(min).max(max) : z.number().min(min).max(max);
const boolean = z.boolean();
const nullable = <T extends z.ZodType>(type: T) => type.nullable();
const duration = z.string().refine((v) => {
  try {
    durationMs(v);
    return true;
  } catch {
    return false;
  }
});
function cronRange(item: string, max: number): [number, number, number] | null {
  const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
  if (!match) return null;
  const step = Number(match[2] ?? 1);
  let start: number, end: number;
  if (match[1] === '*') [start, end] = [0, max];
  else if (match[1]!.includes('-'))
    [start, end] = match[1]!.split('-').map(Number) as [number, number];
  else {
    start = Number(match[1]);
    end = match[2] ? max : start;
  }
  if (!step || start > end || end > max) return null;
  return [start, end, step];
}
function singletonCronField(field: string, max: number): boolean {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const range = cronRange(item, max);
    if (!range) return false;
    const [start, end, step] = range;
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values.size === 1;
}
function cronSchema(digest = false) {
  return z.string().refine((v) => {
    const fields = v.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    try {
      const cron = new Cron(v, {
        timezone: 'UTC',
        paused: true,
        mode: '5-part',
        // Retain numeric-start steps accepted by the existing configuration contract.
        sloppyRanges: true,
      });
      cron.stop();
      // Digest jobs must expand to exactly one minute and hour, including ranges and steps.
      return (
        !digest ||
        (singletonCronField(fields[0]!, 59) &&
          singletonCronField(fields[1]!, 23))
      );
    } catch {
      return false;
    }
  });
}
const template = (allowed: string[], required: string[]) =>
  nonempty.refine((v) => {
    try {
      templateParts(v, allowed, required);
      return true;
    } catch {
      return false;
    }
  });
// Parse defaults through their schemas so nested defaults and refinements also run.
export const retryConfigSchema = z
  .object({
    initial_delay: duration.prefault('10s'),
    multiplier: number(1, Number.MAX_VALUE, false).prefault(2),
    max_delay: duration.prefault('1h'),
    jitter_ratio: number(0, 1, false).prefault(0.2),
    max_attempts: number(1).prefault(8),
  })
  .strict()
  .refine((v) => durationMs(v.max_delay) >= durationMs(v.initial_delay));
const digestJobSchema = z
  .object({
    id: z.string().regex(DIGEST_JOB_ID_PATTERN),
    output: z
      .object({
        partition_by: z.enum(['all', 'category']).prefault('all'),
        feed_title_template: nonempty,
        destination_category_id: nullable(safeId).prefault(null),
        existing_feed_id: nullable(safeId).prefault(null),
      })
      .strict(),
    cron: cronSchema(true),
    lookback: duration.prefault('24h'),
    max_entries: number(1).prefault(120),
    max_entries_per_feed: number(1).prefault(10),
    max_item_summary_units: number(1).prefault(60),
    min_item_source_units: number(0).prefault(200),
    include_feed_site_url: boolean.prefault(true),
    entry_title_template: nonempty.prefault('AI Digest — {date}'),
    scope: scopeSchema.prefault({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    const cat = v.output.partition_by === 'category';
    try {
      templateParts(
        v.output.feed_title_template,
        ['job_id', ...(cat ? ['category_title', 'category_key'] : [])],
        cat ? ['category_title'] : [],
      );
      templateParts(
        v.entry_title_template,
        ['job_id', 'date', ...(cat ? ['category_title', 'category_key'] : [])],
        ['date'],
      );
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'invalid template',
        path: ['output'],
      });
    }
    if (cat && v.output.existing_feed_id !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['output', 'existing_feed_id'],
        message: 'all partitions only',
      });
  });

const secret = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => v.trim().length > 0)
  .refine((v) => !/[\r\n]/.test(v) && !/\$\{[^}]+\}/.test(v));
export const providerSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    enabled: boolean.prefault(true),
    priority: number(0).prefault(0),
    base_url: url.refine((v) => !v.endsWith('/chat/completions')),
    api_key: secret,
    model: nonempty.refine((v) => v.length <= 256),
    request_timeout_ms: number(1, 600000).prefault(180000),
  })
  .strict();
export const aiConfigSchema = z
  .object({
    providers: z.array(providerSchema).max(32).prefault([]),
    max_concurrent_requests: number(1).prefault(4),
    failover: z
      .object({
        cooldown: duration.prefault('5m'),
        failure_threshold: number(1, 100).prefault(2),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .refine(
    (v) => new Set(v.providers.map((p) => p.id)).size === v.providers.length,
    { message: 'duplicate_provider_id', path: ['providers'] },
  );
export type AiProvider = z.infer<typeof providerSchema>;
export type AiConfiguration = z.infer<typeof aiConfigSchema>;

export const configSchema = z
  .object({
    output_language: language.prefault('zh-CN'),
    miniflux: z
      .object({
        base_url: url,
        web_url: nullable(url).prefault(null),
        api_key: secret,
        request_timeout_ms: number(1).prefault(20000),
        max_requests_per_second: number(
          Number.MIN_VALUE,
          Number.MAX_VALUE,
          false,
        ).prefault(5),
        max_concurrent_requests: number(1).prefault(4),
      })
      .strict(),
    ai: aiConfigSchema.prefault({}),
    server: z
      .object({
        bind_address: nonempty.prefault('0.0.0.0'),
        port: number(1, 65535).prefault(8080),
        admin_token: nullable(secret).prefault(null),
        admin_origin: nullable(
          url.refine((v) => new URL(v).pathname === '/'),
        ).prefault(null),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).prefault('info'),
      })
      .strict()
      .prefault({}),
    ingestion: z
      .object({
        webhook: z
          .object({
            enabled: boolean.prefault(true),
            secret: secret.optional(),
          })
          .strict()
          .prefault({}),
        polling: z
          .object({
            interval: duration.prefault('5m'),
            page_size: number(1, 1000).prefault(100),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    queue: z
      .object({
        worker_concurrency: number(2).prefault(4),
        lease_duration: duration.prefault('5m'),
        retry: retryConfigSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    runtime: z
      .object({
        shutdown_grace_period: duration.prefault('30s'),
        allow_insecure_http: boolean.prefault(false),
      })
      .strict()
      .prefault({}),
    features: z
      .object({
        translation: z
          .object({
            enabled: boolean.prefault(true),
            target_language: nullable(language).prefault(null),
            skip_languages: z
              .string()
              .prefault('')
              .refine((v) => {
                if (v === '') return true;
                try {
                  v.split(',').forEach((s) => languageIdentity(s.trim()));
                  return true;
                } catch {
                  return false;
                }
              }),
            title_template: template(
              ['translated', 'original'],
              ['translated', 'original'],
            ).prefault('{translated}（{original}）'),
            scope: scopeSchema.prefault({}),
          })
          .strict()
          .prefault({}),
        summary: z
          .object({
            enabled: boolean.prefault(true),
            heading: nonempty.prefault('AI 摘要'),
            format: z.enum(['paragraph', 'bullets']).prefault('paragraph'),
            max_output_units: number(1).prefault(600),
            min_source_units: number(1).prefault(2000),
            schedule: z
              .object({ cron: nullable(cronSchema()).prefault(null) })
              .strict()
              .prefault({}),
            scope: scopeSchema.prefault({}),
          })
          .strict()
          .prefault({}),
        digest: z
          .object({
            enabled: boolean.prefault(true),
            public_base_url: nullable(url).prefault(null),
            jobs: z.array(digestJobSchema).prefault([]),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    prompts: z
      .object({
        translation: nonempty.prefault(DEFAULT_PROMPTS.translation),
        summary: nonempty.prefault(DEFAULT_PROMPTS.summary),
        digest: z
          .object({
            item_summary: nonempty.prefault(
              DEFAULT_PROMPTS.digest.item_summary,
            ),
            overview: nonempty.prefault(DEFAULT_PROMPTS.digest.overview),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: string[]) =>
      ctx.addIssue({
        code: 'custom',
        path,
        message: 'conditional requirement failed',
      });
    if (v.ingestion.webhook.enabled && !v.ingestion.webhook.secret)
      issue(['ingestion', 'webhook', 'secret']);
    if (!v.server.admin_token && !v.ai.providers.some((p) => p.enabled))
      issue(['ai', 'providers']);
    const digest = v.features.digest;
    if (digest.enabled && digest.jobs.length && !digest.public_base_url)
      issue(['features', 'digest', 'public_base_url']);
    if (new Set(digest.jobs.map((j) => j.id)).size !== digest.jobs.length)
      issue(['features', 'digest', 'jobs']);
    const feeds = digest.jobs
      .map((j) => j.output.existing_feed_id)
      .filter((v) => v !== null);
    if (new Set(feeds).size !== feeds.length)
      issue(['features', 'digest', 'jobs']);
    if (!v.runtime.allow_insecure_http)
      for (const [path, value] of [
        ['miniflux.base_url', v.miniflux.base_url],
        ['miniflux.web_url', v.miniflux.web_url],
        ...v.ai.providers.map(
          (p, index) => [`ai.providers.${index}.base_url`, p.base_url] as const,
        ),
      ] as const) {
        if (value?.startsWith('http:')) issue(path.split('.'));
      }
  });
export type Config = z.infer<typeof configSchema>;
export type DigestJob = Config['features']['digest']['jobs'][number];

export function parseConfig(yamlText = ''): Config {
  let data: unknown;
  try {
    const document = parseDocument(yamlText, { uniqueKeys: true });
    if (document.errors.length) throw new Error('invalid_yaml_document');
    data = document.toJS({ maxAliasCount: 20 }) ?? {};
  } catch {
    throw new ConfigurationError(['config.yaml']);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success)
    throw new ConfigurationError([
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'config')),
    ]);
  return parsed.data;
}
export function loadConfig(path = './config.yaml'): Config {
  let yaml: string;
  try {
    yaml = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigurationError(['config.yaml']);
  }
  return parseConfig(yaml);
}
export function redactConfig(config: Config): unknown {
  const copy = structuredClone(config);
  copy.miniflux.api_key = '[REDACTED]';
  for (const provider of copy.ai.providers) provider.api_key = '[REDACTED]';
  if (copy.ingestion.webhook.secret)
    copy.ingestion.webhook.secret = '[REDACTED]';
  if (copy.server.admin_token) copy.server.admin_token = '[REDACTED]';
  return copy;
}
