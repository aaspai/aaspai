import { z } from "zod";
import { autonomyLevelSchema } from "./phase2";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
} from "./primitives";

export const departmentStatusSchema = z.enum(["active", "paused", "archived"]);
export type DepartmentStatus = z.infer<typeof departmentStatusSchema>;

export const departmentSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().max(4_096).default(""),
    managerAgentId: identifierSchema.nullable().default(null),
    status: departmentStatusSchema.default("active"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Department = z.infer<typeof departmentSchema>;

export const departmentMemberRoleSchema = z.enum(["member", "manager"]);
export type DepartmentMemberRole = z.infer<typeof departmentMemberRoleSchema>;

export const departmentMemberSchema = z
  .object({
    departmentId: identifierSchema,
    organizationId: identifierSchema,
    agentId: identifierSchema,
    role: departmentMemberRoleSchema.default("member"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type DepartmentMember = z.infer<typeof departmentMemberSchema>;

export const serviceAgentStatusSchema = z.enum(["active", "paused", "stale", "retired"]);
export type ServiceAgentStatus = z.infer<typeof serviceAgentStatusSchema>;

export const serviceAgentSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    agentId: identifierSchema,
    departmentId: identifierSchema.nullable().default(null),
    status: serviceAgentStatusSchema.default("active"),
    heartbeatAt: isoTimestampSchema.nullable().default(null),
    lastRunAt: isoTimestampSchema.nullable().default(null),
    failureCount: nonNegativeIntegerSchema.default(0),
    metadata: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ServiceAgent = z.infer<typeof serviceAgentSchema>;

export const autonomyProposalTargetSchema = z.enum(["agent", "loop"]);
export type AutonomyProposalTarget = z.infer<typeof autonomyProposalTargetSchema>;

export const autonomyProposalStatusSchema = z.enum(["proposed", "approved", "rejected"]);
export type AutonomyProposalStatus = z.infer<typeof autonomyProposalStatusSchema>;

export const autonomyProposalSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    targetType: autonomyProposalTargetSchema,
    targetId: identifierSchema,
    fromLevel: autonomyLevelSchema,
    toLevel: autonomyLevelSchema,
    rationale: z.string().trim().min(1).max(8_192),
    evidence: jsonObjectSchema.default({}),
    status: autonomyProposalStatusSchema.default("proposed"),
    proposedBy: identifierSchema,
    reviewedBy: identifierSchema.nullable().default(null),
    reviewReason: z.string().max(4_096).default(""),
    reviewedAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type AutonomyProposal = z.infer<typeof autonomyProposalSchema>;

const portableDepartmentSchema = departmentSchema.omit({ organizationId: true });
const portableMemberSchema = departmentMemberSchema.omit({ organizationId: true });
const portableServiceAgentSchema = serviceAgentSchema.omit({ organizationId: true });
const portableProposalSchema = autonomyProposalSchema.omit({ organizationId: true });

export const companyExportBundleSchema = z
  .object({
    kind: z.literal("aaspai.company"),
    protocolVersion: z.literal(1),
    exportedAt: isoTimestampSchema,
    departments: z.array(portableDepartmentSchema).max(256),
    members: z.array(portableMemberSchema).max(4_096),
    serviceAgents: z.array(portableServiceAgentSchema).max(4_096),
    autonomyProposals: z.array(portableProposalSchema).max(4_096),
  })
  .strict();
export type CompanyExportBundle = z.infer<typeof companyExportBundleSchema>;

export const companyOperationsOverviewSchema = z
  .object({
    organizationId: identifierSchema,
    departments: z.array(departmentSchema),
    members: z.array(departmentMemberSchema),
    serviceAgents: z.array(serviceAgentSchema),
    autonomyProposals: z.array(autonomyProposalSchema),
  })
  .strict();
export type CompanyOperationsOverview = z.infer<typeof companyOperationsOverviewSchema>;
