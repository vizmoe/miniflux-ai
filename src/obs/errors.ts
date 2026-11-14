import { lastErrorSchema } from '../db/documents.js';
import type { LastError } from '../db/documents.js';

export class WorkError extends Error {
  readonly detail: LastError;
  constructor(
    code: string,
    failureClass: LastError['failure_class'],
    retryable: boolean,
    readonly retryAfterMs = 0,
    fields: Partial<LastError> = {},
  ) {
    super(code);
    this.detail = lastErrorSchema.parse({
      schema_version: 1,
      code,
      failure_class: failureClass,
      retryable,
      http_status: null,
      upstream_request_id: null,
      miniflux_version: null,
      integrity_stage: null,
      ...fields,
    });
  }
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
export class LeaseLost extends Error {
  constructor() {
    super('lease_lost');
  }
}
export function safeWorkError(error: unknown): WorkError {
  if (error instanceof WorkError) return error;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
    return new WorkError('request_timeout', 'timeout', true);
  return new WorkError('operation_failed', 'repository', true);
}
export function upstreamRequestId(headers: Headers): string | null {
  const value = headers.get('x-request-id') ?? headers.get('request-id');
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
