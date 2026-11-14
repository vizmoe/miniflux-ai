import { describe, expect, it } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { CallStat } from '../src/ai/client.js';
import type { Envelope } from '../src/ai/protocol.js';

const result = { translation: { blocks: [{ id: 'b1', text: '译文' }] } };
const completion = () =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify(result) }, finish_reason: 'stop' },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
const settings = () => ({
  max_concurrent_requests: 4,
  failover: { cooldown: '5m', failure_threshold: 2 },
  providers: ['primary', 'secondary'].map((id, index) => ({
    id,
    enabled: true,
    priority: 100 - index,
    base_url: `https://${id}.test/v1`,
    api_key: `fixture-${id}`,
    model: `${id}-model`,
    request_timeout_ms: 1000,
  })),
});
const execution = {
  schema_version: 2 as const,
  ai_envelope_protocol_version: 1 as const,
};
const envelope: Envelope = {
  protocol_version: 1,
  operation: 'generate_artifacts',
  context: { feed_title: 'Fixture', primary_language: 'en' },
  source: { title: 'Fixture', blocks: [{ id: 'b1', text: 'Source text.' }] },
  requested_outputs: {
    translation: {
      target_language: 'zh-CN',
      title_requested: false,
      block_ids: ['b1'],
    },
  },
};
const call = (
  client: AiClient,
  signal = new AbortController().signal,
  stats: CallStat[] = [],
) =>
  client.call(
    execution,
    'Translate.',
    envelope,
    { id: 1, priority: 100, created_at: 1 },
    signal,
    (s) => stats.push(s),
  );

describe('configured provider routing', () => {
  it('uses YAML priority and provider-specific credentials', async () => {
    const routes = settings(),
      requests: Array<{ url: string; key: string | null; model: string }> = [];
    routes.providers.reverse();
    const stats: CallStat[] = [];
    const client = new AiClient(
      4,
      () => routes,
      async (url, init) => {
        requests.push({
          url: String(url),
          key: new Headers(init?.headers).get('authorization'),
          model: JSON.parse(String(init?.body)).model,
        });
        return String(url).includes('primary.test')
          ? new Response('{}', { status: 503 })
          : completion();
      },
    );
    await expect(call(client, undefined, stats)).resolves.toEqual(result);
    expect(requests).toEqual([
      {
        url: 'https://primary.test/v1/chat/completions',
        key: 'Bearer fixture-primary',
        model: 'primary-model',
      },
      {
        url: 'https://secondary.test/v1/chat/completions',
        key: 'Bearer fixture-secondary',
        model: 'secondary-model',
      },
    ]);
    expect(
      stats.map((s) => ({
        provider_id: s.provider_id,
        model: s.model,
        outcome: s.outcome,
      })),
    ).toEqual([
      { provider_id: 'primary', model: 'primary-model', outcome: 'failed' },
      {
        provider_id: 'secondary',
        model: 'secondary-model',
        outcome: 'succeeded',
      },
    ]);
  });

  it('cools repeated failures, prefers the healthy provider, and restores priority after a successful probe', async () => {
    let now = 1000,
      failing = true;
    const urls: string[] = [],
      routes = settings();
    const client = new AiClient(
      4,
      () => routes,
      async (url) => {
        urls.push(String(url));
        return failing && String(url).includes('primary.test')
          ? new Response('{}', { status: 503 })
          : completion();
      },
      undefined,
      () => now,
    );
    await call(client);
    await call(client);
    await call(client);
    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      'primary.test',
      'secondary.test',
      'primary.test',
      'secondary.test',
      'secondary.test',
    ]);
    expect(client.health().find((p) => p.id === 'primary')).toMatchObject({
      state: 'cooling',
      retry_at: 301000,
    });
    now = 301000;
    failing = false;
    await call(client);
    await call(client);
    expect(urls.slice(-2).map((url) => new URL(url).hostname)).toEqual([
      'primary.test',
      'primary.test',
    ]);
    expect(client.health().find((p) => p.id === 'primary')).toMatchObject({
      state: 'healthy',
      retry_at: null,
    });
  });

  it('honours Retry-After and does not hammer an entirely cooling pool', async () => {
    const routes = settings();
    routes.providers.splice(1);
    routes.failover.failure_threshold = 1;
    let calls = 0;
    const client = new AiClient(
      4,
      () => routes,
      async () => {
        calls++;
        return new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '600' },
        });
      },
      undefined,
      () => 1000,
    );
    await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 600000 });
    await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 600000 });
    expect(calls).toBe(1);
  });

  it('falls back on malformed responses without weakening the output contract', async () => {
    const urls: string[] = [];
    const client = new AiClient(4, settings, async (url) => {
      urls.push(String(url));
      return String(url).includes('primary.test')
        ? new Response('not-json')
        : completion();
    });
    await expect(call(client)).resolves.toEqual(result);
    expect(urls).toHaveLength(2);
  });

  it('preserves overflow handling without treating source size as provider downtime', async () => {
    const urls: string[] = [];
    const client = new AiClient(4, settings, async (url) => {
      urls.push(String(url));
      return new Response('{}', { status: 413 });
    });
    await expect(call(client)).rejects.toMatchObject({
      detail: { failure_class: 'request_too_large' },
    });
    expect(urls).toEqual(['https://primary.test/v1/chat/completions']);
    expect(client.health().every((p) => p.state === 'healthy')).toBe(true);
  });

  it('stops failover when the caller cancels', async () => {
    const abort = new AbortController(),
      urls: string[] = [];
    const client = new AiClient(4, settings, async (url, init) => {
      urls.push(String(url));
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(init!.signal!.reason),
          { once: true },
        );
        abort.abort(new Error('caller_cancelled'));
      });
    });
    await expect(call(client, abort.signal)).rejects.toThrow(
      'caller_cancelled',
    );
    expect(urls).toEqual(['https://primary.test/v1/chat/completions']);
  });
});

