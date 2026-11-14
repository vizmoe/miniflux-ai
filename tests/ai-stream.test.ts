import { aiConfig } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';
import { AiClient } from '../src/ai/client.js';
import type { CallStat } from '../src/ai/client.js';
import type { Envelope } from '../src/ai/protocol.js';
import { generationSnapshot } from '../src/config/snapshots.js';
import { chat, config } from './helpers.js';

const snapshot = generationSnapshot(config(), ['translation'], 200).ai;
const envelope: Envelope = {
  protocol_version: 1,
  operation: 'generate_artifacts',
  context: { feed_title: 'Feed', primary_language: 'en' },
  source: { title: 'Title', blocks: [] },
  requested_outputs: {
    translation: {
      target_language: 'zh-CN',
      title_requested: true,
      block_ids: [],
    },
  },
};
const result = { translation: { title: '标题 🌏', blocks: [] } };
const order = { priority: 100, created_at: 1, id: 1 };
const signal = new AbortController().signal;
const chunk = (content: unknown, finish: unknown = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const complete = event(chunk(JSON.stringify(result), 'stop'));
function stream(text: string | Uint8Array, width = 17, cancel = vi.fn()) {
  const bytes =
    typeof text === 'string' ? new TextEncoder().encode(text) : text;
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else {
          controller.enqueue(bytes.slice(offset, offset + width));
          offset = Math.min(bytes.length, offset + width);
        }
      },
      cancel,
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}
function call(client: AiClient, onStat = (_s: CallStat) => {}) {
  return client.call(snapshot, 'Instruction', envelope, order, signal, onStat);
}

