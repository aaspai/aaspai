import { z } from "zod";
import {
  idempotencyKeySchema,
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  positiveIntegerSchema,
} from "./primitives";

const boundedString = (max: number) => z.string().trim().max(max);

export const processFailureActionSchema = z.enum(["stop", "continue", "retry", "escalate"]);
export type ProcessFailureAction = z.infer<typeof processFailureActionSchema>;

export const routingRuleSchema = z
  .object({
    organizationId: identifierSchema.nullable().default(null),
    departmentId: identifierSchema.nullable().default(null),
    role: boundedString(64).nullable().default(null),
    capabilities: z.array(boundedString(128).min(1)).max(32).default([]),
    autonomy: boundedString(32).nullable().default(null),
    availableOnly: z.boolean().default(true),
  })
  .strict();
export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const processStepSchema = z
  .object({
    id: identifierSchema,
    agent: identifierSchema.nullable().default(null),
    routingRule: routingRuleSchema.nullable().default(null),
    dependsOn: z.array(identifierSchema).max(64).default([]),
    prompt: boundedString(131_072).default(""),
    skills: z.array(identifierSchema).max(64).default([]),
    tools: z.array(identifierSchema).max(64).default([]),
    timeoutMs: positiveIntegerSchema.max(86_400_000),
    maxAttempts: positiveIntegerSchema.max(100),
    acceptanceCriteria: boundedString(16_384).min(1),
    failureAction: processFailureActionSchema,
    approvalPolicy: jsonObjectSchema.default({}),
  })
  .strict()
  .refine((step) => step.agent !== null || step.routingRule !== null, {
    message: "step requires agent or routingRule",
  });
export type ProcessStep = z.infer<typeof processStepSchema>;

export const DEFAULT_DELEGATION_POLICY = {
  maxDepth: 4,
  maxChildren: 32,
  maxRuns: 100,
  maxCostUsd: 0,
  allowedRoles: [] as string[],
  requireApprovalForRisk: "high" as const,
};

export const delegationPolicySchema = z
  .object({
    maxDepth: positiveIntegerSchema.max(32).default(4),
    maxChildren: positiveIntegerSchema.max(1_000).default(32),
    maxRuns: positiveIntegerSchema.max(10_000).default(100),
    maxCostUsd: z.number().nonnegative().max(1_000_000).default(0),
    allowedRoles: z.array(boundedString(64).min(1)).max(32).default([]),
    requireApprovalForRisk: z.enum(["low", "medium", "high", "critical"]).default("high"),
  })
  .strict();
export type DelegationPolicy = z.infer<typeof delegationPolicySchema>;

export const processDefinitionSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    revision: positiveIntegerSchema.default(1),
    contentHash: boundedString(128).min(1),
    name: boundedString(512).min(1),
    description: boundedString(16_384).default(""),
    steps: z.array(processStepSchema).min(1).max(256),
    maxDurationMs: positiveIntegerSchema.max(86_400_000),
    maxAttempts: positiveIntegerSchema.max(10_000),
    delegation: delegationPolicySchema.default(DEFAULT_DELEGATION_POLICY),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type ProcessDefinition = z.infer<typeof processDefinitionSchema>;

export const operatorRunStatusSchema = z.enum([
  "idle",
  "evaluating",
  "waiting",
  "blocked",
  "completed",
  "failed",
]);
export type OperatorRunStatus = z.infer<typeof operatorRunStatusSchema>;

export const operatorRunSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    operatorAgentId: identifierSchema,
    scopeType: z.enum(["goal", "project", "workflow", "organization"]),
    scopeId: identifierSchema,
    workflowRunId: identifierSchema.nullable().default(null),
    status: operatorRunStatusSchema.default("idle"),
    observedStateVersion: z.number().int().nonnegative().default(0),
    latestDecisionId: identifierSchema.nullable().default(null),
    wakeAt: isoTimestampSchema.nullable().default(null),
    leaseOwner: identifierSchema.nullable().default(null),
    leaseExpiresAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type OperatorRun = z.infer<typeof operatorRunSchema>;

export const controlDecisionActionSchema = z.enum([
  "start_process",
  "dispatch",
  "retry",
  "replan",
  "escalate",
  "answer",
  "cancel",
  "complete",
  "wait",
]);
export const controlDecisionStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "applied",
  "failed",
]);
export const controlDecisionSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    operatorRunId: identifierSchema,
    sequence: positiveIntegerSchema,
    observedStateVersion: z.number().int().nonnegative(),
    idempotencyKey: idempotencyKeySchema,
    action: controlDecisionActionSchema,
    targetType: boundedString(64).min(1),
    targetId: identifierSchema.nullable().default(null),
    parameters: jsonObjectSchema.default({}),
    rationale: boundedString(16_384).min(1),
    status: controlDecisionStatusSchema.default("proposed"),
    createdAt: isoTimestampSchema,
    appliedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type ControlDecision = z.infer<typeof controlDecisionSchema>;

export const operatorEscalationSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    operatorRunId: identifierSchema.nullable().default(null),
    targetType: boundedString(64).min(1),
    targetId: identifierSchema.nullable().default(null),
    reason: boundedString(16_384).min(1),
    evidenceIds: z.array(identifierSchema).max(256).default([]),
    status: z.enum(["open", "resolved", "dismissed"]).default("open"),
    resolution: boundedString(16_384).nullable().default(null),
    createdAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type OperatorEscalation = z.infer<typeof operatorEscalationSchema>;

export const operatorLeaseSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    operatorRunId: identifierSchema,
    owner: identifierSchema,
    acquiredAt: isoTimestampSchema,
    heartbeatAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    releasedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type OperatorLease = z.infer<typeof operatorLeaseSchema>;

export const executionContextSchema = z
  .object({
    organizationId: identifierSchema,
    actorId: identifierSchema,
    correlationId: identifierSchema,
  })
  .strict();
export type ExecutionContext = z.infer<typeof executionContextSchema>;
