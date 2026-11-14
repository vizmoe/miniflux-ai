import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseConfig, redactConfig } from '../src/config/index.js';
import { argumentsOf } from '../src/config/cli.js';
import {
  canonicalLanguage,
  durationMs,
  expandTemplate,
  normalizeBaseUrl,
  parseInstant,
  templateParts,
} from '../src/config/primitives.js';
import { DEFAULT_PROMPTS } from '../src/config/prompts.js';
import { evaluateScope, scopeSchema } from '../src/config/scope.js';
import { compact, config, fixtureValues } from './helpers.js';

describe('configuration contract', () => {
  it('loads schema defaults and the provider-setup example', () => {
    const c = config();
    expect(c.output_language).toBe('zh-CN');
    expect(c.queue.worker_concurrency).toBe(4);
    expect(c.features.digest.jobs).toEqual([]);
    expect(c.features.translation.scope).toEqual({
      fallback_action: 'allow',
      rules: [],
    });
    expect(c.prompts).toEqual(DEFAULT_PROMPTS);
    const example = parseConfig(readFileSync('config.example.yaml', 'utf8'));
    expect(example.ai.providers).toEqual([]);
    expect(example.ingestion.webhook.enabled).toBe(false);
    Object.assign(example.miniflux, {
      base_url: fixtureValues.miniflux_url,
      api_key: fixtureValues.miniflux_key,
    });
    example.ai.providers = c.ai.providers;
    example.server.admin_token = fixtureValues.admin_token;
    example.ingestion.webhook = c.ingestion.webhook;
    expect(parseConfig(stringify(example))).toEqual(c);
  });
  it('preserves literal prompt expressions', () => {
    expect(
      config('prompts:\n  summary: Explain ${HOME}\n').prompts.summary,
    ).toBe('Explain ${HOME}');
  });
  it.each([
    ['server.port', 'server:\n  port: "8080"'],
    ['queue.retry.multiplier', 'queue:\n  retry:\n    multiplier: "2.5"'],
    ['runtime.allow_insecure_http', 'runtime:\n  allow_insecure_http: "true"'],
    [
      'features.translation.enabled',
      'features:\n  translation:\n    enabled: "false"',
    ],
    ['miniflux.web_url', 'miniflux:\n  web_url: "null"'],
    [
      'features.summary.schedule.cron',
      'features:\n  summary:\n    schedule:\n      cron: "null"',
    ],
  ])('requires native YAML scalar types for %s', (path, yaml) => {
    expect(() => config(yaml)).toThrow(path);
  });
  it('accepts native YAML scalars and preserves strings literally', () => {
    const parsed = config(
      'server:\n  port: 8081\n  admin_token: "null"\nqueue:\n  retry:\n    multiplier: 2.5\nfeatures:\n  translation:\n    enabled: false\nminiflux:\n  web_url: null\n',
    );
    expect(parsed.server.port).toBe(8081);
    expect(parsed.server.admin_token).toBe('null');
    expect(parsed.queue.retry.multiplier).toBe(2.5);
    expect(parsed.features.translation.enabled).toBe(false);
    expect(parsed.miniflux.web_url).toBeNull();
  });
  it('accepts only an optional configuration file argument', () => {
    expect(argumentsOf([])).toEqual({ path: './config.yaml' });
    expect(argumentsOf(['--config', '/tmp/example.yaml'])).toEqual({
      path: '/tmp/example.yaml',
    });
    for (const args of [['--config'], ['--unexpected'], ['example.yaml']])
      expect(() => argumentsOf(args)).toThrow('command_line');
  });
  it.each(['0 2 * * *', '0-0 2-2 * * *', '0/60 2/24 * * *'])(
    'accepts a Digest cron with one fixed UTC time: %s',
    (cron) => {
      const c = config(
        `features:\n  digest:\n    public_base_url: https://digest.test\n    jobs:\n      - id: daily\n        cron: '${cron}'\n        output:\n          feed_title_template: Daily`,
      );
      expect(c.features.digest.jobs[0]!.cron).toBe(cron);
    },
  );
  it.each([
    'logging:\n  level: trace',
    'storage:\n  backend: memory',
    'ai:\n  max_split_depth: 9',
    'prompts: null',
    'prompts:\n  summary: " "',
    'features:\n  translation:\n    title_template: "{translated}"',
    'features:\n  summary:\n    schedule:\n      cron: "0 0 2 * * *"',
    'features:\n  summary:\n    schedule:\n      cron: "0 0 2 * * * 2026"',
    'queue:\n  worker_concurrency: 1',
    'queue:\n  retry:\n    initial_delay: 2h\n    max_delay: 1h',
  ])('rejects invalid or undocumented controls: %s', (yaml) =>
    expect(() => config(yaml)).toThrow(),
  );
  it('does not expose secrets in configuration errors or redacted admin data', () => {
    expect(() => config('miniflux:\n  api_key: ${MISSING}')).toThrow(
      'miniflux.api_key',
    );
    const redacted = JSON.stringify(redactConfig(config()));
    for (const secret of [
      fixtureValues.ai_key,
      fixtureValues.miniflux_key,
      fixtureValues.webhook_secret,
      fixtureValues.admin_token,
    ])
      expect(redacted).not.toContain(secret);
  });
  it('enforces conditional webhook, HTTPS, Digest and template requirements', () => {
    expect(() => config('ingestion:\n  webhook:\n    secret: null')).toThrow();
    expect(
      config('ingestion:\n  webhook:\n    enabled: false').ingestion.webhook
        .enabled,
    ).toBe(false);
    const insecure = config();
    insecure.ai.providers[0]!.base_url = 'http://api.test';
    expect(() => parseConfig(stringify(insecure))).toThrow(
      'ai.providers.0.base_url',
    );
    insecure.runtime.allow_insecure_http = true;
    expect(parseConfig(stringify(insecure)).ai.providers[0]!.base_url).toBe(
      'http://api.test',
    );
    for (const cron of ['* 2 * * *', '0 2,3 * * *', '0 */2 * * *'])
      expect(() =>
        config(
          `features:\n  digest:\n    public_base_url: https://digest.test\n    jobs:\n      - id: daily\n        cron: '${cron}'\n        output:\n          feed_title_template: Daily`,
        ),
      ).toThrow();
    const job = `features:\n  digest:\n    public_base_url: https://digest.test\n    jobs:\n      - id: daily\n        cron: '0 2 * * *'\n        output:\n          partition_by: category\n          feed_title_template: '{category_title}'`;
    expect(config(job).features.digest.jobs[0]!.lookback).toBe('24h');
    expect(() => config(job.replace("'{category_title}'", 'Daily'))).toThrow();
  });
});
describe('pure configuration primitives', () => {
  it.each([
    ['https://EXAMPLE.com:443/path/', 'https://example.com/path'],
    ['https://example.com/', 'https://example.com'],
  ])('normalizes %s', (input, expected) =>
    expect(normalizeBaseUrl(input)).toBe(expected),
  );
  it.each([
    'https://user:password@host.test',
    'ftp://host.test',
    'https://host.test/?a=1',
    'https://host.test/#x',
  ])('rejects unsafe base URLs: %s', (value) =>
    expect(() => normalizeBaseUrl(value)).toThrow(),
  );
  it('expands templates once and enforces escaped brace grammar', () => {
    expect(
      expandTemplate('{{{original}}} {translated}', {
        original: '{translated}',
        translated: '译文',
      }),
    ).toBe('{{translated}} 译文');
    for (const v of ['{wrong}', '{original', 'original}', '{{original}}'])
      expect(() => templateParts(v, ['original'], ['original'])).toThrow();
  });
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-09-04',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:00+24:00',
  ])('requires a real offset-bearing timestamp: %s', (v) =>
    expect(() => parseInstant(v)).toThrow(),
  );
  it('keeps UTC millisecond precision and primary language semantics', () => {
    expect(parseInstant('2026-09-04T03:02:01.12345+03:00')).toBe(
      Date.parse('2026-09-04T00:02:01.123Z'),
    );
    expect(durationMs('24h')).toBe(86400000);
    expect(canonicalLanguage('zh-hans-cn')).toBe('zh-Hans-CN');
    expect(() => durationMs('1.5h')).toThrow();
  });
});
describe('ordered scopes', () => {
  it('uses first-match AND predicates and captured fields', () => {
    const scope = scopeSchema.parse({
      fallback_action: 'deny',
      rules: [
        {
          name: 'first',
          action: 'allow',
          match: {
            feed_ids: [1, 1],
            category_ids: [7],
            feed_url_regex: 'source',
            site_url_regex: 'source',
            title_regex: 'interesting',
            entry_url_regex: '/1$',
            author_regex: '^Author$',
            primary_languages: ['EN'],
            min_source_units: 2500,
          },
        },
        { name: 'second', action: 'deny', match: { feed_ids: [1] } },
      ],
    });
    expect(scope.rules[0]!.match.feed_ids).toEqual([1]);
    expect(evaluateScope(scope, compact())).toEqual({
      action: 'allow',
      matchedRule: 'first',
    });
    expect(
      evaluateScope(scope, compact(1, { primary_language: null })),
    ).toEqual({ action: 'deny', matchedRule: 'second' });
  });
  it.each([
    {},
    { feed_ids: [] },
    { category_ids: [0] },
    { primary_languages: ['en-US'] },
    { title_regex: '[' },
    { min_source_units: -1 },
    { author_regex: null },
  ])('rejects invalid predicates %j', (match) =>
    expect(() =>
      scopeSchema.parse({ rules: [{ name: 'rule', action: 'allow', match }] }),
    ).toThrow(),
  );
});
