import { z } from "zod";
import { processDefinitionSchema } from "./operator";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nonNegativeIntegerSchema,
} from "./primitives";

/** Product vocabulary for the strategic control plane (the DB keeps `goals`). */
export const companyLifecycleSchema = z.enum([
  "draft",
  "validated",
  "discovery",
  "review",
  "active",
  "paused",
  "archived",
]);
export type CompanyLifecycle = z.infer<typeof companyLifecycleSchema>;

export const objectiveStatusSchema = z.enum([
  "planned",
  "active",
  "at_risk",
  "achieved",
  "cancelled",
]);
export type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;

export const portfolioProjectStatusSchema = z.enum([
  "proposed",
  "approved",
  "staffed",
  "active",
  "reviewing",
  "completed",
  "cancelled",
  "blocked",
]);
export type PortfolioProjectStatus = z.infer<typeof portfolioProjectStatusSchema>;

export const milestoneStatusSchema = z.enum([
  "proposed",
  "active",
  "blocked",
  "review",
  "accepted",
  "completed",
  "failed",
  "cancelled",
]);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

export const processBindingStatusSchema = z.enum(["draft", "active", "paused", "retired"]);
export type ProcessBindingStatus = z.infer<typeof processBindingStatusSchema>;

export const projectAssignmentRoleSchema = z.enum(["manager", "member", "reviewer", "advisor"]);
export type ProjectAssignmentRole = z.infer<typeof projectAssignmentRoleSchema>;

export const projectAssignmentStatusSchema = z.enum(["proposed", "active", "released"]);
export type ProjectAssignmentStatus = z.infer<typeof projectAssignmentStatusSchema>;

export const companyProfileSchema = z
  .object({
    organizationId: identifierSchema,
    description: z.string().max(16_384),
    lifecycleStatus: companyLifecycleSchema,
    activeDefinitionRevisionId: identifierSchema.nullable(),
    ceoAgentId: identifierSchema.nullable(),
    operatorAgentId: identifierSchema.nullable(),
    timezone: z.string().trim().min(1).max(128),
    policy: jsonObjectSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

export const projectObjectiveSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    goalId: identifierSchema,
    isPrimary: z.boolean(),
    contribution: jsonObjectSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ProjectObjective = z.infer<typeof projectObjectiveSchema>;

export const objectiveMeasurementSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    metricKey: z.string().trim().min(1).max(256),
    value: jsonValueSchema,
    unit: z.string().trim().max(64).nullable(),
    observedAt: isoTimestampSchema,
    sourceType: z.enum(["work", "artifact", "external", "human"]),
    sourceId: identifierSchema.nullable(),
    evidence: z.array(identifierSchema).max(256),
    recordedBy: identifierSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();
export type ObjectiveMeasurement = z.infer<typeof objectiveMeasurementSchema>;

export const projectAssignmentSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    agentId: identifierSchema,
    role: projectAssignmentRoleSchema,
    allocationPercent: z.number().min(0).max(100),
    status: projectAssignmentStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ProjectAssignment = z.infer<typeof projectAssignmentSchema>;

export const milestoneSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    outcome: z.string().max(16_384),
    ownerAgentId: identifierSchema.nullable(),
    sequence: nonNegativeIntegerSchema,
    status: milestoneStatusSchema,
    acceptance: jsonObjectSchema,
    targetAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Milestone = z.infer<typeof milestoneSchema>;

export const processBindingSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    processDefinitionId: identifierSchema,
    processRevision: z.number().int().positive(),
    ownerAgentId: identifierSchema,
    loopId: identifierSchema.nullable(),
    status: processBindingStatusSchema,
    performance: jsonObjectSchema,
    policy: jsonObjectSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ProcessBinding = z.infer<typeof processBindingSchema>;

export const companyObjectiveSummarySchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    title: z.string().max(512),
    description: z.string(),
    status: z.string().min(1),
    priority: z.number().int(),
    horizon: z.string().nullable(),
    successCriteria: jsonValueSchema,
    targetAt: isoTimestampSchema.nullable(),
    reviewCadence: z.string().nullable(),
    ownerAgentId: identifierSchema.nullable(),
    projectCount: nonNegativeIntegerSchema,
    measurementCount: nonNegativeIntegerSchema,
  })
  .strict();
