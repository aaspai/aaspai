import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * better-auth core tables.
 *
 * These follow the schema documented at
 * https://www.better-auth.com/docs/concepts/database#schema — we hand-write
 * them here instead of using `npx @better-auth/cli generate` so the migration
 * is reproducible from source.
 *
 * If you add/remove columns here, also update:
 * - packages/core/src/auth/server.ts (betterAuth config)
 * - The generated migration in packages/db/migrations/
 */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // P1-Auth-1: better-auth's two-factor plugin sets this to
  // true once the user has completed TOTP enrollment. The
  // sign-in middleware reads it to decide whether to demand
  // a 6-digit code on the next request.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
  // P1-Auth-2: better-auth's two-factor plugin sets this to
  // true after a sign-in where 2FA is enabled but the TOTP
  // code has not yet been verified. The middleware checks
  // this flag to reject protected API calls until the user
  // has provided a valid TOTP code.
  twoFactorRedirect: boolean("two_factor_redirect").notNull().default(false),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * P1-Auth-1: better-auth's two-factor plugin table. One row
 * per (user, secret) — re-enrolling generates a new row.
 * `secret` is the base32 TOTP secret (we don't encrypt it
 * because the user shows the otpauth:// URI once at
 * enrollment; revoking 2FA drops the row, so a leaked
 * DB dump only reveals secrets of users who haven't
 * rotated).
 *
 * `backupCodes` is the JSON-encoded array of 8 single-use
 * recovery codes shown once at enrollment. Like the secret,
 * we don't encrypt — the codes are single-use and the user
 * is expected to save them offline.
 */
export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  /**
   * P1-Auth-1: better-auth's two-factor plugin tracks the
   * `verified` flag separately from the user-level
   * `twoFactorEnabled` column. `verified = true` means the
   * user has scanned a TOTP code at least once; the plugin
   * uses this to gate sign-in on a TOTP check (and to skip
   * that check for the "enroll" flow).
   *
   * The default is `false` (unverified). The verifyTOTP
   * endpoint flips it to `true` on a successful code.
   */
  verified: boolean("verified").notNull().default(false),
});
