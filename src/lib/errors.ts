/**
 * Typed domain errors. Route handlers map these to HTTP responses without ever
 * leaking internals: the public message comes from the table below, never from
 * a caught exception's own message.
 */

export type DomainErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "insufficient_funds"
  | "insufficient_shares"
  | "market_not_open"
  | "market_closed"
  | "invalid_transition"
  | "rate_limited"
  | "internal_error";

const DEFAULT_STATUS: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  insufficient_funds: 422,
  insufficient_shares: 422,
  market_not_open: 422,
  market_closed: 422,
  invalid_transition: 409,
  rate_limited: 429,
  internal_error: 500,
};

/** Machine-readable, user-safe summary shared with the client. */
const DEFAULT_MESSAGE: Record<DomainErrorCode, string> = {
  validation_failed: "The request contains invalid values.",
  unauthenticated: "You need to sign in to do that.",
  forbidden: "You do not have permission to do that.",
  not_found: "That item could not be found.",
  conflict: "That action conflicts with the current state.",
  idempotency_conflict: "This request was already retried with different contents.",
  insufficient_funds: "Not enough available balance for this order.",
  insufficient_shares: "You do not own enough shares to sell.",
  market_not_open: "This market is not open for trading.",
  market_closed: "This market has closed.",
  invalid_transition: "That state change is not allowed.",
  rate_limited: "Too many requests. Please slow down.",
  internal_error: "Something went wrong. Please try again.",
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  /** Field-level details safe to return to the client. */
  readonly details?: Record<string, string>;

  constructor(
    code: DomainErrorCode,
    options: { message?: string; details?: Record<string, string>; cause?: unknown } = {}
  ) {
    super(options.message ?? DEFAULT_MESSAGE[code], { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.status = DEFAULT_STATUS[code];
    this.details = options.details;
  }
}

export function validationError(details: Record<string, string>): DomainError {
  return new DomainError("validation_failed", { details });
}

export function notFound(what = "Resource"): DomainError {
  return new DomainError("not_found", { message: `${what} not found.` });
}

/** Public, sanitised shape returned by API routes on failure. */
export type ApiErrorBody = {
  error: { code: DomainErrorCode; message: string; details?: Record<string, string> };
};

export function toApiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  // Unexpected failure: log server-side, return a generic message.
  console.error("[api] unhandled error", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
  return {
    status: 500,
    body: { error: { code: "internal_error", message: DEFAULT_MESSAGE.internal_error } },
  };
}

export function assert(condition: unknown, error: DomainError): asserts condition {
  if (!condition) throw error;
}