export type CompanyObjectiveSummary = z.infer<typeof companyObjectiveSummarySchema>;

export const companyProjectSummarySchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    goalId: identifierSchema,
    title: z.string().max(512),
    description: z.string(),
    status: z.string().min(1),
    managerAgentId: identifierSchema.nullable(),
    budget: jsonObjectSchema,
    riskLevel: z.string().min(1),
    reviewCadence: z.string().nullable(),
    healthStatus: z.string().min(1),
    successCriteria: jsonValueSchema,
    objectiveIds: z.array(identifierSchema).max(1_000),
    assignments: z.array(projectAssignmentSchema).max(1_000),
    milestones: z.array(milestoneSchema).max(1_000),
    processBindingCount: nonNegativeIntegerSchema,
  })
  .strict();
export type CompanyProjectSummary = z.infer<typeof companyProjectSummarySchema>;

export const companyStrategicSummarySchema = z
  .object({
    organizationId: identifierSchema,
    generatedAt: isoTimestampSchema,
    profile: companyProfileSchema.nullable(),
    objectives: z.array(companyObjectiveSummarySchema).max(1_000),
    projects: z.array(companyProjectSummarySchema).max(1_000),
  })
  .strict();
export type CompanyStrategicSummary = z.infer<typeof companyStrategicSummarySchema>;

const commandBase = z.object({
  organizationId: identifierSchema,
  actorId: identifierSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
});

