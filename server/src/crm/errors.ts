/** Errors the CRM routes answer with `{ error }`; `router.ts` maps `status`. */
export class CrmInputError extends Error {
  readonly status = 400;
  readonly field?: string;
  constructor(message: string, field?: string) { super(message); this.name = 'CrmInputError'; this.field = field; }
}
export class CrmNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'Not found') { super(message); this.name = 'CrmNotFoundError'; }
}
export class CrmConflictError extends Error {
  readonly status = 409;
  readonly details: Record<string, unknown>;
  /** Set only when `details` is non-empty: the error handler then sends `{ error, code, details }`. */
  readonly code?: string;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message); this.name = 'CrmConflictError'; this.details = details;
    if (Object.keys(details).length) this.code = 'crm-conflict';
  }
}
export class CrmUpstreamError extends Error {
  readonly status = 502;
  constructor(message: string) { super(message); this.name = 'CrmUpstreamError'; }
}
