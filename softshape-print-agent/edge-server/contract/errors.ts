// ─────────────────────────────────────────────────────────────────────────────
// contract/errors.ts — Stable Runtime error codes and failure classification
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — codes are part of the wire format. Clients and the cloud
// branch on `code`, never on message text.
//
// Failure classification is the core safety rule of Runtime v2:
//
//   PERMANENT — the input can never succeed as-is (validation, ownership,
//               schema, business rejection). Roll back, return the error, and
//               record it for audit/DLQ. Never retried automatically.
//   TRANSIENT — the operation may succeed unchanged (lock contention, disk
//               busy, network). Roll back and retry with backoff. Never
//               dead-lettered on the first failures.
//   UNKNOWN   — unclassified/unexpected. Treated as PERMANENT so a poison
//               input cannot spin forever, but always surfaced loudly.
//
// An UNKNOWN error must never leave a committed event without its projection:
// classification only decides what happens AFTER the transaction rolls back.
// ─────────────────────────────────────────────────────────────────────────────

export type FailureClass = "PERMANENT" | "TRANSIENT" | "UNKNOWN";

export const RUNTIME_ERROR_CODES = {
  // ── Validation / schema (permanent) ────────────────────────────────────────
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  UNKNOWN_EVENT_TYPE: "UNKNOWN_EVENT_TYPE",
  UNSUPPORTED_SCHEMA_VERSION: "UNSUPPORTED_SCHEMA_VERSION",
  MALFORMED_PAYLOAD: "MALFORMED_PAYLOAD",
  MISSING_REQUEST_ID: "MISSING_REQUEST_ID",

  // ── Ownership / tenancy (permanent) ────────────────────────────────────────
  OWNERSHIP_VIOLATION: "OWNERSHIP_VIOLATION",
  TENANT_MISMATCH: "TENANT_MISMATCH",
  UNKNOWN_AGGREGATE: "UNKNOWN_AGGREGATE",

  // ── Authentication / authorization (permanent) ─────────────────────────────
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",

  // ── Business rejection (permanent) ─────────────────────────────────────────
  BUSINESS_RULE_REJECTED: "BUSINESS_RULE_REJECTED",
  AGGREGATE_NOT_FOUND: "AGGREGATE_NOT_FOUND",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  DUPLICATE_EVENT_ID: "DUPLICATE_EVENT_ID",

  // ── Runtime availability (transient) ───────────────────────────────────────
  RUNTIME_NOT_READY: "RUNTIME_NOT_READY",
  READ_ONLY_MODE: "READ_ONLY_MODE",
  DATABASE_BUSY: "DATABASE_BUSY",
  NETWORK_UNAVAILABLE: "NETWORK_UNAVAILABLE",
  CLOUD_UNAVAILABLE: "CLOUD_UNAVAILABLE",
  TIMEOUT: "TIMEOUT",

  // ── Sync protocol ─────────────────────────────────────────────────────────
  CURSOR_GAP: "CURSOR_GAP",              // transient: refetch from last good cursor
  SNAPSHOT_CHECKSUM_MISMATCH: "SNAPSHOT_CHECKSUM_MISMATCH", // transient: re-download
  SNAPSHOT_INVALID: "SNAPSHOT_INVALID",  // permanent: cloud sent unusable data

  // ── Catch-all ─────────────────────────────────────────────────────────────
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

// ── Code → class map ─────────────────────────────────────────────────────────
// Exhaustive by construction: every code above appears here.

const ERROR_CLASS: Record<RuntimeErrorCode, FailureClass> = {
  [RUNTIME_ERROR_CODES.VALIDATION_FAILED]: "PERMANENT",
  [RUNTIME_ERROR_CODES.UNKNOWN_COMMAND]: "PERMANENT",
  [RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE]: "PERMANENT",
  [RUNTIME_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION]: "PERMANENT",
  [RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD]: "PERMANENT",
  [RUNTIME_ERROR_CODES.MISSING_REQUEST_ID]: "PERMANENT",
  [RUNTIME_ERROR_CODES.OWNERSHIP_VIOLATION]: "PERMANENT",
  [RUNTIME_ERROR_CODES.TENANT_MISMATCH]: "PERMANENT",
  [RUNTIME_ERROR_CODES.UNKNOWN_AGGREGATE]: "PERMANENT",
  [RUNTIME_ERROR_CODES.UNAUTHENTICATED]: "PERMANENT",
  [RUNTIME_ERROR_CODES.FORBIDDEN]: "PERMANENT",
  [RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED]: "PERMANENT",
  [RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND]: "PERMANENT",
  [RUNTIME_ERROR_CODES.REVISION_CONFLICT]: "PERMANENT",
  [RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID]: "PERMANENT",
  [RUNTIME_ERROR_CODES.SNAPSHOT_INVALID]: "PERMANENT",

  [RUNTIME_ERROR_CODES.RUNTIME_NOT_READY]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.READ_ONLY_MODE]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.DATABASE_BUSY]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.NETWORK_UNAVAILABLE]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.CLOUD_UNAVAILABLE]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.TIMEOUT]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.CURSOR_GAP]: "TRANSIENT",
  [RUNTIME_ERROR_CODES.SNAPSHOT_CHECKSUM_MISMATCH]: "TRANSIENT",

  // Unclassified failures are handled as permanent so they cannot retry forever.
  [RUNTIME_ERROR_CODES.INTERNAL_ERROR]: "UNKNOWN",
};

