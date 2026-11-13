import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createService } from '../../src/runtime/service.js';
import { buildServer } from '../../src/server/index.js';
import { YamlConfiguration } from '../../src/config/store.js';

export const adminToken = 'local-test-admin-token';
export const webhookSecret = 'local-test-webhook-secret';
export interface FixtureEntry {
  id: number;
  feed_id: number;
  title: string;
  content: string;
  url: string;
  author: string;
  published_at: string;
  feed: {
    id: number;
    title: string;
    feed_url: string;
    site_url: string;
    category: { id: number; title: string };
  };
}
export function exampleEntry(id = 1): FixtureEntry {
  return {
    id,
    feed_id: 1,
    title: 'A scientific discovery',
    content: `<p>${'Researchers investigated how plants respond to light and published their results in a scientific journal. '.repeat(8)}</p>`,
    url: `https://example.test/articles/${id}`,
    author: 'Example author',
    published_at: new Date(Date.now() - 60_000).toISOString(),
    feed: {
      id: 1,
      title: 'Example feed',
      feed_url: 'https://example.test/feed.xml',
      site_url: 'https://example.test',
      category: { id: 1, title: 'Science' },
    },
  };
}
async function bodyOf(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<
    string,
    unknown
  >;
}
export async function startHarness(port = 0) {
  const entries = new Map<number, FixtureEntry>();
  const writes: { id: number; title: string; content: string }[] = [];
  const imports: Record<string, unknown>[] = [];
  const aiOperations: string[] = [];
  const feed = exampleEntry().feed;
  const digestFeed = {
    ...feed,
    id: 2,
    title: 'Daily digest',
    feed_url: 'https://digest.example.test/digest/feeds/daily.xml',
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, 'http://fixture');
    const send = (value: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/v1/version') return send({ version: '2.3.3' });
    if (url.pathname === '/v1/me') return send({ id: 1 });
    if (url.pathname === '/v1/feeds') return send([feed, digestFeed]);
    if (url.pathname === '/v1/categories') return send([feed.category]);
    if (/^\/v1\/feeds\/\d+$/.test(url.pathname))
      return send(url.pathname.endsWith('/2') ? digestFeed : feed);
    if (url.pathname === '/v1/feeds/2/entries/import') {
      imports.push(await bodyOf(request));
      return send({ id: 1000 + imports.length }, 201);
    }
    if (url.pathname === '/v1/entries') {
      let selected = [...entries.values()].filter(
        (e) =>
          e.id > Number(url.searchParams.get('after_entry_id') ?? 0) &&
          e.id <
            Number(
              url.searchParams.get('before_entry_id') ??
                Number.MAX_SAFE_INTEGER,
            ),
      );
      selected.sort((a, b) =>
        url.searchParams.get('direction') === 'desc'
          ? b.id - a.id
          : a.id - b.id,
      );
      selected = selected.slice(
        0,
        Number(url.searchParams.get('limit') ?? 100),
      );
      return send({ entries: selected });
    }
    if (/^\/v1\/entries\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      const entry = entries.get(id);
      if (!entry) return send({ error: 'not_found' }, 404);
      if (request.method === 'PUT') {
        const patch = await bodyOf(request);
        if (typeof patch.title === 'string') entry.title = patch.title;
        if (typeof patch.content === 'string') entry.content = patch.content;
        writes.push({ id, title: entry.title, content: entry.content });
        return send(entry, 201);
      }
      return send(entry);
    }
    if (url.pathname === '/v1/chat/completions') {
      const input = await bodyOf(request);
      const messages = input.messages as { role: string; content: string }[];
      const { parseEnvelope } = await import('../../src/ai/protocol.js');
      const envelope = parseEnvelope(
        JSON.parse(messages.find((m) => m.role === 'user')!.content),
      );
      aiOperations.push(envelope.operation);
      let result: unknown;
      switch (envelope.operation) {
        case 'detect_language':
          result = {
            parts: envelope.parts.map((p) => ({ id: p.id, code: 'en' })),
          };
          break;
        case 'generate_artifacts':
          result = {
            ...(envelope.requested_outputs.translation
              ? {
                  translation: {
                    ...(envelope.requested_outputs.translation.title_requested
                      ? { title: '科学发现' }
                      : {}),
                    blocks: envelope.source.blocks.map((b) => ({
                      id: b.id,
                      text: '这是已恢复的中文译文。',
                    })),
                  },
                }
              : {}),
            ...(envelope.requested_outputs.summary
              ? {
                  summary: {
                    format: 'paragraph',
                    text: 'Researchers reported a scientific discovery.',
                  },
                }
              : {}),
          };
          break;
        case 'generate_digest_item':
          result = { summary: 'A scientific discovery was reported.' };
          break;
        case 'generate_digest_overview':
          result = {
            overview: 'Today in science.',
            sections: [
              {
                title: 'Science',
                item_ids: envelope.items.map((item) => item.id),
              },
            ],
          };
          break;
        default:
          throw new Error(`Unexpected AI operation: ${envelope.operation}`);
      }
      return send({
        choices: [
          {
            message: { content: JSON.stringify(result) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    }
    send({ error: 'unhandled_fixture_route' }, 404);
  }
  const upstream = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not listen');
  const root = await mkdtemp(join(tmpdir(), 'miniflux-ai-test-'));
  const configPath = join(root, 'config.yaml');
  const config = {
    miniflux: {
      base_url: `http://127.0.0.1:${address.port}`,
      api_key: 'local-miniflux-test',
      max_requests_per_second: 1000,
    },
    ai: {
      providers: [
        {
          id: 'primary',
          base_url: `http://127.0.0.1:${address.port}/v1`,
          api_key: 'local-ai-test',
          model: 'fixture-model',
        },
      ],
    },
    server: { admin_token: adminToken },
    ingestion: {
      webhook: { secret: webhookSecret },
      polling: { interval: '1h' },
    },
    runtime: { allow_insecure_http: true, shutdown_grace_period: '1s' },
    features: {
      summary: { min_source_units: 1, max_output_units: 30 },
      digest: {
        public_base_url: 'https://digest.example.test',
        jobs: [
          {
            id: 'daily',
            cron: '0 8 * * *',
            min_item_source_units: 1,
            output: {
              feed_title_template: 'Daily digest',
              existing_feed_id: 2,
            },
          },
        ],
      },
    },
  };
  await writeFile(configPath, stringify(config), { mode: 0o600 });
  const service = await createService(new YamlConfiguration(configPath), {
    root,
    logger: { log() {} },
  });
  const app = buildServer(service);
  const url = await app.listen({ host: '127.0.0.1', port });
  service.start();
  return {
    app,
    service,
    root,
    configPath,
    upstream,
    entries,
    writes,
    imports,
    aiOperations,
    url,
    async close() {
      await app.close();
      await service.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
