import { z } from "zod";
import { gatePolicySchema } from "./phase2";
import { identifierSchema, isoTimestampSchema, nonNegativeIntegerSchema } from "./primitives";

export const governanceRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type GovernanceRisk = z.infer<typeof governanceRiskSchema>;

export const acceptanceCriterionSchema = z
  .object({
    id: identifierSchema,
    description: z.string().trim().min(1).max(4_096),
    required: z.boolean().default(true),
  })
  .strict();
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const verificationPlanSchema = z
  .object({
    required: z.boolean().default(false),
    checkerAgentId: identifierSchema.nullable().default(null),
    checkerHarness: z.string().trim().min(1).max(128).nullable().default(null),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).max(128).default([]),
    minEvidence: nonNegativeIntegerSchema.default(0),
  })
  .strict();
const DEFAULT_VERIFICATION_PLAN = {
  required: false,
  checkerAgentId: null,
  checkerHarness: null,
  acceptanceCriteria: [],
  minEvidence: 0,
};
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;

export const approvalPolicySchema = z
  .object({
    required: z.boolean().default(false),
    actorType: z.enum(["human", "operator", "supervisor"]).default("human"),
    expiresAfterMs: nonNegativeIntegerSchema.nullable().default(null),
  })
  .strict();
const DEFAULT_APPROVAL_POLICY = {
  required: false,
  actorType: "human" as const,
  expiresAfterMs: null,
};
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const budgetScopeSchema = z.enum(["organization", "goal", "project", "agent", "attempt"]);
export type BudgetScope = z.infer<typeof budgetScopeSchema>;

export const budgetLimitSchema = z
  .object({
    scope: budgetScopeSchema,
    tokens: nonNegativeIntegerSchema.default(0),
    costUsd: z.number().nonnegative().default(0),
    runs: nonNegativeIntegerSchema.default(0),
  })
  .strict();
const DEFAULT_GOVERNANCE_BUDGET = { limits: [], soft: 0.8 };
export type BudgetLimit = z.infer<typeof budgetLimitSchema>;

export const governanceBudgetSchema = z
  .object({
    limits: z.array(budgetLimitSchema).max(16).default([]),
    soft: z.number().min(0).max(1).default(0.8),
  })
  .strict();
export type GovernanceBudget = z.infer<typeof governanceBudgetSchema>;

export const DEFAULT_EXECUTION_GOVERNANCE = {
  risk: "low" as const,
  verification: DEFAULT_VERIFICATION_PLAN,
  approval: DEFAULT_APPROVAL_POLICY,
  budget: DEFAULT_GOVERNANCE_BUDGET,
  policy: { denylist: [], allowlist: [], maxFilesChanged: 0, actions: {} },
};

export const executionGovernanceSchema = z
  .object({
    risk: governanceRiskSchema.default("low"),
    verification: verificationPlanSchema.default(DEFAULT_VERIFICATION_PLAN),
    approval: approvalPolicySchema.default(DEFAULT_APPROVAL_POLICY),
    budget: governanceBudgetSchema.default(DEFAULT_GOVERNANCE_BUDGET),
    policy: gatePolicySchema.default({
      denylist: [],
      allowlist: [],
      maxFilesChanged: 0,
      actions: {},
    }),
  })
  .strict()
  .default(DEFAULT_EXECUTION_GOVERNANCE);
export type ExecutionGovernance = z.infer<typeof executionGovernanceSchema>;
export type ExecutionGovernanceInput = {
  risk?: GovernanceRisk;
  verification?: Partial<VerificationPlan>;
  approval?: Partial<ApprovalPolicy>;
  budget?: {
    limits?: Array<Partial<BudgetLimit> & Pick<BudgetLimit, "scope">>;
    soft?: number;
  };
  policy?: {
    denylist?: string[];
    allowlist?: string[];
    maxFilesChanged?: number;
    actions?: Record<
      string,
      { allowed: boolean; requireApproval?: "human" | "operator" | "supervisor" }
    >;
  };
};

export const verificationStatusSchema = z.enum(["pending", "passed", "failed", "concerns"]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const executionVerificationSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    workItemId: identifierSchema,
    makerAttemptId: identifierSchema,
    checkerAttemptId: identifierSchema.nullable().default(null),
    status: verificationStatusSchema.default("pending"),
    summary: z.string().max(16_384).default(""),
    evidenceIds: z.array(identifierSchema).max(256).default([]),
    createdAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type ExecutionVerification = z.infer<typeof executionVerificationSchema>;

export const approvalStatusSchema = z.enum([
  "requested",
  "approved",
  "rejected",
  "changes_requested",
  "expired",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const executionApprovalSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    workItemId: identifierSchema,
    verificationId: identifierSchema.nullable().default(null),
    status: approvalStatusSchema.default("requested"),
    actorType: z.enum(["human", "operator", "supervisor"]),
    actorId: identifierSchema.nullable().default(null),
    reason: z.string().max(16_384).default(""),
    requestedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema.nullable().default(null),
    decidedAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type ExecutionApproval = z.infer<typeof executionApprovalSchema>;

export const governanceDecisionSchema = z.enum(["allowed", "denied", "warning"]);
export const executionGovernanceEventSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    workItemId: identifierSchema.nullable().default(null),
    attemptId: identifierSchema.nullable().default(null),
    action: z.string().trim().min(1).max(256),
    decision: governanceDecisionSchema,
    reason: z.string().max(16_384),
    metadata: z.record(z.string(), z.unknown()).default({}),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type ExecutionGovernanceEvent = z.infer<typeof executionGovernanceEventSchema>;
