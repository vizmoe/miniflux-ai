import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { YamlConfiguration } from '../src/config/store.js';
import type { AiProvider, Config } from '../src/config/index.js';
import { parseConfig } from '../src/config/index.js';
import { Database } from '../src/db/database.js';
import { Repository } from '../src/db/repository.js';
import type { CompactEntry } from '../src/db/repository.js';
import { createService } from '../src/runtime/service.js';
import { buildServer } from '../src/server/index.js';
import { sanitize } from '../src/html/minifluxSanitizer.js';
import type { Envelope } from '../src/ai/protocol.js';

export const fixtureValues = {
  miniflux_url: 'https://miniflux.test',
  miniflux_key: 'test-miniflux-credential',
  webhook_secret: 'test-webhook-credential',
  ai_url: 'https://ai.test/v1',
  ai_key: 'test-ai-credential',
  model: 'test-model',
  admin_token: 'test-admin-credential',
};
const defaults = {
  miniflux: {
    base_url: fixtureValues.miniflux_url,
    api_key: fixtureValues.miniflux_key,
  },
  ingestion: { webhook: { secret: fixtureValues.webhook_secret } },
  server: { admin_token: fixtureValues.admin_token },
  ai: {
    providers: [
      {
        id: 'primary',
        priority: 100,
        base_url: fixtureValues.ai_url,
        api_key: fixtureValues.ai_key,
        model: fixtureValues.model,
      },
    ],
  },
};
function merge(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(extra))
    result[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
        ? merge(
            result[key] as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  return result;
}
export const config = (yaml = '') =>
  parseConfig(stringify(merge(defaults, parse(yaml) ?? {})));
export function writeConfiguration(
  root: string,
  config: Config,
): YamlConfiguration {
  const path = join(root, 'config.yaml');
  writeFileSync(path, stringify(config), { mode: 0o600 });
  return new YamlConfiguration(path);
}
export function aiConfig(api_key = 'key', values: Partial<AiProvider> = {}) {
  const ai = config().ai;
  ai.providers = [{ ...ai.providers[0]!, api_key, ...values }];
  return ai;
}
export function compact(
  id = 1,
  overrides: Partial<CompactEntry> = {},
): CompactEntry {
  return {
    entry_id: id,
    feed_id: 1,
    category_id: 7,
    entry_url: `https://source.test/${id}`,
    published_at: Date.parse('2026-09-03T12:00:00Z'),
    source_author: 'Author',
    source_feed_title: 'Feed',
    source_feed_url: 'https://source.test/feed',
    source_feed_site_url: 'https://source.test',
    source_category_title: 'News',
    source_title: 'An interesting entry',
    source_content_units: 2500,
    primary_language: 'en',
    language_confidence: 1,
    ...overrides,
  };
}
export function temporaryRepository(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), 'mfai-test-')),
    db = new Database(root),
    repository = new Repository(db, now);
  return {
    root,
    db,
    repository,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export const feed = (id = 1, category = 7) => ({
  id,
  title: `Feed ${id}`,
  feed_url: `https://source.test/feed/${id}`,
  site_url: 'https://source.test',
  category: { id: category, title: `Category ${category}` },
});
export const entry = (
  id = 1,
  content = '<p>A useful introduction to software design and reliable service operation.</p>',
  feedId = 1,
  category = 7,
) => ({
  id,
  feed_id: feedId,
  title: 'An interesting entry',
  content,
  url: `https://source.test/${id}`,
  author: 'Author',
  published_at: '2026-09-03T12:00:00Z',
  feed: feed(feedId, category),
});
export type UpstreamEntry = ReturnType<typeof entry>;
export const response = (
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response =>
  new Response(
    status === 204
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );
export function generated(envelope: Envelope): unknown {
  if (envelope.operation === 'detect_language')
    return { parts: envelope.parts.map(({ id }) => ({ id, code: 'und' })) };
  if (envelope.operation === 'generate_artifacts')
    return {
      ...(envelope.requested_outputs.translation
        ? {
            translation: {
              ...(envelope.requested_outputs.translation.title_requested
                ? { title: '译文标题' }
                : {}),
              blocks: envelope.source.blocks.map((b) => ({
                id: b.id,
                text: '完整的译文内容。',
              })),
            },
          }
        : {}),
      ...(envelope.requested_outputs.summary
        ? {
            summary:
              envelope.requested_outputs.summary.format === 'paragraph'
                ? { format: 'paragraph', text: '文章摘要。' }
                : { format: 'bullets', items: ['文章摘要。'] },
          }
        : {}),
    };
  if (envelope.operation === 'repair_translation')
    return {
      translation: {
        ...(envelope.repair_targets.title_requested
          ? { title: '修复的标题' }
          : {}),
        blocks: envelope.source.blocks.map((b) => ({
          id: b.id,
          text: '修复的译文。',
        })),
      },
    };
  if (
    envelope.operation === 'repair_summary' ||
    envelope.operation === 'merge_summary_partials'
  )
    return {
      summary:
        envelope.requested_output.format === 'paragraph'
          ? { format: 'paragraph', text: '合并摘要。' }
          : { format: 'bullets', items: ['合并摘要。'] },
    };
  if (
    envelope.operation === 'generate_digest_item' ||
    envelope.operation === 'merge_digest_item_partials'
  )
    return { summary: '简短摘要。' };
  const ids =
    envelope.operation === 'generate_digest_overview'
      ? envelope.items.map((i) => i.id)
      : envelope.partials.flatMap((p) => p.sections.flatMap((s) => s.item_ids));
  return {
    overview: '本期内容概览。',
    sections: [{ title: '要闻', item_ids: ids }],
  };
}
export function chat(body: unknown, finish = 'stop'): Response {
  return response({
    choices: [
      {
        finish_reason: finish,
        message: {
          content: typeof body === 'string' ? body : JSON.stringify(body),
        },
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  });
}
export class FakeUpstream {
  entries = new Map<number, UpstreamEntry>();
  feeds = new Map<number, ReturnType<typeof feed>>([[1, feed()]]);
  categories = new Map<number, { id: number; title: string }>();
  requests: Array<{
    method: string;
    url: URL;
    body: unknown;
    headers: Headers;
  }> = [];
  aiInputs: Envelope[] = [];
  languageInputs: Extract<Envelope, { operation: 'detect_language' }>[] = [];
  languageHandler?: (
    envelope: Extract<Envelope, { operation: 'detect_language' }>,
  ) => Response | Promise<Response>;
  imports = new Map<string, number>();
  version = '2.3.3';
  userId = 1;
  puts = 0;
  nextId = 10000;
  aiHandler?: (
    envelope: Envelope,
    index: number,
  ) => Response | Promise<Response>;
  intercept?: (
    url: URL,
    method: string,
    body: unknown,
  ) => Response | undefined | Promise<Response | undefined>;
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({
      method,
      url,
      body,
      headers: new Headers(init?.headers),
    });
    init?.signal?.throwIfAborted();
    const custom = await this.intercept?.(url, method, body);
    if (custom) return custom;
    if (url.pathname === '/v1/chat/completions') {
      const request = body as { messages: Array<{ content: string }> };
      const envelope = JSON.parse(request.messages[1]!.content) as Envelope;
      if (envelope.operation === 'detect_language') {
        this.languageInputs.push(envelope);
        return this.languageHandler
          ? this.languageHandler(envelope)
          : chat(generated(envelope));
      }
      this.aiInputs.push(envelope);
      return this.aiHandler
        ? this.aiHandler(envelope, this.aiInputs.length)
        : chat(generated(envelope));
    }
    if (url.pathname === '/v1/version')
      return response({ version: this.version, future: true });
    if (url.pathname === '/v1/me')
      return response({
        id: this.userId,
        username: 'mutable-user',
        additive: true,
      });
    if (url.pathname === '/v1/entries') {
      const after = Number(url.searchParams.get('after_entry_id') ?? 0),
        limit = Number(url.searchParams.get('limit'));
      const entries = [...this.entries.values()]
        .filter((e) => e.id > after)
        .sort((a, b) =>
          url.searchParams.get('direction') === 'desc'
            ? b.id - a.id
            : a.id - b.id,
        )
        .slice(0, limit);
      return response({ entries, total: entries.length, future: true });
    }
    const entryId = /^\/v1\/entries\/(\d+)$/.exec(url.pathname);
    if (entryId) {
      const e = this.entries.get(Number(entryId[1]));
      if (!e) return response({}, 404);
      if (method === 'PUT') {
        this.puts++;
        const update = body as { title?: string; content?: string };
        if (update.title === '' || update.content === '')
          return response(
            { error_message: 'Entry fields cannot be empty' },
            400,
          );
        if (update.title !== undefined) e.title = update.title;
        if (update.content !== undefined)
          e.content = sanitize(update.content, e.url);
        return response(e, 201);
      }
      return response(e);
    }
    if (url.pathname === '/v1/feeds' && method === 'POST') {
      const input = body as { feed_url: string; category_id?: number },
        id = ++this.nextId;
      this.feeds.set(id, {
        ...feed(id, input.category_id ?? 1),
        feed_url: input.feed_url,
      });
      return response({ feed_id: id }, 201);
    }
    if (url.pathname === '/v1/feeds') return response([...this.feeds.values()]);
    if (url.pathname === '/v1/categories')
      return response([
        ...new Map([
          ...[...this.feeds.values()].map(
            (feed) => [feed.category.id, feed.category] as const,
          ),
          ...this.categories,
        ]).values(),
      ]);
    const importPath = /^\/v1\/feeds\/(\d+)\/entries\/import$/.exec(
      url.pathname,
    );
    if (importPath) {
      const imported = body as {
        external_id: string;
        published_at: number;
        content: string;
        title: string;
        url: string;
      };
      if (typeof imported.published_at !== 'number') return response({}, 400);
      const exists = this.imports.get(imported.external_id),
        id = exists ?? ++this.nextId;
      this.imports.set(imported.external_id, id);
      this.entries.set(id, {
        ...entry(
          id,
          sanitize(imported.content, imported.url),
          Number(importPath[1]),
        ),
        title: imported.title,
        url: imported.url,
        published_at: new Date(imported.published_at * 1000).toISOString(),
      });
      return response({ id }, exists ? 200 : 201);
    }
    const feedId = /^\/v1\/feeds\/(\d+)$/.exec(url.pathname);
    if (feedId)
      return this.feeds.has(Number(feedId[1]))
        ? response(this.feeds.get(Number(feedId[1])))
        : response({}, 404);
    throw new Error(`Unexpected mock endpoint: ${url.pathname}`);
  };
}
export async function serviceFixture(yaml = '', upstream = new FakeUpstream()) {
  const root = mkdtempSync(join(tmpdir(), 'mfai-service-'));
  const service = await createService(
    writeConfiguration(
      root,
      config(`miniflux:\n  max_requests_per_second: 100000\n${yaml}`),
    ),
    { root, fetch: upstream.fetch, logger: { log() {} } },
  );
  const app = buildServer(service);
  await app.ready();
  return {
    service,
    app,
    upstream,
    root,
    async prepare() {
      await service.binding.check();
      await service.ingest.bootstrap();
    },
    async drain() {
      for (let i = 0; i < 30; i++) {
        service.queue.tick();
        await service.queue.idle();
        const due = service.repository.db.get<{ n: number }>(
          "SELECT count(*) AS n FROM tasks WHERE state='pending' AND run_after<=?",
          service.repository.now(),
        )!.n;
        if (!due) return;
      }
      throw new Error('queue_did_not_drain');
    },
    async close() {
      await app.close();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export const auth = { authorization: `Bearer ${fixtureValues.admin_token}` };
export function signed(body: string, event = 'new_entries') {
  return {
    'content-type': 'application/json',
    'x-miniflux-event-type': event,
    'x-miniflux-signature': createHmac('sha256', fixtureValues.webhook_secret)
      .update(body)
      .digest('hex'),
  };
}
