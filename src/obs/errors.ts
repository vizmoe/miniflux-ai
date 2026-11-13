import { lastErrorSchema } from '../db/documents.js';
import type { LastError } from '../db/types.js';
export class WorkError extends Error {
  retryAfterMs;
  detail;
  constructor(
    code: string,
    failureClass: LastError['failure_class'],
    retryable: boolean,
    retryAfterMs = 0,
    fields: Partial<LastError> = {},
  ) {
    super(code);
    this.retryAfterMs = retryAfterMs;
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
  status;
  code;
  fields;
  constructor(
    status: number,
    code: string,
    fields: Record<string, unknown> = {},
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
export class LeaseLost extends Error {
  constructor() {
    super('lease_lost');
  }
}
export function safeWorkError(error: unknown) {
  if (error instanceof WorkError) return error;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
    return new WorkError('request_timeout', 'timeout', true);
  return new WorkError('operation_failed', 'repository', true);
}
export function upstreamRequestId(headers: Headers) {
  const value = headers.get('x-request-id') ?? headers.get('request-id');
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
