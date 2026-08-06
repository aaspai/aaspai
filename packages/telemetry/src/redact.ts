import { MAX_OTLP_BODY_BYTES } from "@aaspai/contracts";

/**
 * Telemetry redaction and size enforcement.
 *
 * Redaction runs before persistence. Secret-looking keys are replaced
 * with a marker value; bodies and raw payloads that carry secrets are
 * bounded and, when a known secret key pattern appears, replaced.
 *
 * Size limits follow the plan §8.2: reject or quarantine oversized
 * attributes and payloads, never crash the producer.
 */

export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_MARKER_KEY = "aaspai.redacted";

const SECRET_KEY_PATTERN =
  /(?:^|[^a-z0-9])(?:api[_-]?key|secret|token|password|private[_-]?key|access[_-]?key|authorization|bearer|refresh[_-]?token|session[_-]?secret|client[_-]?secret)(?:$|[^a-z0-9])/i;

const SECRET_VALUE_PATTERN =
  /\b(?:sk-|ghp_|gho_|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[a-zA-Z0-9_-]{10,})\b/;

export interface RedactionOptions {
  /** Max number of attributes kept on a single event. */
  maxAttributeCount: number;
  /** Max bytes for a single attribute value. */
  maxAttributeValueBytes: number;
  /** Max bytes for a stored raw payload. */
  maxRawPayloadBytes: number;
  /** Max bytes for a log body. */
  maxBodyBytes: number;
  redactBodies: boolean;
}

export const DEFAULT_REDACTION_OPTIONS: RedactionOptions = {
  maxAttributeCount: 128,
  maxAttributeValueBytes: 8_192,
  maxRawPayloadBytes: 256 * 1024,
  maxBodyBytes: 16_384,
  redactBodies: true,
};

export interface RedactResult<T> {
  value: T;
  redacted: boolean;
  truncated: boolean;
}

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERN.test(value);
}

/** Redact a single scalar value if it looks like a secret. */
export function redactScalar(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    if (looksLikeSecretValue(value) && value.length >= 20) {
      return { value: REDACTED_VALUE, redacted: true };
    }
  }
  return { value, redacted: false };
}

/**
 * Recursively redact and bound a JSON value. Keys that match the secret
 * pattern are replaced with `[REDACTED]`; values that carry secret
 * patterns are replaced when long enough. Deep/wide structures are
 * bounded to prevent unbounded memory growth.
 */
export function redactValue(
  input: unknown,
  options: Partial<RedactionOptions> = {},
): RedactResult<unknown> {
  const opts = { ...DEFAULT_REDACTION_OPTIONS, ...options };
  let redacted = false;
  let truncated = false;

  const visit = (value: unknown, depth: number, budget: { bytes: number }): unknown => {
    if (depth > 64) {
      truncated = true;
      return REDACTED_VALUE;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const budgeted = value.slice(0, budget.bytes);
      if (budgeted.length !== value.length) {
        truncated = true;
        budget.bytes = 0;
      } else {
        budget.bytes -= budgeted.length;
      }
      const scalar = redactScalar(budgeted);
      if (scalar.redacted) redacted = true;
      return scalar.value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value.slice(0, 2_048)) {
        if (budget.bytes <= 0) {
          truncated = true;
          break;
        }
        out.push(visit(item, depth + 1, budget));
      }
      return out;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      let kept = 0;
      for (const [key, val] of Object.entries(obj)) {
        if (kept >= opts.maxAttributeCount) {
          truncated = true;
          break;
        }
        if (budget.bytes <= 0) {
          truncated = true;
          break;
        }
        if (looksLikeSecretKey(key)) {
          redacted = true;
          out[key] = REDACTED_VALUE;
          kept += 1;
          budget.bytes -= key.length;
          continue;
        }
        out[key] = visit(val, depth + 1, budget);
        kept += 1;
      }
      return out;
    }
    return null;
  };

  const budget = { bytes: opts.maxRawPayloadBytes };
  const value = visit(input, 0, budget);
  return { value, redacted, truncated };
}

/** Bound and redact a raw payload object for storage. */
export function redactRawPayload(
  raw: unknown,
  options: Partial<RedactionOptions> = {},
): { rawJson: unknown; redacted: boolean; truncated: boolean } {
  const result = redactValue(raw, options);
  return { rawJson: result.value, redacted: result.redacted, truncated: result.truncated };
}

/** Bound and redact a single string body (e.g. stdout/stderr line). */
export function redactBody(
  body: string,
  options: Partial<RedactionOptions> = {},
): { body: string; redacted: boolean; truncated: boolean } {
  const opts = { ...DEFAULT_REDACTION_OPTIONS, ...options };
  let truncated = false;
  let bodyOut = body.slice(0, opts.maxBodyBytes);
  if (bodyOut.length !== body.length) truncated = true;
  if (opts.redactBodies && looksLikeSecretValue(bodyOut) && bodyOut.length >= 20) {
    bodyOut = REDACTED_VALUE;
    return { body: bodyOut, redacted: true, truncated };
  }
  return { body: bodyOut, redacted: false, truncated };
}

/** Max inbound request body for OTLP ingestion (matches the reference). */
export function enforceBodyLimit(sizeBytes: number): void {
  if (sizeBytes > MAX_OTLP_BODY_BYTES) {
    throw new TelemetrySizeError(`request body exceeds ${MAX_OTLP_BODY_BYTES} bytes`);
  }
}

export class TelemetrySizeError extends Error {
  override readonly name = "TelemetrySizeError";
}