it('allows only one recovery probe and ignores an older success after a newer circuit failure', async () => {
  const routes = settings();
  routes.failover.failure_threshold = 1;
  let now = 0,
    primaryCalls = 0;
  let settle: (response: Response) => void = () => {};
  let entered: () => void = () => {};
  let waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new AiClient(
    4,
    () => routes,
    async (url) => {
      if (!String(url).includes('primary.test')) return completion();
      primaryCalls++;
      if (primaryCalls === 2) return new Response('{}', { status: 503 });
      entered();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    undefined,
    () => now,
  );
  const old = call(client);
  await waiting;
  await call(client);
  expect(client.health()[0]!.state).toBe('cooling');
  settle(completion());
  await old;
  expect(client.health()[0]!.state).toBe('cooling');
  now = 300000;
  waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const probe = call(client);
  await waiting;
  expect(client.health()[0]!.state).toBe('probing');
  await call(client);
  await call(client);
  expect(primaryCalls).toBe(3);
  settle(completion());
  await probe;
  expect(client.health()[0]!.state).toBe('healthy');
});
it('does not let an in-flight result poison edited provider settings', async () => {
  const routes = settings();
  routes.failover.failure_threshold = 1;
  let settle: (response: Response) => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new AiClient(
    4,
    () => routes,
    async (url) => {
      if (!String(url).includes('primary.test')) return completion();
      entered();
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  );
  const old = call(client);
  await waiting;
  routes.providers[0]!.base_url = 'https://replacement.test/v1';
  await call(client);
  settle(new Response('{}', { status: 503 }));
  await old;
  expect(client.health()[0]).toMatchObject({
    state: 'healthy',
    consecutive_failures: 0,
  });
  routes.providers.splice(0, 1);
  expect(client.health().map((p) => p.id)).toEqual(['secondary']);
});
it('honours stable ties and disabled services, and reports the earliest possible retry across cooling providers', async () => {
  const routes = settings();
  routes.providers[0]!.priority = routes.providers[1]!.priority;
  const urls: string[] = [];
  const client = new AiClient(
    4,
    () => routes,
    async (url) => {
      urls.push(String(url));
      return new Response('{}', {
        status: 429,
        headers: {
          'Retry-After': String(String(url).includes('primary') ? 600 : 300),
        },
      });
    },
    undefined,
    () => 0,
  );
  await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 300000 });
  expect(urls.map((url) => new URL(url).hostname)).toEqual([
    'primary.test',
    'secondary.test',
  ]);
  routes.providers[0]!.enabled = false;
  await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 300000 });
  expect(urls).toHaveLength(2);
});
it('keeps a temporary failure retryable even when another provider rejects credentials', async () => {
  const routes = settings();
  routes.failover.failure_threshold = 1;
  const client = new AiClient(
    4,
    () => routes,
    async (url) =>
      new Response('{}', {
        status: String(url).includes('primary') ? 503 : 401,
      }),
  );
  await expect(call(client)).rejects.toMatchObject({
    detail: { retryable: true },
  });
  await expect(call(client)).rejects.toMatchObject({
    detail: { retryable: true },
  });
  expect(JSON.stringify(client.health())).not.toContain('fixture-');
});

