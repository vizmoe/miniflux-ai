import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { LastError } from '../db/types.js';
import { nonempty, safeId } from '../config/primitives.js';
import { RequestLimiter } from '../runtime/concurrency.js';
import { WorkError, upstreamRequestId } from '../obs/errors.js';
const categorySchema = z.object({ id: safeId, title: nonempty });
export const feedSchema = z.object({
  id: safeId,
  title: nonempty,
  feed_url: nonempty,
  site_url: z.string().default(''),
  category: categorySchema,
});
const entrySchema = z.object({
  id: safeId,
  feed_id: safeId,
  title: z.string(),
  content: z.string(),
});
export type MinifluxEntry = z.infer<typeof entrySchema>;
export type MinifluxFeed = z.infer<typeof feedSchema>;
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value))
    return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER - now);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
function failureKind(
  status: number,
  body: unknown,
): [string, LastError['failure_class']] {
  if (
    status === 400 &&
    body !== null &&
    typeof body === 'object' &&
    Object.values(body).some(
      (value) =>
        typeof value === 'string' &&
        /ErrEntryTombstoned|entry.*tombstoned/i.test(value),
    )
  )
    return ['miniflux_entry_tombstoned', 'tombstoned'];
  if (status === 404) return ['miniflux_not_found', 'not_found'];
  if (status === 401 || status === 403) return ['miniflux_auth', 'auth'];
  if (status === 429) return ['miniflux_rate_limited', 'rate_limited'];
  if (status >= 500) return ['miniflux_unavailable', 'upstream_5xx'];
  return ['miniflux_invalid_request', 'invalid_request'];
}
function responseBody(
  response: Response,
  raw: string,
  statuses: number[],
): unknown {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const fields = {
    http_status: response.status,
    upstream_request_id: upstreamRequestId(response.headers),
  };
  if (!statuses.includes(response.status)) {
    const [code, failure] = failureKind(response.status, body);
    throw new WorkError(
      code,
      failure,
      response.status === 429 || response.status >= 500,
      retryAfter(response.headers.get('retry-after')),
      fields,
    );
  }
  if (body === null)
    throw new WorkError(
      'miniflux_invalid_response',
      'invalid_response',
      true,
      0,
      fields,
    );
  return body;
}
export class MinifluxClient {
  config;
  fetcher;
  observe;
  limiter;
  constructor(
    config: Config['miniflux'],
    fetcher = fetch,
    observe: (endpoint: string, status: string) => void = () => {},
  ) {
    this.config = config;
    this.fetcher = fetcher;
    this.observe = observe;
    this.limiter = new RequestLimiter(
      config.max_concurrent_requests,
      config.max_requests_per_second,
    );
  }
  async request(
    method: string,
    path: string,
    statuses: number[],
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.limiter.run(async () => {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.config.request_timeout_ms);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const endpoint = path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
      let status = 'network';
      try {
        const response = await this.fetcher(`${this.config.base_url}${path}`, {
          method,
          headers: {
            'X-Auth-Token': this.config.api_key,
            Accept: 'application/json',
            ...(data === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          signal: combined,
          redirect: 'error',
        });
        status = String(response.status);
        return responseBody(response, await response.text(), statuses);
      } catch (error) {
        if (error instanceof WorkError) throw error;
        if (signal?.aborted) throw signal.reason;
        if (timeout.aborted)
          throw new WorkError('miniflux_timeout', 'timeout', true);
        throw new WorkError('miniflux_unavailable', 'network', true);
      } finally {
        this.observe(endpoint, status);
      }
    }, signal);
  }
  decode<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    return result.data;
  }
  async version(signal?: AbortSignal) {
    const raw = this.decode(
      z.object({ version: z.string() }),
      await this.request('GET', '/v1/version', [200], undefined, signal),
    ).version;
    if (!/^\d+\.\d+\.\d+$/.test(raw))
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    return raw;
  }
  async me(signal?: AbortSignal) {
    return this.decode(
      z.object({ id: safeId }),
      await this.request('GET', '/v1/me', [200], undefined, signal),
    ).id;
  }
  async entries(
    query: Record<string, string | number | boolean>,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    );
    return this.decode(
      z.object({ entries: z.array(z.unknown()) }),
      await this.request(
        'GET',
        `/v1/entries?${params}`,
        [200],
        undefined,
        signal,
      ),
    ).entries;
  }
  async getEntry(id: number, signal?: AbortSignal) {
    safeId.parse(id);
    const result = this.decode(
      entrySchema,
      await this.request('GET', `/v1/entries/${id}`, [200], undefined, signal),
    );
    if (result.id !== id)
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    return result;
  }
  async updateEntry(
    id: number,
    value: { title: string; content: string },
    signal?: AbortSignal,
  ) {
    safeId.parse(id);
    // Miniflux rejects explicit empty fields; omitted fields retain their
    // stored value. The Renderer still validates the complete returned Entry.
    const patch = {
      ...(value.title === '' ? {} : { title: value.title }),
      ...(value.content === '' ? {} : { content: value.content }),
    };
    const result = this.decode(
      entrySchema,
      await this.request('PUT', `/v1/entries/${id}`, [201], patch, signal),
    );
    if (result.id !== id)
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    return result;
  }
  async feed(id: number, signal?: AbortSignal) {
    safeId.parse(id);
    const result = this.decode(
      feedSchema,
      await this.request('GET', `/v1/feeds/${id}`, [200], undefined, signal),
    );
    if (result.id !== id)
      throw new WorkError(
        'miniflux_invalid_response',
        'invalid_response',
        true,
      );
    return result;
  }
  async feeds(signal?: AbortSignal) {
    return this.decode(
      z.array(feedSchema),
      await this.request('GET', '/v1/feeds', [200], undefined, signal),
    );
  }
  async categories(signal?: AbortSignal) {
    return this.decode(
      z.array(categorySchema),
      await this.request('GET', '/v1/categories', [200], undefined, signal),
    );
  }
  async createFeed(
    url: string,
    categoryId: number | null,
    signal?: AbortSignal,
  ) {
    const result = this.decode(
      z.object({ feed_id: safeId }),
      await this.request(
        'POST',
        '/v1/feeds',
        [201],
        {
          feed_url: url,
          ...(categoryId === null ? {} : { category_id: categoryId }),
        },
        signal,
      ),
    );
    return this.feed(result.feed_id, signal);
  }
  async importEntry(
    feedId: number,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    safeId.parse(feedId);
    const response = await this.request(
      'POST',
      `/v1/feeds/${feedId}/entries/import`,
      [200, 201],
      data,
      signal,
    );
    return this.decode(z.object({ id: safeId }), response).id;
  }
}
