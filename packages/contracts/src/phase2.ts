import { z } from "zod";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives";

// ─────────────────────────────────────────────────────────────────
//  Agent config
// ─────────────────────────────────────────────────────────────────

export const agentRoleSchema = z.enum([
  "ceo", "cto", "cmo", "cfo", "security",
  "engineer", "designer", "pm", "qa",
  "devops", "researcher", "operator", "general",
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const toolRiskSchema = z.enum([
  "safe", "side_effect", "destructive", "network", "expensive",
]);
export type ToolRisk = z.infer<typeof toolRiskSchema>;

export const agentConfigSchema = z
  .object({
    id: identifierSchema,                              // "agent/<slug>"
    type: z.literal("Agent"),
    title: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(4_096),
    timestamp: isoTimestampSchema,
    adapter: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(256).optional(),
    role: agentRoleSchema,
    reportsTo: identifierSchema.nullable().default(null),
    manages: z.array(identifierSchema).max(64).default([]),
    peers: z.array(identifierSchema).max(64).default([]),
    systemPrompt: z.string().max(131_072).default(""),
    adapterConfig: jsonObjectSchema.default({}),
    runtimeConfig: jsonObjectSchema.default({}),
    runtime: jsonObjectSchema.default({}),
    tools: jsonObjectSchema.default({}),
    skills: z.array(
      z.object({ key: z.string(), version: z.string() }).strict(),
    ).max(64).default([]),
    knowledge: jsonObjectSchema.default({}),
    budget: jsonObjectSchema.default({}),
    relations: jsonObjectSchema.default({}),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ─────────────────────────────────────────────────────────────────
//  Knowledge (OKF v0.1)
// ─────────────────────────────────────────────────────────────────

export const okfFrontmatterSchema = z
  .object({
    type: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(4_096),
    resource: z.string().url().max(2_048).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
    timestamp: isoTimestampSchema,
  })
  .passthrough();
export type OkfFrontmatter = z.infer<typeof okfFrontmatterSchema>;

export const knowledgeConceptSchema = z
  .object({
    id: z.string().trim().min(1).max(512),            // "runbooks/deploy-vercel"
    path: z.string().trim().min(1).max(1_024),        // absolute file path
    type: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(4_096),
    tags: z.array(z.string()).max(32).default([]),
    timestamp: isoTimestampSchema,
    body: z.string().max(1_048_576),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    appliesToAgents: z.array(z.string()).max(64).default([]),
    appliesToSkills: z.array(z.string()).max(64).default([]),
    related: z.array(z.string()).max(64).default([]),
    lastUpdatedBy: z.string().optional(),
    lastUpdatedAt: isoTimestampSchema.optional(),
    hash: z.string().length(64),                        // sha256 of the file content
  })
  .strict();
export type KnowledgeConcept = z.infer<typeof knowledgeConceptSchema>;

// ─────────────────────────────────────────────────────────────────
//  Loop
// ─────────────────────────────────────────────────────────────────

export const triggerSchema = z
  .object({
    kind: z.enum(["cron", "interval", "webhook", "event", "api", "manual"]),
    expression: z.string().trim().max(256).optional(),
    timezone: z.string().trim().max(64).optional(),
    seconds: positiveIntegerSchema.optional(),
    path: z.string().trim().max(256).optional(),
    auth: z.string().trim().max(64).optional(),
    topic: z.string().trim().max(256).optional(),
    filter: jsonObjectSchema.optional(),
  })
  .strict();
export type Trigger = z.infer<typeof triggerSchema>;

export const autonomyLevelSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const loopStatusSchema = z.enum(["enabled", "paused", "archived"]);
export type LoopStatus = z.infer<typeof loopStatusSchema>;

export const loopPatternSchema = z
  .object({
    id: identifierSchema,                              // "loop/<slug>"
    type: z.literal("LoopPattern"),
    title: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(4_096),
    timestamp: isoTimestampSchema,
    schedule: triggerSchema,
    agent: identifierSchema,                           // which agent runs the actions
    autonomyLevel: autonomyLevelSchema.default("L1"),
    status: loopStatusSchema.default("enabled"),
    pauseReason: z.string().max(1_024).optional(),
    concurrencyPolicy: z.enum(["coalesce_if_active", "always_enqueue", "skip_if_active"]).default("coalesce_if_active"),
    catchUpPolicy: z.enum(["skip_missed", "enqueue_missed_with_cap"]).default("skip_missed"),
    configJson: z.string().max(65_536).default("{}"),
    gateJson: z.string().max(65_536).default("{}"),
    budgetJson: z.string().max(65_536).default("{}"),
  })
  .strict();
export type LoopPattern = z.infer<typeof loopPatternSchema>;

// ─────────────────────────────────────────────────────────────────
//  WorkItem + DecideResult
// ─────────────────────────────────────────────────────────────────

export const workItemRefSchema = z
  .object({
    kind: z.string().trim().min(1).max(64),
    id: z.string().trim().min(1).max(512),
    title: z.string().trim().min(1).max(512).optional(),
    url: z.string().url().optional(),
  })
  .passthrough();
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

export const workItemSchema = z
  .object({
    ref: workItemRefSchema,
    title: z.string().trim().min(1).max(512),
    description: z.string().max(8_192).optional(),
    data: jsonObjectSchema.optional(),
    discoveredAt: isoTimestampSchema,
  })
  .strict();
export type WorkItem = z.infer<typeof workItemSchema>;

export const decideResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report"), payload: z.object({
    title: z.string().min(1).max(512),
    body: z.string().min(1).max(65_536),
  }).strict() }).strict(),
  z.object({
    kind: z.literal("act"),
    wakeupId: z.string().min(1).max(512).optional(),
    reason: z.string().min(1).max(1_024),
  }).strict(),
  z.object({ kind: z.literal("escalate"), reason: z.string().min(1).max(1_024), severity: z.enum(["info", "warn", "critical"]) }).strict(),
  z.object({ kind: z.literal("noop") }).strict(),
]);
export type DecideResult = z.infer<typeof decideResultSchema>;

