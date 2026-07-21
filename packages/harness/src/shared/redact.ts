/**
 * Log + command redaction helpers shared by every adapter.
 *
 * Two distinct concerns:
 *
 * 1. **Home-path redaction** — strip the user's home directory from any
 *    log line so absolute paths in transcripts don't leak the username.
 *    `REDACTED_HOME_PATH_USER` is the placeholder we substitute.
 *
 * 2. **Secret redaction** — substitute well-known secret env var names
 *    (API keys, tokens, etc.) with `REDACTED_SECRET_VALUE` so they
 *    never reach a log sink. Done at the env-merge boundary, not at the
 *    log line level, to avoid false positives in tool output.
 */

export const REDACTED_HOME_PATH_USER = "~";
export const REDACTED_SECRET_VALUE = "[REDACTED]";

const ENV_SECRET_PATTERN =
  /(?:^|[^A-Z0-9_])(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTHORIZATION|BEARER)(?:$|[^A-Z0-9_])/i;

const SENSITIVE_ENV_KEYS = new Set<string>([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENCLAW_TOKEN",
  "HERMES_API_KEY",
  "E2B_API_KEY",
  "DAYTONA_API_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "NOVITA_API_KEY",
  "EXE_DEV_API_KEY",
  "KUBECONFIG",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);

/** Return the path with the user's home directory replaced by `~`. */
export function redactHomePath(input: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return input;
  if (input === home) return REDACTED_HOME_PATH_USER;
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `${REDACTED_HOME_PATH_USER}${input.slice(home.length)}`;
  }
  return input;
}

/** Redact the user's home path from a single value (string or object). */
export function redactHomePathInValue<T>(value: T): T {
  if (typeof value === "string") return redactHomePath(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactHomePathInValue(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactHomePathInValue(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Redact a command line for safe logging. Strips the user's home path
 * and replaces the value of any obvious secret env var.
 */
export function redactCommandText(input: string): string {
  let out = redactHomePath(input);
  out = out.replace(
    /([A-Z][A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY))=([^\s]+)/gi,
    (_match, name) => `${name}=${REDACTED_SECRET_VALUE}`,
  );
  return out;
}

/** Return `env` with known-sensitive keys redacted. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SENSITIVE_ENV_KEYS.has(k) || ENV_SECRET_PATTERN.test(k) ? REDACTED_SECRET_VALUE : v;
  }
  return out;
}
