/**
 * Lease metadata security rules. Lease metadata is persisted across
 * workers and must never carry secrets or non-serializable values.
 */

const ALLOWED_METADATA_KEYS = new Set([
  "provider",
  "remoteCwd",
  "shellCommand",
  "region",
  "image",
  "resourceClass",
  "nativeState",
  "backend",
  "namespace",
  "podName",
  "resumed",
]);

const FORBIDDEN_KEY_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /private/i,
  /auth/i,
  /bearer/i,
  /ssh/i,
];

function isPlainSerializable(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every((v) => isPlainSerializable(v, depth + 1));
  if (t === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) =>
      isPlainSerializable(v, depth + 1),
    );
  }
  return false;
}

function containsSecretKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null) return false;
  if (typeof value === "string") {
    return /(Bearer\s+\S+|api[_-]?key\s*[:=]|token\s*[:=]|secret\s*[:=]|password\s*[:=])/i.test(
      value,
    );
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretKey(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key)) || containsSecretKey(child, depth + 1),
  );
}

export interface SanitizedLeaseMetadata {
  metadata: Record<string, unknown>;
  droppedKeys: string[];
}

/**
 * Sanitize provider metadata before it is persisted on a lease. Drops
 * secret-like keys and non-serializable values; returns what was kept
 * and what was dropped.
 */
export function sanitizeLeaseMetadata(
  input: Record<string, unknown> | undefined,
): SanitizedLeaseMetadata {
  if (!input) return { metadata: {}, droppedKeys: [] };
  const metadata: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key)) || containsSecretKey(value)) {
      droppedKeys.push(key);
      continue;
    }
    if (!isPlainSerializable(value)) {
      droppedKeys.push(key);
      continue;
    }
    metadata[key] = value;
  }
  return { metadata, droppedKeys };
}

/** Is this a provider config key that must not be echoed into logs/metadata? */
export function isSecretConfigKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key));
}

export function allowedMetadataKey(key: string): boolean {
  if (ALLOWED_METADATA_KEYS.has(key)) return true;
  return !FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key));
}

const REDACTED = "[redacted]";

/** Redact secret-shaped values inside an arbitrary structure (deep clone). */
export function redactSecrets<T>(input: T, depth = 0): T {
  if (depth > 8) return input;
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretConfigKey(key) && typeof value === "string") {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecrets(value, depth + 1);
    }
  }
  return out as T;
}
