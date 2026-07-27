import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const authorityEdges = sqliteTable(
  "authority_edges",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    fromAgentId: text("from_agent_id").notNull(),
    toAgentId: text("to_agent_id").notNull(),
    relation: text("relation").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    edgeUniq: uniqueIndex("authority_edges_org_edge_uniq").on(
      t.organizationId,
      t.fromAgentId,
      t.toAgentId,
      t.relation,
    ),
    orgRelationIdx: index("authority_edges_org_relation_idx").on(t.organizationId, t.relation),
  }),
);

export const routingDecisions = sqliteTable(
  "routing_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    selectedAgentId: text("selected_agent_id"),
    departmentId: text("department_id"),
    authorityPathJson: text("authority_path_json").notNull().default("[]"),
    escalationId: text("escalation_id"),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    requestUniq: uniqueIndex("routing_decisions_org_key_uniq").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    orgStatusIdx: index("routing_decisions_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const delegations = sqliteTable(
  "delegations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedByAgentId: text("requested_by_agent_id"),
    targetAgentId: text("target_agent_id").notNull(),
    workItemId: text("work_item_id"),
    authorityPathJson: text("authority_path_json").notNull().default("[]"),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    requestUniq: uniqueIndex("delegations_org_key_uniq").on(t.organizationId, t.idempotencyKey),
    orgStatusIdx: index("delegations_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const escalations = sqliteTable(
  "escalations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    requestedByAgentId: text("requested_by_agent_id"),
    targetAgentId: text("target_agent_id"),
    risk: text("risk").notNull(),
    reason: text("reason").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    authorityPathJson: text("authority_path_json").notNull().default("[]"),
    status: text("status").notNull(),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    subjectUniq: uniqueIndex("escalations_org_subject_uniq").on(
      t.organizationId,
      t.subjectType,
      t.subjectId,
    ),
    orgStatusIdx: index("escalations_org_status_idx").on(t.organizationId, t.status),
  }),
);

export type AuthorityEdgeRow = typeof authorityEdges.$inferSelect;
export type RoutingDecisionRow = typeof routingDecisions.$inferSelect;
export type DelegationRow = typeof delegations.$inferSelect;
export type EscalationRow = typeof escalations.$inferSelect;