// ─────────────────────────────────────────────────────────────────
//  Wakeup
// ─────────────────────────────────────────────────────────────────

export const wakeupStatusSchema = z.enum([
  "queued", "claimed", "coalesced", "completed", "failed", "skipped", "cancelled",
]);
export type WakeupStatus = z.infer<typeof wakeupStatusSchema>;

export const wakeupSchema = z
  .object({
    id: identifierSchema,                              // "wake_<uuid>"
    organizationId: identifierSchema,
    loopId: identifierSchema,                         // FK to loops
    source: z.enum(["timer", "assignment", "routine", "on_demand", "continuation", "manual"]),
    triggerDetail: z.string().max(512).optional(),
    reason: z.string().max(1_024).optional(),
    agentId: identifierSchema.optional(),
    payload: jsonObjectSchema,
    status: wakeupStatusSchema.default("queued"),
    coalescedIntoWakeupId: identifierSchema.nullable().optional(),
    idempotencyKey: z.string().min(1).max(512),
    requestedAt: isoTimestampSchema,
    requestedByActorId: identifierSchema.optional(),
    requestedByActorType: z.enum(["user", "agent", "system"]).optional(),
    claimedAt: isoTimestampSchema.nullable().optional(),
    finishedAt: isoTimestampSchema.nullable().optional(),
    sessionId: identifierSchema.nullable().optional(),
    error: z.string().max(8_192).optional(),
  })
  .strict();
export type Wakeup = z.infer<typeof wakeupSchema>;

// ─────────────────────────────────────────────────────────────────
//  Session
// ─────────────────────────────────────────────────────────────────

export const sessionStatusSchema = z.enum([
  "queued", "running", "paused_for_question",
  "succeeded", "failed", "cancelled", "timed_out", "interrupted",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const pendingQuestionSchema = z.object({
  prompt: z.string().min(1).max(8_192),
  options: z.array(z.string().min(1).max(256)).max(64).optional(),
  askedAt: isoTimestampSchema,
}).strict();
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;

export const sessionRequestSchema = z
  .object({
    organizationId: identifierSchema,
    agentId: identifierSchema,
    adapter: z.string().trim().min(1).max(64),
    runtime: jsonObjectSchema,                          // ExecutionTarget
    prompt: z.string().min(1).max(1_048_576),
    config: jsonObjectSchema.default({}),
    skills: z.array(z.object({ key: z.string(), version: z.string() }).strict())
      .max(64).default([]),
    resume: z.object({
      sessionId: z.string().min(1).max(512),
      sessionParams: jsonObjectSchema.optional(),
    }).strict().optional(),
    budget: jsonObjectSchema.default({}),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    attachments: z.array(jsonObjectSchema).max(64).optional(),
    idempotencyKey: z.string().min(1).max(512),
    traceId: identifierSchema.optional(),
    wakeupId: identifierSchema.optional(),               // links back to the loop's wakeup
  })
  .strict();
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export const sessionResultSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    sessionParams: jsonObjectSchema.optional(),
    sessionDisplayId: z.string().min(1).max(256).optional(),
    status: sessionStatusSchema,
    exitCode: z.number().int().nullable().optional(),
    usage: jsonObjectSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
    errorFamily: z.enum([
      "transient_upstream", "provider_quota", "model_refusal",
      "auth", "config", "internal", "user_cancelled",
    ]).optional(),
    errorCode: z.string().max(128).optional(),
    summary: z.string().max(8_192).optional(),
    question: pendingQuestionSchema.optional(),
    logRef: z.string().max(1_024).optional(),
  })
  .strict();
