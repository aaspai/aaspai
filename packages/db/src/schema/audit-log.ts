import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * B3.1: audit log.
 *
 * Every tRPC mutation that mutates org-scoped state emits
 * a row. Append-only; a separate retention cron prunes
 * old rows (default 1 year).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().notNull(),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("audit_log_organization_id_created_at_idx").on(t.organizationId, t.createdAt),
    index("audit_log_actor_user_id_idx").on(t.actorUserId),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
