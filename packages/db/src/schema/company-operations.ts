import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const departments = sqliteTable(
  "departments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    managerAgentId: text("manager_agent_id"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgNameUniq: uniqueIndex("departments_org_name_uniq").on(t.organizationId, t.name),
    orgStatusIdx: index("departments_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const departmentMembers = sqliteTable(
  "department_members",
  {
    departmentId: text("department_id").notNull(),
    organizationId: text("organization_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    memberUniq: uniqueIndex("department_members_department_agent_uniq").on(
      t.departmentId,
      t.agentId,
    ),
    orgAgentIdx: index("department_members_org_agent_idx").on(t.organizationId, t.agentId),
  }),
);

export const serviceAgents = sqliteTable(
  "service_agents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    agentId: text("agent_id").notNull(),
    departmentId: text("department_id"),
    status: text("status").notNull().default("active"),
    heartbeatAt: text("heartbeat_at"),
    lastRunAt: text("last_run_at"),
    failureCount: integer("failure_count").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgAgentUniq: uniqueIndex("service_agents_org_agent_uniq").on(t.organizationId, t.agentId),
    orgStatusIdx: index("service_agents_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const autonomyProposals = sqliteTable(
  "autonomy_proposals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    fromLevel: text("from_level").notNull(),
    toLevel: text("to_level").notNull(),
    rationale: text("rationale").notNull(),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    status: text("status").notNull().default("proposed"),
    proposedBy: text("proposed_by").notNull(),
    reviewedBy: text("reviewed_by"),
    reviewReason: text("review_reason").notNull().default(""),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgStatusIdx: index("autonomy_proposals_org_status_idx").on(t.organizationId, t.status),
    targetIdx: index("autonomy_proposals_target_idx").on(
      t.organizationId,
      t.targetType,
      t.targetId,
    ),
  }),
);

export type DepartmentRow = typeof departments.$inferSelect;
export type DepartmentMemberRow = typeof departmentMembers.$inferSelect;
export type ServiceAgentRow = typeof serviceAgents.$inferSelect;
export type AutonomyProposalRow = typeof autonomyProposals.$inferSelect;
