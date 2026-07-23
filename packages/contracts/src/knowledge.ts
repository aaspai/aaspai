import { z } from "zod";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  jsonValueSchema,
} from "./primitives";

export const temporalFactStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "invalidated",
  "superseded",
  "archived",
]);
export type TemporalFactStatus = z.infer<typeof temporalFactStatusSchema>;

export const knowledgeProposalStatusSchema = z.enum([
  "proposed",
  "under_review",
  "accepted",
  "rejected",
  "withdrawn",
]);
export type KnowledgeProposalStatus = z.infer<typeof knowledgeProposalStatusSchema>;

export const knowledgeChangeRequestStatusSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "merged",
]);
export type KnowledgeChangeRequestStatus = z.infer<typeof knowledgeChangeRequestStatusSchema>;

export const knowledgeProvenanceSchema = z
  .object({
    sourceType: z.enum(["memory", "fact", "session", "attempt", "workflow", "manual"]),
    sourceId: identifierSchema,
    capturedAt: isoTimestampSchema,
    actorId: identifierSchema.nullable().default(null),
    extractor: z.string().trim().max(128).nullable().default(null),
  })
  .strict();
export type KnowledgeProvenance = z.infer<typeof knowledgeProvenanceSchema>;

const temporalFactFieldsSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    subject: z.string().trim().min(1).max(512),
    predicate: z.string().trim().min(1).max(256),
    value: jsonValueSchema,
    valueType: z.enum(["string", "number", "boolean", "json"]),
    validFrom: isoTimestampSchema.nullable().default(null),
    validTo: isoTimestampSchema.nullable().default(null),
    confidence: z.number().min(0).max(1).default(0.5),
    status: temporalFactStatusSchema.default("proposed"),
    sourceMemoryIds: z.array(identifierSchema).min(1).max(64),
    provenance: knowledgeProvenanceSchema,
    supersedesId: identifierSchema.nullable().default(null),
    invalidatedAt: isoTimestampSchema.nullable().default(null),
    lastVerifiedAt: isoTimestampSchema.nullable().default(null),
    metadata: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const temporalFactSchema = temporalFactFieldsSchema.refine(
  (fact) =>
    fact.validFrom === null ||
    fact.validTo === null ||
    Date.parse(fact.validFrom) < Date.parse(fact.validTo),
  { message: "validFrom must be before validTo", path: ["validTo"] },
);
export type TemporalFact = z.infer<typeof temporalFactSchema>;

export const temporalFactInputSchema = temporalFactFieldsSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    id: identifierSchema.optional(),
    createdAt: isoTimestampSchema.optional(),
    updatedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type TemporalFactInput = z.input<typeof temporalFactInputSchema>;

export const knowledgeProposalSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(4_096),
    content: z.string().max(1_048_576),
    targetPath: z.string().trim().min(1).max(1_024),
    knowledgeType: z.string().trim().min(1).max(128),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    sourceMemoryIds: z.array(identifierSchema).min(1).max(64),
    factIds: z.array(identifierSchema).max(64).default([]),
    provenance: knowledgeProvenanceSchema,
    impactSummary: z.string().trim().min(1).max(4_096),
    status: knowledgeProposalStatusSchema.default("proposed"),
    reviewedBy: identifierSchema.nullable().default(null),
    reviewReason: z.string().trim().max(4_096).nullable().default(null),
    reviewedAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type KnowledgeProposal = z.infer<typeof knowledgeProposalSchema>;

export const knowledgeProposalInputSchema = knowledgeProposalSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    id: identifierSchema.optional(),
    createdAt: isoTimestampSchema.optional(),
    updatedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type KnowledgeProposalInput = z.input<typeof knowledgeProposalInputSchema>;

export const knowledgeChangeRequestSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    proposalId: identifierSchema,
    targetPath: z.string().trim().min(1).max(1_024),
    baseCommitSha: z.string().trim().max(128).nullable().default(null),
    content: z.string().max(1_048_576),
    impactSummary: z.string().trim().min(1).max(4_096),
    status: knowledgeChangeRequestStatusSchema.default("proposed"),
    decidedBy: identifierSchema.nullable().default(null),
    decisionReason: z.string().trim().max(4_096).nullable().default(null),
    decidedAt: isoTimestampSchema.nullable().default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type KnowledgeChangeRequest = z.infer<typeof knowledgeChangeRequestSchema>;

export const knowledgeSignalSchema = z
  .object({
    kind: z.enum(["contradiction", "staleness"]),
    severity: z.enum(["info", "warning", "critical"]),
    organizationId: identifierSchema,
    factIds: z.array(identifierSchema).min(1).max(64),
    title: z.string().trim().min(1).max(512),
    detail: z.string().trim().min(1).max(4_096),
    detectedAt: isoTimestampSchema,
    relatedMemoryIds: z.array(identifierSchema).max(64).default([]),
  })
  .strict();
export type KnowledgeSignal = z.infer<typeof knowledgeSignalSchema>;

export const knowledgeReviewInputSchema = z
  .object({
    organizationId: identifierSchema,
    proposalId: identifierSchema,
    action: z.enum(["accept", "reject", "withdraw"]),
    actorId: identifierSchema,
    reason: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type KnowledgeReviewInput = z.infer<typeof knowledgeReviewInputSchema>;