export function classifyErrorCode(code: string): FailureClass {
  const known = ERROR_CLASS[code as RuntimeErrorCode];
  return known ?? "UNKNOWN";
}

// UNKNOWN behaves like PERMANENT for retry purposes: do not retry, surface it.
export function isRetryable(code: string): boolean {
  return classifyErrorCode(code) === "TRANSIENT";
}

// ── RuntimeError ─────────────────────────────────────────────────────────────
// The only error type command handlers, projections and appliers should throw
// deliberately. Anything else is caught and mapped to INTERNAL_ERROR/UNKNOWN.

export interface RuntimeErrorDetails {
  [key: string]: unknown;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: RuntimeErrorDetails;

  constructor(code: RuntimeErrorCode, message: string, details?: RuntimeErrorDetails) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
  }

  get failureClass(): FailureClass {
    return classifyErrorCode(this.code);
  }

  get retryable(): boolean {
    return this.failureClass === "TRANSIENT";
  }
}

export function isRuntimeError(err: unknown): err is RuntimeError {
  return err instanceof RuntimeError;
}

// ── SQLite error mapping ─────────────────────────────────────────────────────
// bun:sqlite surfaces lock contention as SQLITE_BUSY / SQLITE_LOCKED. Those are
// genuinely transient and must not poison an event into the DLQ.

const TRANSIENT_SQLITE_PATTERNS = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "database is locked",
  "database table is locked",
];

export function normalizeError(err: unknown): RuntimeError {
  if (isRuntimeError(err)) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (TRANSIENT_SQLITE_PATTERNS.some((p) => message.includes(p))) {
    return new RuntimeError(RUNTIME_ERROR_CODES.DATABASE_BUSY, message);
  }

  return new RuntimeError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, message);
}

// ── Wire error envelope ──────────────────────────────────────────────────────

export interface RuntimeErrorResponse {
  ok: false;
  code: RuntimeErrorCode;
  error: string;
  retryable: boolean;
  details?: RuntimeErrorDetails;
}

export function toErrorResponse(err: unknown): RuntimeErrorResponse {
  const runtimeError = normalizeError(err);
  return {
    ok: false,
    code: runtimeError.code,
    error: runtimeError.message,
    retryable: runtimeError.retryable,
    ...(runtimeError.details ? { details: runtimeError.details } : {}),
  };
}

// ── HTTP status mapping ──────────────────────────────────────────────────────

export function errorHttpStatus(code: RuntimeErrorCode): number {
  switch (code) {
    case RUNTIME_ERROR_CODES.UNAUTHENTICATED:
      return 401;
    case RUNTIME_ERROR_CODES.FORBIDDEN:
    case RUNTIME_ERROR_CODES.OWNERSHIP_VIOLATION:
    case RUNTIME_ERROR_CODES.TENANT_MISMATCH:
      return 403;
    case RUNTIME_ERROR_CODES.AGGREGATE_NOT_FOUND:
      return 404;
    case RUNTIME_ERROR_CODES.REVISION_CONFLICT:
    case RUNTIME_ERROR_CODES.DUPLICATE_EVENT_ID:
      return 409;
    case RUNTIME_ERROR_CODES.VALIDATION_FAILED:
    case RUNTIME_ERROR_CODES.UNKNOWN_COMMAND:
    case RUNTIME_ERROR_CODES.UNKNOWN_EVENT_TYPE:
    case RUNTIME_ERROR_CODES.UNKNOWN_AGGREGATE:
    case RUNTIME_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION:
    case RUNTIME_ERROR_CODES.MALFORMED_PAYLOAD:
    case RUNTIME_ERROR_CODES.MISSING_REQUEST_ID:
    case RUNTIME_ERROR_CODES.BUSINESS_RULE_REJECTED:
    case RUNTIME_ERROR_CODES.SNAPSHOT_INVALID:
      return 400;
    case RUNTIME_ERROR_CODES.RUNTIME_NOT_READY:
    case RUNTIME_ERROR_CODES.READ_ONLY_MODE:
      return 503;
    case RUNTIME_ERROR_CODES.DATABASE_BUSY:
      return 503;
    case RUNTIME_ERROR_CODES.TIMEOUT:
      return 504;
    case RUNTIME_ERROR_CODES.NETWORK_UNAVAILABLE:
    case RUNTIME_ERROR_CODES.CLOUD_UNAVAILABLE:
    case RUNTIME_ERROR_CODES.CURSOR_GAP:
    case RUNTIME_ERROR_CODES.SNAPSHOT_CHECKSUM_MISMATCH:
      return 502;
    case RUNTIME_ERROR_CODES.INTERNAL_ERROR:
    default:
      return 500;
  }
}