describe('streamed Chat Completions transport', () => {
  it.each([1, 17])(
    'accepts an initial UTF-8 BOM directly before the first data event in %i-byte chunks',
    async (width) => {
      const client = new AiClient(
        1,
        () => aiConfig('key'),
        async () => stream('\uFEFF' + complete + 'data: [DONE]\n\n', width),
      );
      await expect(call(client)).resolves.toEqual(result);
    },
  );
  it.each([0xff, 0xc2])(
    'rejects malformed UTF-8 byte %i inside otherwise valid generated JSON',
    async (byte) => {
      const bytes = Buffer.from(complete + 'data: [DONE]\n\n');
      const offset = bytes.indexOf(Buffer.from('🌏'));
      expect(offset).toBeGreaterThan(0);
      bytes[offset] = byte;
      const fetcher = vi.fn(async () => stream(bytes, 1));
      const client = new AiClient(1, () => aiConfig('key'), fetcher);
      await expect(call(client)).rejects.toMatchObject({
        detail: {
          code: 'ai_invalid_response',
          failure_class: 'invalid_response',
          retryable: true,
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['\n', '\r\n', '\r'])(
    'joins UTF-8 deltas across byte and %j line boundaries',
    async (newline) => {
      const content = JSON.stringify(result);
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      };
      const multiline = JSON.stringify(chunk(content.slice(0, 20))).replace(
        ',"delta"',
        ',\ndata: "delta"',
      );
      const text =
        '\uFEFF: heartbeat\n\nevent: message\nid: ignored\nretry: 1000\n' +
        event({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                reasoning_content: 'private reasoning',
              },
              finish_reason: null,
            },
          ],
        }) +
        `data: ${multiline}\n\n` +
        event(chunk(content.slice(20))) +
        event(chunk('', 'stop')) +
        event({ choices: [], usage }) +
        'data: [DONE]\n\n';
      const fetcher = vi.fn(async () =>
        stream(text.replaceAll('\n', newline), 1),
      );
      const client = new AiClient(1, () => aiConfig('key'), fetcher);
      const stats: CallStat[] = [];
      await expect(call(client, (s) => stats.push(s))).resolves.toEqual(result);
      expect(stats[0]).toMatchObject({
        outcome: 'succeeded',
        finish_reason: 'stop',
        usage,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts JSON when a compatible provider ignores stream, without another request', async () => {
    const fetcher = vi.fn(async () => chat(result));
    await expect(
      call(new AiClient(1, () => aiConfig('key'), fetcher)),
    ).resolves.toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('finishes at DONE and cancels a connection that stays open', async () => {
    const cancel = vi.fn();
    const client = new AiClient(
      1,
      () => aiConfig('key'),
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(complete + 'data: [DONE]\n\n'),
              );
            },
            cancel,
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    await expect(call(client)).resolves.toEqual(result);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['{', ''])(
    'keeps output truncation %j eligible for the existing degradation path',
    async (partial) => {
      const stats: CallStat[] = [];
      const client = new AiClient(
        1,
        () => aiConfig('key'),
        async () =>
          stream(event(chunk(partial, 'length')) + 'data: [DONE]\n\n'),
      );
      await expect(call(client, (s) => stats.push(s))).rejects.toMatchObject({
        detail: { failure_class: 'output_truncated' },
      });
      expect(stats[0]).toMatchObject({
        outcome: 'failed',
        finish_reason: 'length',
      });
    },
  );

  it.each([
    ['missing DONE', complete],
    ['unfinished DONE event', complete + 'data: [DONE]\n'],
    [
      'missing finish reason',
      event(chunk(JSON.stringify(result))) + 'data: [DONE]\n\n',
    ],
    ['missing content', event(chunk(null, 'stop')) + 'data: [DONE]\n\n'],
    ['invalid JSON event', 'data: {private provider text}\n\ndata: [DONE]\n\n'],
    [
      'invalid content type',
      event(chunk({ private: 'text' }, 'stop')) + 'data: [DONE]\n\n',
    ],
    [
      'error envelope after complete JSON',
      complete +
        event({ error: { message: 'private provider text' } }) +
        'data: [DONE]\n\n',
    ],
    ['error event', 'event: error\n' + complete + 'data: [DONE]\n\n'],
    [
      'nonzero choice',
      event({
        choices: [
          {
            index: 1,
            delta: { content: JSON.stringify(result) },
            finish_reason: 'stop',
          },
        ],
      }) + 'data: [DONE]\n\n',
    ],
    [
      'extra content after finish',
      complete + event(chunk(' ')) + 'data: [DONE]\n\n',
    ],
    ['malformed choices', event({ choices: {} }) + 'data: [DONE]\n\n'],
    ['null chunk', event(null) + 'data: [DONE]\n\n'],
  ])(
    'rejects %s without retries or leaking response content',
    async (_name, text) => {
      const stats: CallStat[] = [];
      const fetcher = vi.fn(async () => stream(text));
      const client = new AiClient(1, () => aiConfig('key'), fetcher);
      const error = await call(client, (s) => stats.push(s)).catch((e) => e);
      expect(error).toMatchObject({
        message: 'ai_invalid_response',
        detail: { failure_class: 'invalid_response', retryable: true },
      });
      expect(JSON.stringify(error)).not.toContain('private');
      expect(stats[0]!.outcome).toBe('failed');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['timeout', 'cancel'] as const)(
    'enforces %s while reading, discards partial JSON and releases capacity',
    async (mode) => {
      const cancel = vi.fn();
      const controller = new AbortController();
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(output) {
                output.enqueue(new TextEncoder().encode(complete));
              },
              cancel,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      );
      const client = new AiClient(
        1,
        () => aiConfig('key', { request_timeout_ms: 20 }),
        fetcher,
      );
      const pending = client.call(
        snapshot,
        'Instruction',
        envelope,
        order,
        controller.signal,
        () => {},
      );
      if (mode === 'cancel')
        setTimeout(() => controller.abort(new Error('stopped')), 5);
      if (mode === 'timeout')
        await expect(pending).rejects.toMatchObject({
          detail: { failure_class: 'timeout' },
        });
      else await expect(pending).rejects.toThrow('stopped');
      expect(cancel).toHaveBeenCalledTimes(1);
      fetcher.mockImplementation(async () =>
        stream(complete + 'data: [DONE]\n\n'),
      );
      await expect(call(client)).resolves.toEqual(result);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});
