import { describe, expect, it } from 'vitest';
import { PrioritySemaphore, EntryLock } from '../src/runtime/concurrency.js';
import { readCompletion } from '../src/ai/response.js';
import { extractSemanticBlocks } from '../src/html/blocks.js';
import { parseSource } from '../src/html/dom.js';
import {
  computeSourceIntegritySignature,
  projectSource,
} from '../src/html/ownership.js';
import { countContentUnits } from '../src/html/units.js';

it('preserves source structure while identifying translatable blocks', () => {
  const html =
    '<h2>Heading</h2><p>Hello <a href="https://example.test">world</a>.</p><pre>not translated</pre><ul><li>List item</li></ul>';
  const root = parseSource(html);
  const plan = extractSemanticBlocks(root);
  expect(plan.blocks.map((b) => b.text)).toEqual([
    'Heading',
    'Hello world.',
    'List item',
  ]);
  expect(plan.blocks.map((b) => b.id)).toEqual(
    extractSemanticBlocks(parseSource(html)).blocks.map((b) => b.id),
  );
  const before = computeSourceIntegritySignature(html);
  const token = 'a'.repeat(32);
  plan.insert(
    plan.blocks[1].id,
    `mfai-v1-translation-${token}-${plan.blocks[1].id}`,
    '你好世界',
  );
  projectSource(root, [{ marker_token: token, kind: 'translation' }]);
  expect(computeSourceIntegritySignature(root)).toEqual(before);
  expect(countContentUnits('Hello world 123 https://example.test')).toBe(2);
  expect(countContentUnits('你好世界')).toBe(4);
});

describe('concurrency contracts', () => {
  it('reserves capacity, orders foreground work first, and releases once', async () => {
    const semaphore = new PrioritySemaphore(1);
    const release = await semaphore.acquire();
    const order: string[] = [];
    const background = semaphore.use(() => order.push('background'), {
      priority: 0,
      created_at: 0,
      id: 1,
    });
    const foreground = semaphore.use(() => order.push('foreground'), {
      priority: 100,
      created_at: 0,
      id: 2,
    });
    release();
    release();
    await Promise.all([background, foreground]);
    expect(order).toEqual(['foreground', 'background']);
    expect(semaphore.active).toBe(0);
  });

  it('cancels queued work without leaking a permit and serializes the same entry', async () => {
    const semaphore = new PrioritySemaphore(1);
    const release = await semaphore.acquire();
    const abort = new AbortController();
    const pending = semaphore.acquire(undefined, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(await semaphore.use(() => 42)).toBe(42);
    const lock = new EntryLock();
    let active = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        lock.with(1, async () => {
          active++;
          await Promise.resolve();
          expect(active).toBe(1);
          active--;
        }),
      ),
    );
  });
});

it('reassembles streaming completions across UTF-8 and CRLF chunk boundaries', async () => {
  const wire = [
    'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\r\n');
  const bytes = new TextEncoder().encode(wire);
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const response = new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
  expect(
    await readCompletion(response, new AbortController().signal),
  ).toMatchObject({
    choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
  });
  const truncated = new Response('data: {"choices":[]}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  await expect(
    readCompletion(truncated, new AbortController().signal),
  ).rejects.toMatchObject({ message: 'ai_invalid_response' });
});
