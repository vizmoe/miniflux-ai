import { WorkError } from '../obs/errors.js';
const invalid = () =>
  new WorkError('ai_invalid_response', 'invalid_response', true);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function streamChunk(value: string) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }
  const chunk = record(parsed);
  if (
    'error' in chunk ||
    !Array.isArray(chunk.choices) ||
    chunk.choices.length > 1
  )
    throw invalid();
  return chunk as Record<string, unknown> & { choices: unknown[] };
}
/** Reassemble one completion; no partial result crosses the transport boundary. */
async function streamedCompletion(response: Response, signal: AbortSignal) {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (bytes?: Uint8Array<ArrayBuffer>, stream = false) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw invalid();
    }
  };
  let line = '',
    data: string[] = [],
    eventType = '',
    afterCR = false;
  let content = '',
    finish: string | undefined,
    usage: unknown,
    done = false;
  const consume = () => {
    const value = data.join('\n');
    data = [];
    const type = eventType;
    eventType = '';
    if (type === 'error') throw invalid();
    if (!value) return;
    if (value === '[DONE]') {
      if (!finish || (!content && finish !== 'length')) throw invalid();
      done = true;
      return;
    }
    const chunk = streamChunk(value);
    if (chunk.usage != null) usage = chunk.usage;
    if (chunk.choices.length === 0) return;
    const choice = record(chunk.choices[0]);
    if (choice.index !== 0 || finish !== undefined) throw invalid();
    const delta = record(choice.delta);
    if (delta.content != null) {
      if (typeof delta.content !== 'string') throw invalid();
      content += delta.content;
    }
    // Reasoning and transport metadata are intentionally not retained.
    if (choice.finish_reason != null) {
      if (typeof choice.finish_reason !== 'string' || !choice.finish_reason)
        throw invalid();
      finish = choice.finish_reason;
    }
  };
  const consumeLine = () => {
    if (line === '') consume();
    else {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') eventType = value;
    }
    line = '';
  };
  const append = (text: string) => {
    // CRLF can span network chunks. A bare CR is also a complete line ending.
    for (const char of text) {
      if (afterCR && char === '\n') {
        afterCR = false;
        continue;
      }
      afterCR = char === '\r';
      if (char === '\r' || char === '\n') consumeLine();
      else line += char;
      if (done) break;
    }
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (!done) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        append(decode());
        break;
      }
      append(decode(next.value, true));
    }
    if (!done) throw invalid();
    return {
      choices: [{ message: { content }, finish_reason: finish }],
      usage,
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function readCompletion(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.status === 200 &&
    response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase() === 'text/event-stream'
  )
    return streamedCompletion(response, signal);
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
