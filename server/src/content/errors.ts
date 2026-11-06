/** Errors the Content Studio routes answer with `{ error }`; `router.ts` maps `status`. */
export class ContentInputError extends Error {
  readonly status = 400;
  readonly field?: string;
  constructor(message: string, field?: string) { super(message); this.name = 'ContentInputError'; this.field = field; }
}
export class ContentNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'Not found') { super(message); this.name = 'ContentNotFoundError'; }
}
export class ContentConflictError extends Error {
  readonly status = 409;
  readonly details: Record<string, unknown>;
  /** Set only when `details` is non-empty: the error handler then sends `{ error, code, details }`. */
  readonly code?: string;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message); this.name = 'ContentConflictError'; this.details = details;
    if (Object.keys(details).length) this.code = 'content-conflict';
  }
}
export class ContentTooLargeError extends Error {
  readonly status = 413;
  constructor(message: string) { super(message); this.name = 'ContentTooLargeError'; }
}
