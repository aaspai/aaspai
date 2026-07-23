import { z } from "zod";
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

export const goalStatusSchema = z.enum(["planned", "active", "blocked", "completed", "archived"]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    status: goalStatusSchema.default("planned"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Goal = z.infer<typeof goalSchema>;

export const projectStatusSchema = z.enum(["active", "paused", "completed", "archived"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
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
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const executionWorkItemSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    projectId: identifierSchema,
    repositoryId: identifierSchema,
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
    idempotencyKey: idempotencyKeySchema,
    metadata: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ExecutionWorkItem = z.infer<typeof executionWorkItemSchema>;

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
    status: workflowRunStatusSchema.default("queued"),
    idempotencyKey: idempotencyKeySchema,
    startedAt: isoTimestampSchema.nullable().default(null),
    finishedAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

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

export const agentAttemptSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    workflowRunId: identifierSchema,
    workItemId: identifierSchema,
    agentId: identifierSchema,
    harness: z.string().trim().min(1).max(128),
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
    resourceType: z.enum(["work_item", "branch", "workspace"]),
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
    prompt: z.string().max(131_072),
    timeoutMs: positiveIntegerSchema.nullable().default(null),
    runtimeConfig: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

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
