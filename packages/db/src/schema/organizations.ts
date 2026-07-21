import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * better-auth organization plugin tables.
 *
 * Single organization per user for v1 (one org is auto-created on signup).
 * Roles: "owner" | "admin" | "member" — owner can do everything, admin can
 * manage resources, member has read-only on most things.
 */

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  /**
   * P0-34 / B3.2: GDPR right-to-deletion. The org.delete
   * tRPC mutation sets this to now(); the GC cron in
   * `packages/core/src/retention.ts` hard-deletes rows
   * where `deleted_at < now() - 30 days`. The 30-day TTL
   * gives operators a recovery window.
   */
  deletedAt: timestamp("deleted_at"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("owner"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/**
 * Drizzle relations. Phase 12 reads these for `with: { user: true }`
 * in `org.listMembers` (the members page joins member → user for
 * name/email/avatar). Without these, drizzle's query builder can't
 * type-check the `with` clause.
 */
export const memberRelations = relations(member, ({ one }) => ({
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  inviter: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));
