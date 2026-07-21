import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organizations";

/**
 * API keys (Phase 12, hardened in 13a).
 *
 * Personal access tokens scoped to an organization. The plain
 * token is shown to the user exactly once at creation time;
 * only the SHA-256 hash is stored. Scopes are coarse
 * (`read` | `write` | `deploy`); a token with `deploy` can also
 * read because deploy endpoints return the deployment row.
 *
 * Revocation is soft (`revokedAt`) so we can audit revoked
 * keys without losing history. `lastUsedAt` is bumped on every
 * successful auth (write) — we use this in the UI to surface
 * "last used 3 days ago" on the keys list.
 *
 * **P1-3:** `scopes` is `jsonb` (array), not text/csv. Drizzle
 * types it as `ApiScope[]` so callers don't need to split/join.
 *
 * **P1-27:** `createdByUserId` is the actual user that minted
 * the key (Phase 12 set `userId` to `organizationId` as a
 * placeholder; the real user is now in this column). Nullable
 * for backfill; existing rows are valid.
 */
export const apiKey = pgTable("api_key", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** The user that minted the key. P1-27. */
  createdByUserId: text("created_by_user_id"),
  /** Human-readable label, e.g. "CI key", "Local laptop". */
  name: text("name").notNull(),
  /**
   * SHA-256 hash of the plain token. We never store the plain
   * value. Token format: `aaspai_pat_<base64url 32 bytes>`;
   * the hash is the hex digest of the full string.
   */
  tokenHash: text("token_hash").notNull().unique(),
  /**
   * P1-3: scopes as a JSON array (was text/csv). The default is
   * the most-permissive set; createApiKey lets the caller pass
   * a subset. Read sites use the drizzle `$type<ApiScope[]>()`
   * inference, not string split/join.
   */
  scopes: jsonb("scopes").$type<ApiScope[]>().notNull().default(["read", "write", "deploy"]),
  /** Set by the `validateApiKey` middleware on each use. */
  lastUsedAt: timestamp("last_used_at"),
  /** Optional expiry; null = never expires. */
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  /** Soft revocation; null = active. */
  revokedAt: timestamp("revoked_at"),
});

/**
 * ApiScope is a string-literal union; we declare it here too
 * (also exported by the contracts package as `SCOPE_VALUES`) so the drizzle
 * `$type<ApiScope[]>()` annotation can use it without a
 * cross-package import. The two are kept in sync by tests.
 *
 * P0-55: `read.history` is the deployment-history scope. Any
 * key with `read` (live) can read the current service state,
 * but reading the deployment history requires `read.history`
 * (or `deploy`, which is implicitly a superset). The split
 * matters for monitoring agents that should see "is the
 * service up?" but not "every deploy ever".
 */
export const API_SCOPE_VALUES = ["read", "read.history", "write", "deploy"] as const;
export type ApiScope = (typeof API_SCOPE_VALUES)[number];