export const companyCommandSchema = z.discriminatedUnion("type", [
  commandBase.extend({
    type: z.literal("setup_company"),
    description: z.string().max(16_384).default(""),
    timezone: z.string().trim().min(1).max(128).default("UTC"),
    policy: jsonObjectSchema.default({}),
    ceoAgentId: identifierSchema.nullable().default(null),
    operatorAgentId: identifierSchema.nullable().default(null),
    objectives: z
      .array(
        z
          .object({
            id: identifierSchema.optional(),
            title: z.string().trim().min(1).max(512),
            description: z.string().max(16_384).default(""),
            priority: z.number().int().min(0).max(100).default(0),
            successCriteria: jsonValueSchema.default([]),
            horizon: z.string().max(128).nullable().default(null),
            targetAt: isoTimestampSchema.nullable().default(null),
            reviewCadence: z.string().max(128).nullable().default(null),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  }),
  commandBase.extend({ type: z.literal("validate_company") }),
  commandBase.extend({ type: z.literal("start_discovery") }),
  commandBase.extend({
    type: z.literal("submit_portfolio_proposal"),
    summary: z.string().trim().min(1).max(16_384),
    evidence: z.array(identifierSchema).min(1).max(256),
    projects: z
      .array(
        z
          .object({
            goalId: identifierSchema,
            title: z.string().trim().min(1).max(512),
            description: z.string().max(16_384).default(""),
            managerAgentId: identifierSchema.nullable().default(null),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  }),
  commandBase.extend({ type: z.literal("activate_company"), approved: z.boolean().default(false) }),
  commandBase.extend({
    type: z.literal("create_objective"),
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    priority: z.number().int().min(0).max(100).default(0),
    successCriteria: jsonValueSchema.default([]),
    horizon: z.string().max(128).nullable().default(null),
    targetAt: isoTimestampSchema.nullable().default(null),
    reviewCadence: z.string().max(128).nullable().default(null),
  }),
  commandBase.extend({
    type: z.literal("create_project"),
    goalId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(16_384).default(""),
    managerAgentId: identifierSchema.nullable().default(null),
    status: z.string().default("proposed"),
  }),
  commandBase.extend({
    type: z.literal("link_project_objective"),
    projectId: identifierSchema,
    goalId: identifierSchema,
    isPrimary: z.boolean().default(false),
    contribution: jsonObjectSchema.default({}),
  }),
  commandBase.extend({
    type: z.literal("appoint_project_manager"),
    projectId: identifierSchema,
    agentId: identifierSchema,
  }),
  commandBase.extend({
    type: z.literal("assign_agent_to_project"),
    projectId: identifierSchema,
    agentId: identifierSchema,
    role: projectAssignmentRoleSchema.default("member"),
    allocationPercent: z.number().min(0).max(100).default(100),
  }),
  commandBase.extend({
    type: z.literal("create_milestone"),
    projectId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    outcome: z.string().max(16_384).default(""),
    ownerAgentId: identifierSchema.nullable().default(null),
    sequence: nonNegativeIntegerSchema,
    acceptance: jsonObjectSchema.default({}),
    targetAt: isoTimestampSchema.nullable().default(null),
  }),
  commandBase.extend({
    type: z.literal("bind_process"),
    projectId: identifierSchema,
    processDefinitionId: identifierSchema,
    processRevision: z.number().int().positive().default(1),
    definition: processDefinitionSchema.optional(),
    ownerAgentId: identifierSchema,
    loopId: identifierSchema.nullable().default(null),
    policy: jsonObjectSchema.default({}),
  }),
  commandBase.extend({
    type: z.literal("start_process_run"),
    projectId: identifierSchema,
    goalId: identifierSchema,
    milestoneId: identifierSchema.nullable().default(null),
    repositoryId: identifierSchema,
    definitionRevisionId: identifierSchema,
    operatorAgentId: identifierSchema,
    sourceCommitSha: z.string().nullable().default(null),
    definition: processDefinitionSchema,
    parentWorkItemId: identifierSchema.nullable().default(null),
    parentAttemptId: identifierSchema.nullable().default(null),
    parentSessionId: identifierSchema.nullable().default(null),
  }),
  commandBase.extend({
    type: z.literal("record_measurement"),
    goalId: identifierSchema,
    metricKey: z.string().trim().min(1).max(256),
    value: jsonValueSchema,
    unit: z.string().max(64).nullable().default(null),
    observedAt: isoTimestampSchema,
    sourceType: z.enum(["work", "artifact", "external", "human"]),
    sourceId: identifierSchema.nullable().default(null),
    evidence: z.array(identifierSchema).max(256).default([]),
  }),
  commandBase.extend({
    type: z.literal("record_milestone_evaluation"),
    projectId: identifierSchema,
    milestoneId: identifierSchema,
    status: z.enum(["accepted", "blocked", "failed"]),
    evidence: z.array(identifierSchema).min(1).max(256),
    rationale: z.string().trim().min(1).max(4_096),
  }),
  commandBase.extend({
    type: z.literal("evaluate_project"),
    projectId: identifierSchema,
    evidence: z.array(identifierSchema).min(1).max(256),
  }),
  commandBase.extend({
    type: z.literal("evaluate_objective"),
    goalId: identifierSchema,
    evidence: z.array(identifierSchema).min(1).max(256),
  }),
  commandBase.extend({
    type: z.literal("create_thread"),
    entityType: z.enum(["company", "objective", "project", "milestone", "process", "work"]),
    entityId: identifierSchema,
    title: z.string().max(512).default(""),
  }),
  commandBase.extend({
    type: z.literal("add_thread_message"),
    threadId: identifierSchema,
    body: z.string().trim().min(1).max(32_768),
    metadata: jsonObjectSchema.default({}),
  }),
  commandBase.extend({
    type: z.enum(["pause_scope", "resume_scope"]),
    scopeType: z.enum(["company", "project"]),
    scopeId: identifierSchema,
    reason: z.string().max(4_096).default(""),
  }),
]);
export type CompanyCommand = z.infer<typeof companyCommandSchema>;
