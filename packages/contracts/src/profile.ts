import { z } from "zod";
import { definitionRevisionSchema } from "./execution";
import {
  agentConfigSchema,
  knowledgeConceptSchema,
  skillSchema,
  sourceDescriptorSchema,
} from "./phase2";
import { identifierSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives";
import { executionTargetSchema } from "./runtime";

export const profileToolDecisionSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    allowed: z.boolean(),
    ready: z.boolean(),
    requiresApproval: z.boolean().default(false),
    denialReason: z.string().max(1_024).optional(),
    readinessReason: z.string().max(1_024).optional(),
    tool: z
      .object({
        name: z.string().min(1),
        description: z.string(),
        risk: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProfileToolDecision = z.infer<typeof profileToolDecisionSchema>;

export const resolvedSkillSchema = z
  .object({
    key: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(64),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    skill: skillSchema,
  })
  .strict();
export type ResolvedSkill = z.infer<typeof resolvedSkillSchema>;

export const resolvedKnowledgeSchema = z
  .object({
    include: z.array(z.string().max(512)).max(256),
    exclude: z.array(z.string().max(512)).max(256),
    concepts: z.array(knowledgeConceptSchema).max(100),
    context: z.string().max(5_000_000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();
export type ResolvedKnowledge = z.infer<typeof resolvedKnowledgeSchema>;

export const resolvedAgentProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileHash: z.string().regex(/^[a-f0-9]{64}$/i),
    organizationId: identifierSchema,
    agentId: identifierSchema,
    definitionRevision: definitionRevisionSchema,
    createdAt: isoTimestampSchema,
    sources: z
      .object({
        agent: sourceDescriptorSchema,
        skills: sourceDescriptorSchema,
        knowledge: sourceDescriptorSchema,
      })
      .strict(),
    agent: agentConfigSchema,
    skills: z.array(resolvedSkillSchema).max(64),
    knowledge: resolvedKnowledgeSchema,
    tools: z.array(profileToolDecisionSchema).max(256),
    runtime: z
      .object({
        target: executionTargetSchema,
        ready: z.boolean(),
        identity: z.string().trim().min(1).max(512),
        reason: z.string().max(1_024).optional(),
      })
      .strict(),
    harness: z
      .object({
        adapter: z.string().trim().min(1).max(128),
        ready: z.boolean(),
        reason: z.string().max(1_024).optional(),
      })
      .strict(),
    materialization: z
      .object({
        adapterType: z.string().trim().min(1).max(128),
        files: z
          .array(
            z
              .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i) })
              .strict(),
          )
          .max(2_000),
      })
      .strict(),
    inputs: z
      .object({
        prompt: z.string().max(131_072),
        adapterConfig: jsonObjectSchema,
        runtimeConfig: jsonObjectSchema,
        budget: jsonObjectSchema,
        toolPolicy: jsonObjectSchema,
        knowledgeScope: jsonObjectSchema,
      })
      .strict(),
  })
  .strict();
export type ResolvedAgentProfile = z.infer<typeof resolvedAgentProfileSchema>;

export type ResolvedAgentProfileSnapshot = Readonly<ResolvedAgentProfile>;

export function freezeResolvedAgentProfile<T extends ResolvedAgentProfile>(profile: T): T {
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(profile);
  return profile;
}
