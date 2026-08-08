/**
 * Shell quoting and environment validation. Shared only where behavior
 * is genuinely identical across providers.
 */

/** Single-quote with embedded-single-quote escape. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a POSIX environment variable key. Throws on invalid keys. */
export function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(`Invalid environment variable name: ${JSON.stringify(key)}`);
  }
}

/** Validate an env map; returns the map or throws listing all invalid keys. */
export function assertValidEnvMap(env: Record<string, unknown> | undefined): void {
  if (!env) return;
  const invalid = Object.keys(env).filter((key) => !ENV_KEY_RE.test(key));
  if (invalid.length > 0) {
    throw new Error(`Invalid environment variable names: ${invalid.join(", ")}`);
  }
}

/**
 * Serialize an env map into `KEY='value'` assignments suitable for
 * `env A=1 B='2' command`. Validates keys; values are shell-quoted.
 */
export function serializeEnvArgs(env: Record<string, string> | undefined): string {
  assertValidEnvMap(env);
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}