export type SessionResult = z.infer<typeof sessionResultSchema>;

// Re-export schemas for direct use in places like `safeParse(row.resultJson, sessionResultSchema)`
export { sessionResultSchema as SessionResultSchema, pendingQuestionSchema as PendingQuestionSchema };

export const sessionStateSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    wakeupId: identifierSchema.optional(),
    agentId: identifierSchema,
    adapter: z.string().trim().min(1).max(64),
    runtime: jsonObjectSchema,
    prompt: z.string(),
    status: sessionStatusSchema,
    startedAt: isoTimestampSchema.nullable().optional(),
    finishedAt: isoTimestampSchema.nullable().optional(),
    durationMs: nonNegativeIntegerSchema.optional(),
    result: sessionResultSchema.optional(),
    parentSessionId: identifierSchema.nullable().optional(),
    question: pendingQuestionSchema.optional(),
    logRef: z.string().max(1_024).optional(),
  })
  .strict();
export type SessionState = z.infer<typeof sessionStateSchema>;

// ─────────────────────────────────────────────────────────────────
//  Skill
// ─────────────────────────────────────────────────────────────────

export const skillSchema = z
  .object({
    key: z.string().trim().min(1).max(256),           // "deploy-vercel"
    version: z.string().trim().min(1).max(64),        // "1.0.0"
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(4_096),
    instructions: z.string().max(1_048_576),
    files: z.array(z.object({ path: z.string().min(1).max(1_024), content: z.string().max(1_048_576) }).strict())
      .max(256).default([]),
    adapterTypes: z.array(z.string()).max(32).default([]),
    owner: z.string().min(1).max(256),
    visibility: z.enum(["private", "organization", "public"]).default("private"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    archivedAt: isoTimestampSchema.nullable().optional(),
  })
  .strict();
export type Skill = z.infer<typeof skillSchema>;

// ─────────────────────────────────────────────────────────────────
//  Tool
// ─────────────────────────────────────────────────────────────────

export const toolSchema = z
  .object({
    name: z.string().trim().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    description: z.string().trim().min(1).max(4_096),
    risk: toolRiskSchema,
    inputSchema: jsonObjectSchema,                      // JSON Schema-ish
    outputSchema: jsonObjectSchema.optional(),
    requires: z.object({
      adapters: z.array(z.string()).max(32).optional(),
      scopes: z.array(z.string()).max(16).optional(),
      network: z.boolean().optional(),
    }).strict().optional(),
    execute: z.custom<(input: unknown, ctx: unknown) => Promise<unknown>>(
      (v) => typeof v === "function",
    ),
  })
  .strict();
export type Tool = z.infer<typeof toolSchema>;

// ─────────────────────────────────────────────────────────────────
//  Source ports (the seam)
// ─────────────────────────────────────────────────────────────────

export const sourceDescriptorSchema = z
  .object({
    kind: z.string().trim().min(1).max(64),           // "file" | "db" | "http" | "composite" | "memory"
    label: z.string().trim().min(1).max(256),
    detail: jsonObjectSchema.optional(),
  })
  .strict();
export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;

export const changeEventSchema = z.object({
  kind: z.enum(["added", "updated", "removed"]),
  id: z.string().min(1).max(512),
  at: isoTimestampSchema,
}).passthrough();
export type ChangeEvent = z.infer<typeof changeEventSchema>;

export interface AgentConfigSource {
  get(id: string): Promise<Readonly<AgentConfig>>;
  has(id: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
  watch(callback: (change: ChangeEvent) => void): () => void;
  describe(): SourceDescriptor;
}

export interface KnowledgeSource {
  get(id: string): Promise<Readonly<KnowledgeConcept>>;
  has(id: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
  search(query: string, opts?: { limit?: number; tags?: string[] }): Promise<readonly KnowledgeConcept[]>;
  watch(callback: (change: ChangeEvent) => void): () => void;
  describe(): SourceDescriptor;
}

export interface LoopConfigSource {
  get(id: string): Promise<Readonly<LoopPattern>>;
  has(id: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
  watch(callback: (change: ChangeEvent) => void): () => void;
  describe(): SourceDescriptor;
}

export interface SkillSource {
  get(key: string): Promise<Readonly<Skill>>;
  has(key: string): Promise<boolean>;
  list(): Promise<readonly string[]>;
  watch(callback: (change: ChangeEvent) => void): () => void;
  describe(): SourceDescriptor;
}

// ─────────────────────────────────────────────────────────────────
//  Gate + Budget + Kill Switch
// ─────────────────────────────────────────────────────────────────

export const gateActionSchema = z
  .object({
    allowed: z.boolean(),
    requireApproval: z.enum(["human", "operator", "supervisor"]).optional(),
    scope: z.string().max(64).optional(),
    cooldownMs: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type GateAction = z.infer<typeof gateActionSchema>;

export const gatePolicySchema = z
  .object({
    denylist: z.array(z.string().min(1).max(1_024)).max(256).default([]),
    allowlist: z.array(z.string().min(1).max(1_024)).max(256).default([]),
    maxFilesChanged: nonNegativeIntegerSchema.default(0),
    actions: z.record(z.string(), gateActionSchema).default({}),
  })
  .strict();
export type GatePolicy = z.infer<typeof gatePolicySchema>;

export const budgetSchema = z
  .object({
    perRun: z.object({
      tokens: nonNegativeIntegerSchema.default(0),
      costUsd: z.number().nonnegative().default(0),
      durationMs: nonNegativeIntegerSchema.default(0),
    }).strict().optional(),
    perDay: z.object({
      tokens: nonNegativeIntegerSchema.default(0),
      costUsd: z.number().nonnegative().default(0),
      runs: nonNegativeIntegerSchema.default(0),
    }).strict().optional(),
    perMonth: z.object({
      tokens: nonNegativeIntegerSchema.default(0),
      costUsd: z.number().nonnegative().default(0),
    }).strict().optional(),
    soft: z.number().min(0).max(1).default(0.8),
    hard: z.number().min(0).max(1).default(1.0),
  })
  .strict();
export type Budget = z.infer<typeof budgetSchema>;

export const DEFAULT_BUDGET: Readonly<Budget> = Object.freeze({
  soft: 0.8,
  hard: 1.0,
}) as Budget;

export function parseBudget(input: unknown): Budget {
  if (input === undefined || input === null) return { ...DEFAULT_BUDGET };
  return budgetSchema.parse(input);
}

// ─────────────────────────────────────────────────────────────────
//  Ledger (circuit breaker)
// ─────────────────────────────────────────────────────────────────

export const ledgerAttemptSchema = z
  .object({
    iteration: nonNegativeIntegerSchema,
    action: z.string().min(1).max(256),
    outcome: z.enum(["success", "failure", "noop"]),
    error: z.object({ signature: z.string(), message: z.string() }).strict().optional(),
    tokensUsed: nonNegativeIntegerSchema.optional(),
    ts: isoTimestampSchema,
  })
  .strict();
export type LedgerAttempt = z.infer<typeof ledgerAttemptSchema>;

export const circuitPolicySchema = z
  .object({
    stagnationThreshold: nonNegativeIntegerSchema.default(3),
    noProgressThreshold: nonNegativeIntegerSchema.default(5),
    maxIterations: nonNegativeIntegerSchema.default(10),
    budgetOverride: budgetSchema.optional(),
    onExceedScript: z.string().max(1_024).optional(),
  })
  .strict();
export type CircuitPolicy = z.infer<typeof circuitPolicySchema>;

export const circuitDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue") }).strict(),
  z.object({
    kind: z.literal("escalate"),
    reason: z.enum(["stagnation", "no_progress", "budget", "max_iterations"]),
    summary: z.string().min(1).max(8_192),
  }).strict(),
]);
export type CircuitDecision = z.infer<typeof circuitDecisionSchema>;
