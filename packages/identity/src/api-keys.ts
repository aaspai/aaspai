import { createHash, randomUUID } from "node:crypto";

const API_KEY_PREFIX = "aaspai_pat_";

export { API_KEY_PREFIX };

/**
 * Generate a new plain API key + its SHA-256 hash.
 * The plain value is shown once to the user; the hash
 * is persisted for verification.
 */
export function generateApiKey(): { plain: string; hash: string; id: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const plain = `${API_KEY_PREFIX}${b64}`;
  const hash = createHash("sha256").update(plain).digest("hex");
  return { plain, hash, id: randomUUID() };
}

/**
 * Validate an API key from a bearer token.
 * Returns the key context or null if invalid/revoked/expired.
 *
 * Takes an `ApiKeyRepository` to avoid direct database coupling.
 */
export async function validateApiKey(
  repository: {
    findByHash(hash: string): Promise<{
      id: string;
      userId: string;
      organizationId: string;
      scopes: string[];
      createdByUserId: string | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    } | null>;
    touchLastUsed(apiKeyId: string): Promise<void>;
  },
  token: string,
): Promise<{
  apiKeyId: string;
  userId: string;
  organizationId: string;
  scopes: string[];
} | null> {
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const row = await repository.findByHash(hash);
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  const scopes = row.scopes.length > 0 ? row.scopes : ["read", "write", "deploy"];

  repository.touchLastUsed(row.id).catch(() => {
    /* swallow */
  });

  // B3: Fail closed when createdByUserId is null. Without knowing who
  // created the key, we cannot verify authorization — falling back to
  // organizationId would conflate a user id with an org id, violating
  // the identity model. If the key was minted before the column existed,
  // a backfill table (not yet implemented) should supply the original
  // minter. Until then, the key is treated as unknown.
  if (!row.createdByUserId) return null;

  return {
    apiKeyId: row.id,
    userId: row.createdByUserId,
    organizationId: row.organizationId,
    scopes,
  };
}

/**
 * Lockout policy constants and check logic.
 * "5 fails in 15min -> block for 30min" per (email, ip).
 */

export const DEFAULT_FAIL_THRESHOLD = 5;
export const DEFAULT_FAIL_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_LOCKOUT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Check whether the given (email, ip) is currently locked out.
 */
export async function isLockedOut(
  repository: {
    countRecentFails(email: string, ipAddress: string | null, since: Date): Promise<number>;
    newestFailAt(email: string, ipAddress: string | null, since: Date): Promise<Date | null>;
  },
  input: {
    email: string;
    ipAddress: string | null;
    failThreshold?: number;
    failWindowMs?: number;
    lockoutWindowMs?: number;
  },
): Promise<{ locked: boolean; retryAfterSec: number }> {
  const failThreshold = input.failThreshold ?? DEFAULT_FAIL_THRESHOLD;
  const failWindowMs = input.failWindowMs ?? DEFAULT_FAIL_WINDOW_MS;
  const lockoutWindowMs = input.lockoutWindowMs ?? DEFAULT_LOCKOUT_WINDOW_MS;

  const since = new Date(Date.now() - failWindowMs);
  const failCount = await repository.countRecentFails(input.email, input.ipAddress, since);

  if (failCount < failThreshold) {
    return { locked: false, retryAfterSec: 0 };
  }

  const newest = await repository.newestFailAt(input.email, input.ipAddress, since);
  if (!newest) return { locked: false, retryAfterSec: 0 };

  const lockoutEndsAt = newest.getTime() + lockoutWindowMs;
  const now = Date.now();

  if (now < lockoutEndsAt) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((lockoutEndsAt - now) / 1000),
    };
  }

  return { locked: false, retryAfterSec: 0 };
}
