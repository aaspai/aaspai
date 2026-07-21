import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM authenticated encryption for secrets at rest.
 *
 * Output format: `<iv-base64>:<ciphertext-base64>:<tag-base64>`
 *   - iv: 12 random bytes (recommended size for GCM)
 *   - ciphertext: variable length
 *   - tag: 16 bytes (GCM auth tag)
 *
 * Key ring (REVIEW-2026-06-28 P0-26):
 *   The encryption key is derived from one of:
 *     1. `AASPAI_ENCRYPTION_KEYS` (preferred) — comma-separated ring
 *        of keys. KEY1 is the current key (used for encrypt);
 *        all keys in the ring are tried in order on decrypt.
 *     2. `AASPAI_ENCRYPTION_KEY` (single key) — kept for
 *        back-compat; equivalent to a 1-element ring.
 *     3. `BETTER_AUTH_SECRET` (fallback) — the previous default.
 *        Still works, but produces a warning in production so
 *        operators know to migrate.
 *
 *   The key is derived from any of these via SHA-256 (so the
 *   input length doesn't have to match 32 bytes).
 *
 *   In production, `AASPAI_ENCRYPTION_KEYS` or
 *   `AASPAI_ENCRYPTION_KEY` MUST be set; falling back to
 *   `BETTER_AUTH_SECRET` in production throws. Rotating
 *   `BETTER_AUTH_SECRET` would otherwise silently brick every
 *   encrypted column (GCM auth tag fails on first decrypt).
 *
 * Used to encrypt:
 *   - GitHub App private key (in `git_connection.github_private_key_encrypted`)
 *   - GitHub webhook secret (in `git_connection.github_webhook_secret_encrypted`)
 *   - SSH private keys (`ssh_key.private_key_encrypted`)
 *   - Registry tokens (`registry.token_encrypted`)
 *   - Notification channel configs
 *   - Destination configs
 *   - Database root passwords
 *
 * Decryption throws if:
 *   - the ciphertext is malformed
 *   - the key is missing
 *   - the GCM tag doesn't verify for every key in the ring
 *     (tampered or wrong key)
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const SEPARATOR = ":";

/**
 * Derive a 32-byte AES key from a user-provided secret. SHA-256 is the
 * standard approach when you can't enforce 32-byte input lengths.
 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

let warnedFallback = false;

/**
 * Resolve the active encryption keys as an ordered ring.
 * The first key is the "current" key (used for encrypt).
 * Decrypt tries each key in order until the GCM tag verifies.
 *
 * In production we refuse to fall back to `BETTER_AUTH_SECRET`:
 * rotating that secret (a routine security hygiene) would
 * silently brick every encrypted column.
 */
function resolveKeyRing(): Buffer[] {
  const ring = process.env.AASPAI_ENCRYPTION_KEYS?.trim();
  if (ring && ring.length > 0) {
    return ring
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .map(deriveKey);
  }
  const single = process.env.AASPAI_ENCRYPTION_KEY?.trim();
  if (single && single.length > 0) {
    return [deriveKey(single)];
  }
  const fallback = process.env.BETTER_AUTH_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AASPAI_ENCRYPTION_KEYS (preferred) or AASPAI_ENCRYPTION_KEY must be set in production. " +
        "Falling back to BETTER_AUTH_SECRET would make routine secret rotations silently destroy all encrypted columns. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  if (!fallback) {
    throw new Error(
      "Cannot encrypt/decrypt: AASPAI_ENCRYPTION_KEYS, AASPAI_ENCRYPTION_KEY, or BETTER_AUTH_SECRET must be set",
    );
  }
  if (!warnedFallback) {
    console.warn(
      "[crypto] falling back to BETTER_AUTH_SECRET for encryption. Set AASPAI_ENCRYPTION_KEYS in production to enable key rotation.",
    );
    warnedFallback = true;
  }
  return [deriveKey(fallback)];
}

/**
 * Encrypt a UTF-8 string. Returns the `iv:ciphertext:tag` envelope.
 * The same plaintext + key will produce different ciphertexts on each
 * call because the IV is random.
 *
 * Uses the first (current) key in the ring.
 */
export function encrypt(plaintext: string, key?: Buffer): string {
  const k = key ?? resolveKeyRing()[0];
  if (!k) {
    throw new Error("Encryption key ring is empty");
  }
  if (k.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes, got ${k.length}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}${SEPARATOR}${ciphertext.toString("base64")}${SEPARATOR}${tag.toString("base64")}`;
}

/**
 * Decrypt an `iv:ciphertext:tag` envelope back to the original UTF-8 string.
 * Tries every key in the ring in order. Throws on:
 *   - malformed input
 *   - empty key ring
 *   - no key in the ring verifies the GCM auth tag
 */
export function decrypt(envelope: string, key?: Buffer): string {
  if (key) {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Decryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
    }
    return decryptWithKey(envelope, key);
  }
  const ring = resolveKeyRing();
  if (ring.length === 0) {
    throw new Error("Decryption key ring is empty");
  }
  let lastError: unknown = null;
  for (const k of ring) {
    try {
      return decryptWithKey(envelope, k);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `No key in the encryption key ring (${ring.length} key(s)) could decrypt the envelope: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function decryptWithKey(envelope: string, k: Buffer): string {
  const parts = envelope.split(SEPARATOR);
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext envelope: expected iv:ciphertext:tag");
  }
  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, k, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Test-only helper: derive a key from a string without reading process.env.
 * Production code should never call this; the key comes from the env.
 */
export function deriveKeyForTest(secret: string): Buffer {
  return deriveKey(secret);
}

/**
 * Test-only helper: reset the warned-once flag so tests can re-exercise
 * the fallback warning path.
 */
export function resetCryptoWarningsForTest(): void {
  warnedFallback = false;
}
