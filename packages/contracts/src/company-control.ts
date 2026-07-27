import { z } from "zod";
import {
  idempotencyKeySchema,
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
} from "./primitives";

export const authorityRelationSchema = z.enum([
  "reports_to",
  "manages",
  "may_delegate_to",
  "may_approve",
  "must_escalate_to",
]);
export type AuthorityRelation = z.infer<typeof authorityRelationSchema>;

export const authorityEdgeSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    fromAgentId: identifierSchema,
    toAgentId: identifierSchema,
    relation: authorityRelationSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type AuthorityEdge = z.infer<typeof authorityEdgeSchema>;

export const controlRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type ControlRisk = z.infer<typeof controlRiskSchema>;

export const routingStatusSchema = z.enum(["routed", "escalated", "rejected"]);
export type RoutingStatus = z.infer<typeof routingStatusSchema>;

export const routingRequestSchema = z
  .object({
    organizationId: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    requestedByAgentId: identifierSchema.nullable().default(null),
    targetAgentId: identifierSchema.nullable().default(null),
    departmentId: identifierSchema.nullable().default(null),
    requiredRole: z.string().trim().min(1).max(64).nullable().default(null),
    capability: z.string().trim().min(1).max(128).nullable().default(null),
    risk: controlRiskSchema.default("medium"),
    priority: nonNegativeIntegerSchema.max(100).default(50),
    title: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(16_384),
  })
  .strict();
export type RoutingRequest = z.infer<typeof routingRequestSchema>;

export const routingDecisionSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    status: routingStatusSchema,
    selectedAgentId: identifierSchema.nullable().default(null),
    departmentId: identifierSchema.nullable().default(null),
    authorityPath: z.array(identifierSchema).max(128).default([]),
    escalationId: identifierSchema.nullable().default(null),
    reason: z.string().trim().min(1).max(4_096),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

export const delegationStatusSchema = z.enum(["created", "rejected", "failed"]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const delegationSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    requestedByAgentId: identifierSchema.nullable().default(null),
    targetAgentId: identifierSchema,
    workItemId: identifierSchema.nullable().default(null),
    authorityPath: z.array(identifierSchema).max(128).default([]),
    status: delegationStatusSchema,
    reason: z.string().trim().min(1).max(4_096),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Delegation = z.infer<typeof delegationSchema>;

export const escalationStatusSchema = z.enum(["open", "acknowledged", "resolved", "dismissed"]);
export type EscalationStatus = z.infer<typeof escalationStatusSchema>;

export const escalationSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    subjectType: z.enum(["routing", "delegation", "work_item", "attempt", "objective"]),
    subjectId: identifierSchema,
    requestedByAgentId: identifierSchema.nullable().default(null),
    targetAgentId: identifierSchema.nullable().default(null),
    risk: controlRiskSchema,
    reason: z.string().trim().min(1).max(8_192),
    context: jsonObjectSchema.default({}),
    authorityPath: z.array(identifierSchema).max(128).default([]),
    status: escalationStatusSchema,
    resolvedBy: identifierSchema.nullable().default(null),
    resolution: z.string().max(8_192).nullable().default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Escalation = z.infer<typeof escalationSchema>;