it('waits for a recovery probe instead of repeatedly settling calls with no provider attempt', async () => {
  const routes = settings();
  routes.failover.failure_threshold = 1;
  let now = 0,
    primaryCalls = 0;
  let settle: (response: Response) => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new AiClient(
    4,
    () => routes,
    async (url) => {
      if (String(url).includes('secondary'))
        return new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '600' },
        });
      primaryCalls++;
      if (primaryCalls === 1) return new Response('{}', { status: 503 });
      if (primaryCalls === 2) {
        entered();
        return new Promise((resolve) => {
          settle = resolve;
        });
      }
      return completion();
    },
    undefined,
    () => now,
  );
  await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 300000 });
  now = 300000;
  const probe = call(client);
  await waiting;
  const stats: CallStat[] = [];
  const outcomes: string[] = [];
  const follower = call(client, undefined, stats).then(
    () => outcomes.push('succeeded'),
    () => outcomes.push('failed'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  // Queue handlers await this promise; an early rejection would spend a task attempt.
  expect(outcomes).toEqual([]);
  expect(stats).toEqual([]);
  expect(primaryCalls).toBe(2);
  settle(completion());
  await probe;
  await follower;
  expect(outcomes).toEqual(['succeeded']);
  expect(stats).toHaveLength(1);
  expect(primaryCalls).toBe(3);
});

it.each(['failure', 'cancellation'] as const)(
  'releases a probe waiter on %s without making a duplicate provider request',
  async (outcome) => {
    const routes = settings();
    routes.providers.splice(1);
    routes.failover.failure_threshold = 1;
    let now = 0,
      requests = 0;
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let settle: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const client = new AiClient(
      2,
      () => routes,
      async () => {
        requests++;
        if (requests === 1) return new Response('{}', { status: 503 });
        if (requests === 2) {
          markEntered();
          return response;
        }
        return completion();
      },
      undefined,
      () => now,
    );
    await expect(call(client)).rejects.toMatchObject({ retryAfterMs: 300000 });
    now = 300000;
    const probe = call(client).catch((error: unknown) => error);
    await entered;
    const abort = new AbortController();
    const stats: CallStat[] = [];
    const follower = call(client, abort.signal, stats).catch(
      (error: unknown) => error,
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (outcome === 'cancellation') {
      const reason = new Error('waiter_cancelled');
      abort.abort(reason);
      expect(await follower).toBe(reason);
      expect(client.health()[0]!.state).toBe('probing');
      settle(completion());
      await probe;
      await expect(call(client)).resolves.toEqual(result);
      expect(requests).toBe(3);
    } else {
      settle(new Response('{}', { status: 503 }));
      expect(await probe).toMatchObject({ retryAfterMs: 300000 });
      expect(await follower).toMatchObject({ retryAfterMs: 300000 });
      expect(client.health()[0]!.state).toBe('cooling');
      expect(requests).toBe(2);
    }
    expect(stats).toEqual([]);
  },
);
