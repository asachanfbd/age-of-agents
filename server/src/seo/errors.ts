/** A request the SEO routes refuse because of what the caller sent. */
export class SeoInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SeoInputError';
  }
}

/** An uploaded file is larger than the limit. */
export class SeoTooLargeError extends Error {
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = 'SeoTooLargeError';
  }
}

/** The request is fine but the Building's current state refuses it (sync already running, confirmation missing, ...). */
export class SeoConflictError extends Error {
  readonly status = 409;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
    this.name = 'SeoConflictError';
  }
}

/** Google, Bing or the network refused or failed a call the person did not cause. */
export class SeoUpstreamError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'SeoUpstreamError';
  }
}

export type ServiceFailure = 'auth' | 'access' | 'quota' | 'network' | 'invalid';

/** What a Google/Bing call failed with, sorted by what the sync should do about it. */
export class ServiceError extends Error {
  readonly kind: ServiceFailure;
  readonly retryAfterMs?: number;
  constructor(kind: ServiceFailure, message: string, retryAfterMs?: number) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.name = 'ServiceError';
  }
}

/** The Building has no SEO settings: it was deleted, or is not an SEO Building. */
export class SeoNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'This is not an SEO Building') {
    super(message);
    this.name = 'SeoNotFoundError';
  }
}

/** An action was refused because it is too soon after the last one; `details.retryAt` says when it is allowed again. */
export class SeoRateLimitError extends Error {
  readonly status = 429;
  readonly code = 'rate-limited';
  readonly details: { retryAt: string };
  constructor(message: string, retryAt: string) {
    super(message);
    this.details = { retryAt };
    this.name = 'SeoRateLimitError';
  }
}
