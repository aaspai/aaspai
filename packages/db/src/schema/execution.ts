import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("planned"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ orgIdx: index("goals_org_idx").on(t.organizationId) }),
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({ goalIdx: index("projects_goal_idx").on(t.goalId) }),
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").references(() => projects.id),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    localPath: text("local_path").notNull(),
    remoteUrl: text("remote_url"),
    defaultBranch: text("default_branch").notNull().default("main"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgPurposeIdx: index("repositories_org_purpose_idx").on(t.organizationId, t.purpose),
  }),
);

export const definitionRevisions = sqliteTable(
  "definition_revisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id),
    commitSha: text("commit_sha").notNull(),
    sourcePath: text("source_path").notNull(),
    dirty: integer("dirty", { mode: "boolean" }).notNull().default(false),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    revisionIdx: index("definition_revisions_repo_idx").on(t.repositoryId, t.commitSha),
  }),
);

export const executionWorkItems = sqliteTable(
  "execution_work_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("proposed"),
    definitionRevisionId: text("definition_revision_id").references(() => definitionRevisions.id),
    sourceCommitSha: text("source_commit_sha"),
    branchName: text("branch_name"),
    claimedByAttemptId: text("claimed_by_attempt_id"),
    claimedAt: text("claimed_at"),
    priority: integer("priority").notNull().default(0),
    deadlineAt: text("deadline_at"),
    maxAttempts: integer("max_attempts").notNull().default(1),
    retryAfter: text("retry_after"),
    blockedReason: text("blocked_reason"),
    governanceJson: text("governance_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgIdemUniq: uniqueIndex("execution_work_items_org_idem_uniq").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    projectStatusIdx: index("execution_work_items_project_status_idx").on(t.projectId, t.status),
  }),
);

export const executionWorkItemDependencies = sqliteTable(
  "execution_work_item_dependencies",
  {
    organizationId: text("organization_id").notNull(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id, { onDelete: "cascade" }),
    dependsOnWorkItemId: text("depends_on_work_item_id")
      .notNull()
      .references(() => executionWorkItems.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    edgeUniq: uniqueIndex("execution_work_item_dependencies_uniq").on(
      t.workItemId,
      t.dependsOnWorkItemId,
    ),
    workItemIdx: index("execution_work_item_dependencies_work_idx").on(t.workItemId),
    dependencyIdx: index("execution_work_item_dependencies_dependency_idx").on(
      t.dependsOnWorkItemId,
    ),
  }),
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id),
    definitionRevisionId: text("definition_revision_id")
      .notNull()
      .references(() => definitionRevisions.id),
    status: text("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgIdemUniq: uniqueIndex("workflow_runs_org_idem_uniq").on(t.organizationId, t.idempotencyKey),
  }),
);

export const agentAttempts = sqliteTable(
  "agent_attempts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id),
    agentId: text("agent_id").notNull(),
    harness: text("harness").notNull(),
    role: text("role").notNull().default("maker"),
    parentAttemptId: text("parent_attempt_id"),
    verificationId: text("verification_id"),
    harnessSessionId: text("harness_session_id"),
    status: text("status").notNull().default("queued"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    timeoutMs: integer("timeout_ms"),
    cancelRequestedAt: text("cancel_requested_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    workAttemptUniq: uniqueIndex("agent_attempts_work_number_uniq").on(
      t.workItemId,
      t.attemptNumber,
    ),
    runStatusIdx: index("agent_attempts_run_status_idx").on(t.workflowRunId, t.status),
  }),
);

export const executionWorkspaces = sqliteTable(
  "execution_workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => agentAttempts.id),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id),
    path: text("path").notNull(),
    branchName: text("branch_name").notNull(),
    baseCommitSha: text("base_commit_sha").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at"),
  },
  (t) => ({ attemptIdx: index("execution_workspaces_attempt_idx").on(t.attemptId) }),
);

export const resourceLocks = sqliteTable(
  "resource_locks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    ownerAttemptId: text("owner_attempt_id")
      .notNull()
      .references(() => agentAttempts.id),
    acquiredAt: text("acquired_at").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    releasedAt: text("released_at"),
  },
  (t) => ({
    resourceIdx: index("resource_locks_resource_idx").on(t.resourceType, t.resourceId),
    activeResourceUniq: uniqueIndex("resource_locks_active_uniq")
      .on(t.organizationId, t.resourceType, t.resourceId)
      .where(sql`${t.releasedAt} IS NULL`),
  }),
);

