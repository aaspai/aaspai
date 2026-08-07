import { createHash } from "node:crypto";

/**
 * Deterministic idempotency key for a request payload. Deriving it from
 * a stable hash (not `Date.now()`) means a retried request with the same
 * body produces the same key, so the command service can de-duplicate
 * instead of silently creating duplicates. The hash includes the type so
 * different command kinds never collide.
 */
export function deriveIdempotencyKey(body: unknown, prefix?: string): string {
  const type =
    body && typeof body === "object" && "type" in body && typeof body.type === "string"
      ? body.type
      : "command";
  const stable = JSON.stringify(body ?? {});
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 24);
  return `${prefix ?? type}:${digest}`;
}
