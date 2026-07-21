import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * P1-Auth-3: login_attempt log.
 *
 * One row per sign-in attempt. The lockout policy reads
 * the last 15 minutes of rows for (email, ip) to decide
 * whether to block the current attempt.
 *
 * The table is append-only (no UPDATEs). The retention
 * cron (P0-39 retention sweep) drops rows older than 30d.
 */
export const loginAttempt = pgTable(
  "login_attempt",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    ipAddress: text("ip_address"),
    userId: text("user_id"),
    organizationId: text("organization_id"),
    /**
     * "success" — sign-in completed.
     * "invalid_password" — email exists, wrong password.
     * "invalid_email" — email does not exist.
     * "locked_out" — too many recent fails; refused.
     * "rate_limited" — better-auth's IP rate-limit refused.
     */
    result: text("result").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("login_attempt_email_ip_created_at_idx").on(
      table.email,
      table.ipAddress,
      table.createdAt,
    ),
    index("login_attempt_user_id_idx").on(table.userId),
  ],
);

export type LoginAttempt = typeof loginAttempt.$inferSelect;
export type NewLoginAttempt = typeof loginAttempt.$inferInsert;