export const executionPlans = sqliteTable(
  "execution_plans",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    definitionRevisionId: text("definition_revision_id")
      .notNull()
      .references(() => definitionRevisions.id),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => agentAttempts.id),
    sourceSnapshotJson: text("source_snapshot_json").notNull(),
    targetJson: text("target_json").notNull(),
    harness: text("harness").notNull(),
    prompt: text("prompt").notNull(),
    timeoutMs: integer("timeout_ms"),
    runtimeConfigJson: text("runtime_config_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ attemptUniq: uniqueIndex("execution_plans_attempt_uniq").on(t.attemptId) }),
);

export const artifacts = sqliteTable(
  "execution_artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => agentAttempts.id),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ attemptIdx: index("execution_artifacts_attempt_idx").on(t.attemptId) }),
);

export const executionEvents = sqliteTable(
  "execution_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: text("organization_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => agentAttempts.id, { onDelete: "cascade" }),
    ts: text("ts").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    seq: integer("seq").notNull(),
  },
  (t) => ({
    attemptSeqUniq: uniqueIndex("execution_events_attempt_seq_uniq").on(t.attemptId, t.seq),
    attemptIdx: index("execution_events_attempt_idx").on(t.attemptId, t.seq),
  }),
);

export const executionVerifications = sqliteTable(
  "execution_verifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id, { onDelete: "cascade" }),
    makerAttemptId: text("maker_attempt_id")
      .notNull()
      .references(() => agentAttempts.id),
    checkerAttemptId: text("checker_attempt_id").references(() => agentAttempts.id),
    status: text("status").notNull().default("pending"),
    summary: text("summary").notNull().default(""),
    evidenceIdsJson: text("evidence_ids_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({ workItemIdx: index("execution_verifications_work_item_idx").on(t.workItemId) }),
);

export const executionApprovals = sqliteTable(
  "execution_approvals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id, { onDelete: "cascade" }),
    verificationId: text("verification_id").references(() => executionVerifications.id),
    status: text("status").notNull().default("requested"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason").notNull().default(""),
    requestedAt: text("requested_at").notNull(),
    expiresAt: text("expires_at"),
    decidedAt: text("decided_at"),
  },
  (t) => ({ workItemIdx: index("execution_approvals_work_item_idx").on(t.workItemId, t.status) }),
);

export const executionBudgetReservations = sqliteTable(
  "execution_budget_reservations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => executionWorkItems.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => agentAttempts.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    reservedTokens: integer("reserved_tokens").notNull().default(0),
    reservedCostUsd: real("reserved_cost_usd").notNull().default(0),
    reservedRuns: integer("reserved_runs").notNull().default(1),
    actualTokens: integer("actual_tokens").notNull().default(0),
    actualCostUsd: real("actual_cost_usd").notNull().default(0),
    status: text("status").notNull().default("reserved"),
    createdAt: text("created_at").notNull(),
    settledAt: text("settled_at"),
  },
  (t) => ({
    attemptIdx: index("execution_budget_reservations_attempt_idx").on(t.attemptId),
    scopeIdx: index("execution_budget_reservations_scope_idx").on(
      t.organizationId,
      t.scope,
      t.scopeId,
    ),
  }),
);

export const executionGovernanceEvents = sqliteTable(
  "execution_governance_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    workItemId: text("work_item_id").references(() => executionWorkItems.id, {
      onDelete: "set null",
    }),
    attemptId: text("attempt_id").references(() => agentAttempts.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => ({
    orgTimeIdx: index("execution_governance_events_org_time_idx").on(
      t.organizationId,
      t.occurredAt,
    ),
    workItemIdx: index("execution_governance_events_work_item_idx").on(t.workItemId),
  }),
);

export type GoalRow = typeof goals.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;
export type DefinitionRevisionRow = typeof definitionRevisions.$inferSelect;
export type ExecutionWorkItemRow = typeof executionWorkItems.$inferSelect;
export type ExecutionWorkItemDependencyRow = typeof executionWorkItemDependencies.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type AgentAttemptRow = typeof agentAttempts.$inferSelect;
export type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
export type ResourceLockRow = typeof resourceLocks.$inferSelect;
export type ExecutionPlanRow = typeof executionPlans.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ExecutionEventRow = typeof executionEvents.$inferSelect;
export type ExecutionVerificationRow = typeof executionVerifications.$inferSelect;
export type ExecutionApprovalRow = typeof executionApprovals.$inferSelect;
export type ExecutionBudgetReservationRow = typeof executionBudgetReservations.$inferSelect;
export type ExecutionGovernanceEventRow = typeof executionGovernanceEvents.$inferSelect;
