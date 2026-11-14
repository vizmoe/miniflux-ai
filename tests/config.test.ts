import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  ConfigurationError,
  parseConfig,
  redactConfig,
} from '../src/config/index.js';
import { expandTemplate, parseInstant } from '../src/config/primitives.js';
import { evaluateScope, scopeSchema } from '../src/config/scope.js';

const input = {
  miniflux: {
    base_url: 'https://feeds.example.test/',
    api_key: 'miniflux-test-key',
  },
  ai: {
    providers: [
      {
        id: 'primary',
        base_url: 'https://ai.example.test/v1/',
        api_key: 'ai-test-key',
        model: 'test-model',
      },
    ],
  },
  ingestion: { webhook: { secret: 'webhook-test-secret' } },
};

describe('configuration compatibility', () => {
  it('normalizes endpoints, supplies nested defaults and keeps secrets out of views', () => {
    const config = parseConfig(stringify(input));
    expect(config.miniflux.base_url).toBe('https://feeds.example.test');
    expect(config.ai.providers[0].base_url).toBe('https://ai.example.test/v1');
    expect(config.queue.retry.max_attempts).toBe(8);
    expect(config.features.translation.title_template).toBe(
      '{translated}（{original}）',
    );
    const redacted = JSON.stringify(redactConfig(config));
    for (const secret of [
      input.miniflux.api_key,
      input.ai.providers[0].api_key,
      input.ingestion.webhook.secret,
    ])
      expect(redacted).not.toContain(secret);
    expect(config.miniflux.api_key).toBe('miniflux-test-key');
  });

  it('rejects unknown keys, duplicate YAML keys and insecure upstreams', () => {
    expect(() => parseConfig(stringify({ ...input, typo: true }))).toThrow(
      ConfigurationError,
    );
    expect(() => parseConfig('miniflux: {}\nminiflux: {}')).toThrow(
      ConfigurationError,
    );
    expect(() =>
      parseConfig(
        stringify({
          ...input,
          miniflux: { ...input.miniflux, base_url: 'http://feeds.test' },
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(
        stringify({
          ...input,
          runtime: { allow_insecure_http: true },
          miniflux: { ...input.miniflux, base_url: 'http://feeds.test' },
        }),
      ),
    ).not.toThrow();
  });

  it('supports admin bootstrap without a configured AI provider', () => {
    expect(() =>
      parseConfig(stringify({ ...input, ai: { providers: [] } })),
    ).toThrow(ConfigurationError);
    expect(
      parseConfig(
        stringify({
          ...input,
          ai: { providers: [] },
          server: { admin_token: 'admin-test-token' },
        }),
      ).ai.providers,
    ).toEqual([]);
  });

  it('validates digest schedules and required public URLs', () => {
    const job = {
      id: 'daily',
      cron: '0 8 * * *',
      output: { feed_title_template: 'Daily' },
    };
    expect(() =>
      parseConfig(
        stringify({ ...input, features: { digest: { jobs: [job] } } }),
      ),
    ).toThrow(ConfigurationError);
    const digest = {
      public_base_url: 'https://digest.example.test',
      jobs: [job],
    };
    expect(() =>
      parseConfig(stringify({ ...input, features: { digest } })),
    ).not.toThrow();
    expect(() =>
      parseConfig(
        stringify({
          ...input,
          features: {
            digest: { ...digest, jobs: [{ ...job, cron: '* * * * *' }] },
          },
        }),
      ),
    ).toThrow(ConfigurationError);
  });
});

it('expands only the template grammar and validates real dates', () => {
  expect(
    expandTemplate('{{original}} {translated} {original}', {
      translated: '{original}',
      original: 'Source',
    }),
  ).toBe('{original} {original} Source');
  expect(() => parseInstant('2026-02-30T00:00:00Z')).toThrow('invalid_instant');
  expect(parseInstant('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
});

it('evaluates scope rules in order with conjunctive predicates', () => {
  const scope = scopeSchema.parse({
    fallback_action: 'deny',
    rules: [
      {
        name: 'blocked',
        action: 'deny',
        match: { title_regex: 'Advertisement' },
      },
      {
        name: 'science',
        action: 'allow',
        match: { category_ids: [3], min_source_units: 20 },
      },
    ],
  });
  const entry = {
    feed_id: 2,
    category_id: 3,
    source_feed_url: '',
    source_feed_site_url: '',
    entry_url: '',
    source_title: 'Science news',
    source_author: '',
    primary_language: 'en',
    source_content_units: 100,
  };
  expect(evaluateScope(scope, entry)).toEqual({
    action: 'allow',
    matchedRule: 'science',
  });
  expect(
    evaluateScope(scope, { ...entry, source_title: 'Advertisement' }),
  ).toEqual({ action: 'deny', matchedRule: 'blocked' });
  expect(evaluateScope(scope, { ...entry, source_content_units: 2 })).toEqual({
    action: 'deny',
    matchedRule: null,
  });
});
