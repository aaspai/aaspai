import { z } from "zod";
import { DEFAULT_EXECUTION_GOVERNANCE, executionGovernanceSchema } from "./governance";
import {
  idempotencyKeySchema,
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives";
import { type ExecutionTarget, executionTargetSchema } from "./runtime";

export const definitionRevisionSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    repositoryId: identifierSchema,
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    sourcePath: z.string().trim().min(1).max(8_192),
    dirty: z.boolean().default(false),
    contentHash: z.string().trim().min(1).max(256),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type DefinitionRevision = z.infer<typeof definitionRevisionSchema>;

export const goalStatusSchema = z.enum([
  "planned",
  "active",
  "at_risk",
  "blocked",
  "achieved",
  "completed",
  "cancelled",
  "archived",
]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    priority: z.number().int().default(0),
    horizon: z.string().max(128).nullable().default(null),
    successCriteriaJson: z.string().default("[]"),
    targetAt: isoTimestampSchema.nullable().default(null),
    reviewCadence: z.string().max(128).nullable().default(null),
    ownerAgentId: identifierSchema.nullable().default(null),
    status: goalStatusSchema.default("planned"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Goal = z.infer<typeof goalSchema>;

export const projectStatusSchema = z.enum([
  "proposed",
  "approved",
  "staffed",
  "active",
  "reviewing",
  "paused",
  "blocked",
  "completed",
  "cancelled",
  "archived",
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    managerAgentId: identifierSchema.nullable().default(null),
    budgetJson: z.string().default("{}"),
    riskLevel: z.string().max(64).default("medium"),
    reviewCadence: z.string().max(128).nullable().default(null),
    healthStatus: z.string().max(64).default("healthy"),
    successCriteriaJson: z.string().default("[]"),
    status: projectStatusSchema.default("active"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;

export const repositoryPurposeSchema = z.enum(["blueprint", "project"]);
export type RepositoryPurpose = z.infer<typeof repositoryPurposeSchema>;

export const repositoryProviderSchema = z.enum(["local", "github"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

export const repositorySchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema.nullable().default(null),
    purpose: repositoryPurposeSchema,
    provider: repositoryProviderSchema,
    localPath: z.string().trim().min(1).max(8_192),
    remoteUrl: z.string().trim().max(2_048).nullable().default(null),
    defaultBranch: z.string().trim().min(1).max(256).default("main"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Repository = z.infer<typeof repositorySchema>;

export const workItemStatusSchema = z.enum([
  "proposed",
  "ready",
  "claimed",
  "in_progress",
  "awaiting_verification",
  "awaiting_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const workKindSchema = z.enum(["repository", "general", "external_action"]);
export type WorkKind = z.infer<typeof workKindSchema>;
export const deliveryModeSchema = z.enum(["none", "artifact", "commit", "pull_request"]);
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;
export const deliveryStatusSchema = z.enum([
  "pending",
  "ready",
  "delivering",
  "delivered",
  "failed",
]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const executionWorkItemSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    projectId: identifierSchema,
    repositoryId: identifierSchema,
    /** All repositories touched by this work item. repositoryId is the primary repository. */
    repositoryIds: z.array(identifierSchema).min(1).max(32).optional(),
    workKind: workKindSchema.default("repository"),
    deliveryMode: deliveryModeSchema.default("commit"),
    deliveryStatus: deliveryStatusSchema.default("pending"),
    deliveryRef: z.string().trim().max(2_048).nullable().default(null),
    deliveryCommitSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
      .nullable()
      .default(null),
    deliveryClaimOwner: identifierSchema.nullable().default(null),
    deliveryLeaseExpiresAt: isoTimestampSchema.nullable().default(null),
    workflowRunId: identifierSchema.nullable().default(null),
    milestoneId: identifierSchema.nullable().default(null),
    processBindingId: identifierSchema.nullable().default(null),
    parentWorkItemId: identifierSchema.nullable().default(null),
    assignedAgentId: identifierSchema.nullable().default(null),
    alignmentRationale: z.string().trim().max(4_096).default(""),
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    status: workItemStatusSchema.default("proposed"),
    definitionRevisionId: identifierSchema.nullable().default(null),
    sourceCommitSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .nullable()
      .default(null),
    branchName: z.string().trim().max(256).nullable().default(null),
    priority: z.number().int().min(-100_000).max(100_000).default(0),
    deadlineAt: isoTimestampSchema.nullable().default(null),
    maxAttempts: positiveIntegerSchema.default(1),
    retryAfter: isoTimestampSchema.nullable().default(null),
    blockedReason: z.string().max(4_096).nullable().default(null),
    governance: executionGovernanceSchema.default(DEFAULT_EXECUTION_GOVERNANCE),
    idempotencyKey: idempotencyKeySchema,
    metadata: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ExecutionWorkItem = z.infer<typeof executionWorkItemSchema>;

export const executionWorkItemDependencySchema = z
  .object({
    organizationId: identifierSchema,
    workItemId: identifierSchema,
    dependsOnWorkItemId: identifierSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();
export type ExecutionWorkItemDependency = z.infer<typeof executionWorkItemDependencySchema>;

export const workflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowRunSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    definitionRevisionId: identifierSchema,
    processDefinitionHash: z.string().trim().max(128).nullable().default(null),
    stateVersion: nonNegativeIntegerSchema.default(0),
    sourceType: z.string().trim().min(1).max(64).nullable().default(null),
    sourceId: identifierSchema.nullable().default(null),
    status: workflowRunStatusSchema.default("queued"),
    idempotencyKey: idempotencyKeySchema,
    startedAt: isoTimestampSchema.nullable().default(null),
    finishedAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const loopOutputKindSchema = z.enum(["report", "escalation", "noop"]);
export type LoopOutputKind = z.infer<typeof loopOutputKindSchema>;

export const loopOutputSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    loopId: identifierSchema,
    workflowRunId: identifierSchema,
    kind: loopOutputKindSchema,
    sourceRef: z.string().trim().min(1).max(512),
    title: z.string().trim().min(1).max(512),
    body: z.string().trim().min(1).max(65_536),
    severity: z.enum(["info", "warn", "critical"]).nullable().default(null),
    workItemId: identifierSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type LoopOutput = z.infer<typeof loopOutputSchema>;

export const attemptStatusSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "lost",
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const attemptRoleSchema = z.enum(["maker", "checker"]);
export type AttemptRole = z.infer<typeof attemptRoleSchema>;

export const agentAttemptSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    workflowRunId: identifierSchema,
    workItemId: identifierSchema,
    agentId: identifierSchema,
    harness: z.string().trim().min(1).max(128),
    role: attemptRoleSchema.default("maker"),
    parentAttemptId: identifierSchema.nullable().default(null),
    verificationId: identifierSchema.nullable().default(null),
    harnessSessionId: identifierSchema.nullable().default(null),
    status: attemptStatusSchema.default("queued"),
    attemptNumber: positiveIntegerSchema.default(1),
    timeoutMs: positiveIntegerSchema.nullable().default(null),
    cancelRequestedAt: isoTimestampSchema.nullable().default(null),
    startedAt: isoTimestampSchema.nullable().default(null),
    finishedAt: isoTimestampSchema.nullable().default(null),
    error: z.string().max(16_384).nullable().default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AgentAttempt = z.infer<typeof agentAttemptSchema>;

export const sourceSnapshotSchema = z
  .object({
    repositoryId: identifierSchema,
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    branchName: z.string().trim().min(1).max(256),
    capturedAt: isoTimestampSchema,
  })
  .strict();
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export const workspaceStatusSchema = z.enum([
  "pending",
  "creating",
  "ready",
  "releasing",
  "released",
  "failed",
]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const executionWorkspaceSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    attemptId: identifierSchema,
    repositoryId: identifierSchema,
    path: z.string().trim().min(1).max(8_192),
    branchName: z.string().trim().min(1).max(256),
    baseCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    status: workspaceStatusSchema.default("pending"),
    createdAt: isoTimestampSchema,
    releasedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type ExecutionWorkspace = z.infer<typeof executionWorkspaceSchema>;

export const resourceLockSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    resourceType: z.enum([
      "work_item",
      "branch",
      "workspace",
      "organization_slot",
      "project_slot",
      "repository_slot",
      "agent_slot",
    ]),
    resourceId: identifierSchema,
    ownerAttemptId: identifierSchema,
    acquiredAt: isoTimestampSchema,
    leaseExpiresAt: isoTimestampSchema,
    releasedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type ResourceLock = z.infer<typeof resourceLockSchema>;

export const artifactSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    attemptId: identifierSchema,
    kind: z.enum(["diff", "patch", "log", "transcript", "test_result", "result", "other"]),
    path: z.string().trim().min(1).max(8_192),
    mediaType: z.string().trim().min(1).max(256),
    sizeBytes: nonNegativeIntegerSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

export const executionPlanSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    definitionRevisionId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    sourceSnapshot: sourceSnapshotSchema,
    target: executionTargetSchema,
    harness: z.string().trim().min(1).max(128),
    agentId: identifierSchema.default("unknown"),
    idempotencyKey: idempotencyKeySchema.default("plan-unknown"),
    prompt: z.string().max(131_072),
    timeoutMs: positiveIntegerSchema.nullable().default(null),
    harnessConfig: jsonObjectSchema.default({}),
    workspacePolicy: z
      .object({
        restore: z.enum(["none", "changes", "all"]).default("changes"),
        cleanup: z.enum(["always", "retain_on_failure"]).default("always"),
      })
      .strict()
      .default({ restore: "changes", cleanup: "always" }),
    runtimeConfig: jsonObjectSchema.default({}),
    profileHash: z.string().trim().min(1).max(128).default("profile-unknown"),
    profileSnapshot: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
  })
  .strict();
type ParsedExecutionPlan = z.infer<typeof executionPlanSchema>;
/** Optional in source literals for compatibility; persistence fills every pin. */
export type ExecutionPlan = Omit<
  ParsedExecutionPlan,
  | "agentId"
  | "idempotencyKey"
  | "harnessConfig"
  | "workspacePolicy"
  | "profileHash"
  | "profileSnapshot"
> &
  Partial<
    Pick<
      ParsedExecutionPlan,
      | "agentId"
      | "idempotencyKey"
      | "harnessConfig"
      | "workspacePolicy"
      | "profileHash"
      | "profileSnapshot"
    >
  >;

export const executionRawOutputSchema = z
  .object({
    id: positiveIntegerSchema,
    organizationId: identifierSchema,
    attemptId: identifierSchema,
    ts: isoTimestampSchema,
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string().max(16 * 1024 * 1024),
    seq: positiveIntegerSchema,
  })
  .strict();
export type ExecutionRawOutput = z.infer<typeof executionRawOutputSchema>;

export const executionEventSchema = z
  .object({
    id: positiveIntegerSchema,
    organizationId: identifierSchema,
    attemptId: identifierSchema,
    ts: isoTimestampSchema,
    type: identifierSchema,
    payload: jsonObjectSchema,
    seq: positiveIntegerSchema,
  })
  .strict();
export type ExecutionEvent = z.infer<typeof executionEventSchema>;

export type ExecutionTransition = {
  from: AttemptStatus;
  to: AttemptStatus;
};

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  queued: ["preparing", "cancelled"],
  preparing: ["running", "failed", "cancelled", "lost"],
  running: ["cancelling", "succeeded", "failed", "timed_out", "lost"],
  cancelling: ["cancelled", "failed", "timed_out", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  lost: [],
};

export function isValidAttemptTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function assertValidAttemptTransition(
  from: AttemptStatus,
  to: AttemptStatus,
): ExecutionTransition {
  if (!isValidAttemptTransition(from, to)) {
    throw new Error(`Invalid agent attempt transition: ${from} -> ${to}`);
  }
  return { from, to };
}

export type { ExecutionTarget };
