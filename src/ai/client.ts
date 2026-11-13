import type { AiConfig, Provider } from '../config/index.js';
import type { AiExecution } from '../db/types.js';
import type { WorkOrder } from '../runtime/concurrency.js';
import type { CallStat } from '../generation/types.js';
import type { Envelope, Operation } from './protocol.js';
export type AiObserver = (
  model: string,
  operation: Operation,
  mode: 'joint' | 'single',
  outcome: CallStat['outcome'],
  bytes: number,
) => void;
import { ProviderPool } from './providers.js';
import { PrioritySemaphore } from '../runtime/concurrency.js';
import { WorkError, upstreamRequestId } from '../obs/errors.js';
import { retryAfter } from '../miniflux/client.js';
import {
  parseEnvelope,
  parseTopLevel,
  protocolInstruction,
} from './protocol.js';
import { readCompletion } from './response.js';
const overflowCodes = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'max_context_length_exceeded',
  'maximum_context_length_exceeded',
  'prompt_too_long',
  'input_too_long',
]);
export function classifyAiFailure(status: number, body: unknown, after = 0) {
  const codes: string[] = [],
    messages: string[] = [];
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (['code', 'type'].includes(key) && typeof value === 'string')
        codes.push(value.toLowerCase());
      if (
        ['message', 'error_message'].includes(key) &&
        typeof value === 'string'
      )
        messages.push(value);
      if (typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(body);
  const fields = { http_status: status };
  if ([401, 403].includes(status))
    return new WorkError('ai_auth', 'auth', false, 0, fields);
  if (status === 408)
    return new WorkError('ai_timeout', 'timeout', true, after, fields);
  if (status === 429 || codes.includes('rate_limit_exceeded'))
    return new WorkError(
      'ai_rate_limited',
      'rate_limited',
      true,
      after,
      fields,
    );
  if (status >= 500)
    return new WorkError(
      'ai_unavailable',
      codes.some((c) => c.includes('overload')) ? 'overload' : 'upstream_5xx',
      true,
      after,
      fields,
    );
  if (status === 413)
    return new WorkError(
      'ai_request_too_large',
      'request_too_large',
      true,
      0,
      fields,
    );
  if (
    codes.some((c) => overflowCodes.has(c)) ||
    messages.some(
      (m) =>
        /context (length|window|size)|maximum context|max_tokens|token limit|input length/i.test(
          m,
        ) &&
        /exceed|too (long|large|many)|over the limit|greater than|beyond/i.test(
          m,
        ),
    )
  )
    return new WorkError(
      'ai_context_overflow',
      'context_overflow',
      true,
      0,
      fields,
    );
  return new WorkError(
    'ai_invalid_request',
    'invalid_request',
    false,
    0,
    fields,
  );
}
export function isOverflow(error: unknown): error is WorkError {
  return (
    error instanceof WorkError &&
    ['context_overflow', 'request_too_large', 'output_truncated'].includes(
      error.detail.failure_class,
    )
  );
}
function outputMembers(envelope: Envelope) {
  if (envelope.operation === 'detect_language') return ['parts'];
  if (envelope.operation === 'generate_artifacts')
    return Object.keys(envelope.requested_outputs);
  if (envelope.operation === 'repair_translation') return ['translation'];
  if (envelope.operation.includes('overview')) return ['overview', 'sections'];
  return ['summary'];
}
function finishReason(value: unknown): CallStat['finish_reason'] {
  if (typeof value !== 'string') return 'missing';
  if (value === 'stop' || value === 'length' || value === 'content_filter')
    return value;
  return 'other';
}
function completionResult(
  outer: unknown,
  envelope: Envelope,
  stat: CallStat,
): Record<string, unknown> {
  const parsed = outer as {
    choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
    usage?: Record<string, unknown>;
  } | null;
  const choice = parsed?.choices?.[0];
  stat.finish_reason = finishReason(choice?.finish_reason);
  const usage = parsed?.usage;
  if (
    usage &&
    ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(
      (key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0,
    )
  )
    stat.usage = {
      prompt_tokens: Number(usage.prompt_tokens),
      completion_tokens: Number(usage.completion_tokens),
      total_tokens: Number(usage.total_tokens),
    };
  if (choice?.finish_reason === 'length')
    throw new WorkError('ai_output_truncated', 'output_truncated', true);
  if (typeof choice?.message?.content !== 'string')
    throw new WorkError('ai_invalid_response', 'invalid_response', true);
  try {
    const result = JSON.parse(choice.message.content);
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      throw new Error('invalid_completion_object');
    parseTopLevel(result, outputMembers(envelope));
    return result;
  } catch {
    throw new WorkError('ai_invalid_response', 'invalid_response', true);
  }
}
export class AiClient {
  fetcher;
  observe;
  semaphore;
  pool;
  constructor(
    concurrency: number,
    configuration: () => AiConfig,
    fetcher = fetch,
    observe: AiObserver = () => {},
    now = Date.now,
  ) {
    this.fetcher = fetcher;
    this.observe = observe;
    this.semaphore = new PrioritySemaphore(concurrency);
    this.pool = new ProviderPool(configuration, now);
  }
  async call(
    snapshot: AiExecution,
    instruction: string,
    envelope: Envelope,
    order: WorkOrder,
    signal: AbortSignal,
    onStat: (stat: CallStat) => void,
  ) {
    // Historical task snapshots describe the protocol, never current routing or credentials.
    if (snapshot.ai_envelope_protocol_version !== 1)
      throw new WorkError(
        'unsupported_ai_protocol',
        'unsupported_version',
        false,
      );
    const checked = parseEnvelope(envelope);
    return this.semaphore.use(
      () =>
        this.pool.run(
          (provider) =>
            this.attempt(provider, instruction, checked, signal, onStat),
          signal,
        ),
      order,
      signal,
    );
  }
  health() {
    return this.pool.health();
  }
  async attempt(
    provider: Provider,
    instruction: string,
    envelope: Envelope,
    signal: AbortSignal,
    onStat: (stat: CallStat) => void,
  ) {
    const body = JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: `${instruction}\n\n${protocolInstruction}` },
        { role: 'user', content: JSON.stringify(envelope) },
      ],
      stream: true,
      response_format: { type: 'json_object' },
    });
    signal.throwIfAborted();
    const started = Date.now();
    const timeout = AbortSignal.timeout(provider.request_timeout_ms);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const stat: CallStat = {
      provider_id: provider.id,
      model: provider.model,
      operation: envelope.operation,
      duration_ms: 0,
      finish_reason: 'missing',
      usage: null,
      outcome: 'failed',
    };
    try {
      const response = await this.fetcher(
        `${provider.base_url}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.api_key}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream, application/json',
          },
          body,
          signal: requestSignal,
          redirect: 'error',
        },
      );
      const outer = await readCompletion(response, requestSignal);
      if (response.status !== 200) {
        const failure = classifyAiFailure(
          response.status,
          outer,
          retryAfter(response.headers.get('retry-after')),
        );
        failure.detail.upstream_request_id = upstreamRequestId(
          response.headers,
        );
        throw failure;
      }
      const result = completionResult(outer, envelope, stat);
      stat.outcome = 'succeeded';
      return result;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof WorkError) throw error;
      if (timeout.aborted) throw new WorkError('ai_timeout', 'timeout', true);
      throw new WorkError('ai_network', 'network', true);
    } finally {
      stat.duration_ms = Date.now() - started;
      onStat(stat);
      this.observe(
        provider.model,
        envelope.operation,
        envelope.operation === 'generate_artifacts' &&
          envelope.requested_outputs.translation &&
          envelope.requested_outputs.summary
          ? 'joint'
          : 'single',
        stat.outcome,
        Buffer.byteLength(body, 'utf8'),
      );
    }
  }
}
