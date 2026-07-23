import { z } from "zod";
import { identifierSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives";

export const memoryKindSchema = z.enum([
  "observation",
  "decision",
  "discovery",
  "problem",
  "solution",
  "preference",
  "incident",
  "blocker",
  "checkpoint",
  "diary",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryStatusSchema = z.enum(["active", "superseded", "invalidated", "archived"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memorySensitivitySchema = z.enum(["public", "internal", "confidential", "restricted"]);
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;

export const memoryRetentionPolicySchema = z.enum(["standard", "short", "long", "indefinite"]);
export type MemoryRetentionPolicy = z.infer<typeof memoryRetentionPolicySchema>;

export const memoryScopeSchema = z
  .object({
    organizationId: identifierSchema,
    projectId: identifierSchema.nullable().default(null),
    goalId: identifierSchema.nullable().default(null),
    workItemId: identifierSchema.nullable().default(null),
    agentId: identifierSchema.nullable().default(null),
    topic: z.string().trim().max(256).nullable().default(null),
  })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryEvidenceSchema = z
  .object({
    kind: z.enum(["session", "attempt", "event", "artifact", "workflow", "manual", "file"]),
    sourceId: identifierSchema,
    label: z.string().trim().min(1).max(512),
    uri: z.string().trim().max(2_048).nullable().default(null),
  })
  .strict();
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>;

export const memoryProvenanceSchema = z
  .object({
    sourceType: z.enum(["session", "attempt", "event", "artifact", "workflow", "manual"]),
    sourceId: identifierSchema,
    capturedAt: isoTimestampSchema,
    actorId: identifierSchema.nullable().default(null),
    extractor: z.string().trim().max(128).nullable().default(null),
  })
  .strict();
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const memoryRetentionSchema = z
  .object({
    policy: memoryRetentionPolicySchema.default("standard"),
    expiresAt: isoTimestampSchema.nullable().default(null),
  })
  .strict();
export type MemoryRetention = z.infer<typeof memoryRetentionSchema>;

export const memoryRecordSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    kind: memoryKindSchema,
    title: z.string().trim().min(1).max(512),
    content: z.string().max(1_048_576),
    contentHash: z.string().length(64),
    scope: memoryScopeSchema,
    sensitivity: memorySensitivitySchema.default("internal"),
    provenance: memoryProvenanceSchema,
    evidence: z.array(memoryEvidenceSchema).min(1).max(64),
    retention: memoryRetentionSchema.default({ policy: "standard", expiresAt: null }),
    status: memoryStatusSchema.default("active"),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    relatedIds: z.array(identifierSchema).max(64).default([]),
    supersedesId: identifierSchema.nullable().default(null),
    metadata: jsonObjectSchema.default({}),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memoryRecordInputSchema = memoryRecordSchema
  .omit({ id: true, contentHash: true, createdAt: true, updatedAt: true })
  .extend({
    id: identifierSchema.optional(),
    createdAt: isoTimestampSchema.optional(),
    updatedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type MemoryRecordInput = z.input<typeof memoryRecordInputSchema>;

export const memorySearchFiltersSchema = z
  .object({
    kinds: z.array(memoryKindSchema).max(16).default([]),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    sensitivity: z.array(memorySensitivitySchema).max(4).default([]),
    includeInactive: z.boolean().default(false),
  })
  .strict();
export type MemorySearchFilters = z.infer<typeof memorySearchFiltersSchema>;

export const memorySearchQuerySchema = z
  .object({
    organizationId: identifierSchema,
    query: z.string().trim().max(4_096).default(""),
    scope: memoryScopeSchema.partial().default({}),
    filters: memorySearchFiltersSchema.default({
      kinds: [],
      tags: [],
      sensitivity: [],
      includeInactive: false,
    }),
    limit: z.number().int().min(1).max(100).default(20),
    deep: z.boolean().default(false),
  })
  .strict();
export type MemorySearchQuery = z.input<typeof memorySearchQuerySchema>;

export const memoryCheckpointPhaseSchema = z.enum(["periodic", "before_compaction", "final"]);
export type MemoryCheckpointPhase = z.infer<typeof memoryCheckpointPhaseSchema>;

export const memoryCheckpointInputSchema = z
  .object({
    organizationId: identifierSchema,
    phase: memoryCheckpointPhaseSchema,
    title: z.string().trim().min(1).max(512),
    content: z.string().max(1_048_576),
    sourceType: z.enum(["session", "attempt", "workflow"]),
    sourceId: identifierSchema,
    sessionId: identifierSchema.nullable().default(null),
    attemptId: identifierSchema.nullable().default(null),
    agentId: identifierSchema.nullable().default(null),
    scope: memoryScopeSchema,
    evidence: z.array(memoryEvidenceSchema).min(1).max(64),
    tags: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    metadata: jsonObjectSchema.default({}),
  })
  .strict();
export type MemoryCheckpointInput = z.input<typeof memoryCheckpointInputSchema>;
