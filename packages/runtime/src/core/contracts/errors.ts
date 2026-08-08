/**
 * Runtime error taxonomy. Providers translate SDK/provider errors into
 * these codes. Sessions/execution never parse provider-native error
 * shapes (SandboxNotFoundError, DaytonaTimeoutError, kubectl stderr,
 * HTTP 404 bridge errors, ...).
 */

export type RuntimeErrorCode =
  | "CONFIG_INVALID"
  | "CREDENTIALS_MISSING"
  | "PROVIDER_UNAVAILABLE"
  | "PROVISION_FAILED"
  | "LEASE_NOT_FOUND"
  | "LEASE_EXPIRED"
  | "LEASE_NOT_RESUMABLE"
  | "WORKSPACE_FAILED"
  | "EXECUTION_FAILED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "FILESYSTEM_FAILED"
  | "HIBERNATE_UNSUPPORTED"
  | "RELEASE_FAILED"
  | "DESTROY_FAILED"
  | "UNKNOWN";

export interface RuntimeErrorOptions {
  operation?: string;
  provider?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

const SECRET_KEY = /(api.?key|token|secret|password|credential|private|auth|bearer|cookie)/i;

function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(
      /(api[_-]?key|token|secret|password|credential|private[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeValue(child, depth + 1);
    }
    return output;
  }
  return value;
}

function sanitizeDetails(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeValue(value);
    }
  }
  return output;
}

function sanitizeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: redactText(cause.message),
      ...("code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
    };
  }
  return sanitizeValue(cause);
}

function defaultRetryable(code: RuntimeErrorCode): boolean {
  return ["PROVIDER_UNAVAILABLE", "EXECUTION_TIMEOUT", "LEASE_EXPIRED"].includes(code);
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly operation?: string;
  readonly provider?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    cause?: unknown,
    options: RuntimeErrorOptions = {},
  ) {
    super(redactText(message));
    this.name = "RuntimeError";
    this.code = code;
    this.operation = options.operation;
    this.provider = options.provider;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.details = sanitizeDetails(options.details);
    this.cause = sanitizeCause(cause);
  }
}

export function runtimeError(
  code: RuntimeErrorCode,
  message: string,
  cause?: unknown,
  options?: RuntimeErrorOptions,
): RuntimeError {
  return new RuntimeError(code, message, cause, options);
}

export function isRuntimeError(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError;
}

/** Translate an unknown thrown value into a RuntimeError (best effort). */
export function classifyError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof Error) {
    return new RuntimeError("UNKNOWN", error.message, error);
  }
  return new RuntimeError("UNKNOWN", String(error), error);
}

/** A provider received a release disposition it does not support. */
export class UnsupportedDispositionError extends RuntimeError {
  readonly disposition: string;
  constructor(disposition: string, provider: string) {
    super(
      "HIBERNATE_UNSUPPORTED",
      `${provider} does not support release disposition "${disposition}"`,
    );
    this.name = "UnsupportedDispositionError";
    this.disposition = disposition;
  }
}

/** A lease could not be resumed because the provider no longer has it. */
export class LeaseExpiredError extends RuntimeError {
  readonly providerLeaseId: string | null;
  constructor(provider: string, providerLeaseId: string | null, reason?: string) {
    super(
      "LEASE_EXPIRED",
      `${provider} lease ${providerLeaseId ?? "<null>"} expired${reason ? `: ${reason}` : ""}`,
    );
    this.name = "LeaseExpiredError";
    this.providerLeaseId = providerLeaseId;
  }
}
