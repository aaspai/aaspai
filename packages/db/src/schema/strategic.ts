import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Strategic control-plane projections. Execution records remain in execution.ts. */
export const companyProfiles = sqliteTable(
  "company_profiles",
  {
    organizationId: text("organization_id").primaryKey(),
    description: text("description").notNull().default(""),
    lifecycleStatus: text("lifecycle_status").notNull().default("draft"),
    activeDefinitionRevisionId: text("active_definition_revision_id"),
    ceoAgentId: text("ceo_agent_id"),
    operatorAgentId: text("operator_agent_id"),
    timezone: text("timezone").notNull().default("UTC"),
    policyJson: text("policy_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ lifecycleIdx: index("company_profiles_lifecycle_idx").on(t.lifecycleStatus) }),
);

export const companyControlEvents = sqliteTable(
  "company_control_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
  },
  (t) => ({
    orgTimeIdx: index("company_control_events_org_time_idx").on(t.organizationId, t.occurredAt),
    correlationIdx: index("company_control_events_correlation_idx").on(
      t.organizationId,
      t.correlationId,
    ),
  }),
);

export const projectObjectives = sqliteTable(
  "project_objectives",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    contributionJson: text("contribution_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    projectIdx: index("project_objectives_project_idx").on(t.organizationId, t.projectId),
    goalIdx: index("project_objectives_goal_idx").on(t.organizationId, t.goalId),
    primaryUniq: uniqueIndex("project_objectives_primary_uniq")
      .on(t.organizationId, t.projectId)
      .where(sql`${t.isPrimary} = 1`),
  }),
);

export const objectiveMeasurements = sqliteTable(
  "objective_measurements",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    goalId: text("goal_id").notNull(),
    metricKey: text("metric_key").notNull(),
    valueJson: text("value_json").notNull(),
    unit: text("unit"),
    observedAt: text("observed_at").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    goalMetricIdx: index("objective_measurements_goal_metric_idx").on(
      t.organizationId,
      t.goalId,
      t.metricKey,
      t.observedAt,
    ),
  }),
);

export const projectAssignments = sqliteTable(
  "project_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull(),
    allocationPercent: real("allocation_percent").notNull().default(100),
    status: text("status").notNull().default("proposed"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    projectStatusIdx: index("project_assignments_project_status_idx").on(
      t.organizationId,
      t.projectId,
      t.status,
    ),
    agentStatusIdx: index("project_assignments_agent_status_idx").on(
      t.organizationId,
      t.agentId,
      t.status,
    ),
    managerUniq: uniqueIndex("project_assignments_active_manager_uniq")
      .on(t.organizationId, t.projectId)
      .where(sql`${t.role} = 'manager' AND ${t.status} = 'active'`),
  }),
);

export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    outcome: text("outcome").notNull().default(""),
    ownerAgentId: text("owner_agent_id"),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("proposed"),
    acceptanceJson: text("acceptance_json").notNull().default("{}"),
    targetAt: text("target_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    projectSequenceUniq: uniqueIndex("milestones_project_sequence_uniq").on(
      t.organizationId,
      t.projectId,
      t.sequence,
    ),
    projectStatusIdx: index("milestones_project_status_idx").on(
      t.organizationId,
      t.projectId,
      t.status,
    ),
  }),
);

export const processBindings = sqliteTable(
  "process_bindings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    processDefinitionId: text("process_definition_id").notNull(),
    processRevision: integer("process_revision").notNull().default(1),
    ownerAgentId: text("owner_agent_id").notNull(),
    loopId: text("loop_id"),
    status: text("status").notNull().default("draft"),
    performanceJson: text("performance_json").notNull().default("{}"),
    policyJson: text("policy_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    projectStatusIdx: index("process_bindings_project_status_idx").on(
      t.organizationId,
      t.projectId,
      t.status,
    ),
    definitionIdx: index("process_bindings_definition_idx").on(
      t.organizationId,
      t.processDefinitionId,
      t.processRevision,
    ),
  }),
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    entityIdx: index("threads_entity_idx").on(t.organizationId, t.entityType, t.entityId),
  }),
);

export const threadMessages = sqliteTable(
  "thread_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    threadId: text("thread_id").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    threadIdx: index("thread_messages_thread_idx").on(t.organizationId, t.threadId, t.createdAt),
  }),
);

export type CompanyProfileRow = typeof companyProfiles.$inferSelect;
export type CompanyProfileInsert = typeof companyProfiles.$inferInsert;
export type CompanyControlEventRow = typeof companyControlEvents.$inferSelect;
export type CompanyControlEventInsert = typeof companyControlEvents.$inferInsert;
export type ProjectObjectiveRow = typeof projectObjectives.$inferSelect;
export type ProjectObjectiveInsert = typeof projectObjectives.$inferInsert;
export type ObjectiveMeasurementRow = typeof objectiveMeasurements.$inferSelect;
export type ObjectiveMeasurementInsert = typeof objectiveMeasurements.$inferInsert;
export type ProjectAssignmentRow = typeof projectAssignments.$inferSelect;
export type ProjectAssignmentInsert = typeof projectAssignments.$inferInsert;
export type MilestoneRow = typeof milestones.$inferSelect;
export type MilestoneInsert = typeof milestones.$inferInsert;
export type ProcessBindingRow = typeof processBindings.$inferSelect;
export type ProcessBindingInsert = typeof processBindings.$inferInsert;
export type ThreadRow = typeof threads.$inferSelect;
export type ThreadInsert = typeof threads.$inferInsert;
export type ThreadMessageRow = typeof threadMessages.$inferSelect;
export type ThreadMessageInsert = typeof threadMessages.$inferInsert;
