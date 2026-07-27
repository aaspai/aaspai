import { z } from "zod";
import { providerCapabilitiesSchema } from "./capabilities";
import {
  identifierSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives";

/**
 * Version of the harness (adapter) contract.
 *
 * Bump when AdapterExecutionContext, AdapterExecutionResult, or
 * TranscriptEntry change in a way that is not backward compatible.
 */
export const HARNESS_PROTOCOL_VERSION = 1 as const;

/** All adapter type identifiers known to the foundation. */
export const ADAPTER_TYPE_VALUES = [
  "claude_local",
  "codex_local",
  "cursor_local",
  "cursor_cloud",
  "openclaw_gateway",
  "hermes_gateway",
  "dry_run_local",
  "opencode_local",
  "opencode_cli",
] as const;

export const adapterTypeSchema = z.enum(ADAPTER_TYPE_VALUES);
export type AdapterType = z.infer<typeof adapterTypeSchema>;

/** Identity of an agent passed to an adapter. */
export const adapterAgentSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    name: z.string().trim().min(1).max(256),
    adapterType: adapterTypeSchema,
    adapterConfig: jsonObjectSchema,
  })
  .strict();
export type AdapterAgent = z.infer<typeof adapterAgentSchema>;

/** Carry-state for resuming a session across runs. */
export const adapterRuntimeSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(512).optional(),
    sessionParams: jsonObjectSchema.optional(),
    sessionDisplayId: z.string().trim().min(1).max(256).optional(),
    taskKey: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type AdapterRuntime = z.infer<typeof adapterRuntimeSchema>;

/** Token accounting for a run. */
export const usageSummarySchema = z
  .object({
    inputTokens: nonNegativeIntegerSchema.optional(),
    outputTokens: nonNegativeIntegerSchema.optional(),
    cachedInputTokens: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Family of error returned by an adapter. */
export const errorFamilySchema = z.enum([
  "transient_upstream",
  "provider_quota",
  "model_refusal",
  "auth",
  "config",
  "internal",
]);
export type ErrorFamily = z.infer<typeof errorFamilySchema>;

export const adapterBillingTypeSchema = z.enum([
  "api",
  "subscription",
  "metered_api",
  "credits",
  "free",
  "unknown",
]);
export type AdapterBillingType = z.infer<typeof adapterBillingTypeSchema>;

export const adapterEnvironmentCheckLevelSchema = z.enum(["info", "warn", "error"]);
export type AdapterEnvironmentCheckLevel = z.infer<typeof adapterEnvironmentCheckLevelSchema>;

export const adapterEnvironmentCheckSchema = z
  .object({
    name: identifierSchema,
    level: adapterEnvironmentCheckLevelSchema,
    message: z.string().trim().min(1).max(2_048),
    details: jsonObjectSchema.optional(),
  })
  .strict();
export type AdapterEnvironmentCheck = z.infer<typeof adapterEnvironmentCheckSchema>;

export const adapterEnvironmentTestContextSchema = z
  .object({
    config: jsonObjectSchema,
    cwd: z.string().trim().min(1).optional(),
  })
  .strict();
export type AdapterEnvironmentTestContext = z.infer<typeof adapterEnvironmentTestContextSchema>;

export const adapterEnvironmentTestResultSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(adapterEnvironmentCheckSchema).max(128),
  })
  .strict();
export type AdapterEnvironmentTestResult = z.infer<typeof adapterEnvironmentTestResultSchema>;

/** A long-lived runtime service an adapter may have started. */
export const adapterRuntimeServiceReportSchema = z
  .object({
    name: identifierSchema,
    scope: z.enum(["run", "session", "workspace", "global"]),
    port: positiveIntegerSchema.optional(),
    url: z.string().trim().min(1).max(2_048).optional(),
    status: z.enum(["starting", "ready", "failed", "stopped"]),
    details: jsonObjectSchema.optional(),
  })
  .strict();
export type AdapterRuntimeServiceReport = z.infer<typeof adapterRuntimeServiceReportSchema>;

export const adapterExecutionResultSchema = z
  .object({
    protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(32).optional(),
    timedOut: z.boolean().default(false),
    errorMessage: z.string().trim().min(1).max(8_192).optional(),
    errorCode: z.string().trim().min(1).max(128).optional(),
    errorFamily: errorFamilySchema.optional(),
    summary: z.string().trim().min(1).max(8_192).optional(),
    usage: usageSummarySchema.optional(),
    usageBasis: z.enum(["per_run", "session_cumulative"]).default("per_run"),
    sessionId: z.string().trim().min(1).max(512).optional(),
    sessionParams: jsonObjectSchema.optional(),
    sessionDisplayId: z.string().trim().min(1).max(256).optional(),
    provider: z.string().trim().min(1).max(128).optional(),
    biller: z.string().trim().min(1).max(128).optional(),
    billingType: adapterBillingTypeSchema.optional(),
    model: z.string().trim().min(1).max(256).optional(),
    costUsd: z.number().nonnegative().optional(),
    runtimeServices: z.array(adapterRuntimeServiceReportSchema).max(32).optional(),
    resultJson: jsonObjectSchema.optional(),
    clearSession: z.boolean().default(false),
    question: z
      .object({
        prompt: z.string().trim().min(1).max(8_192),
        options: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AdapterExecutionResult = z.infer<typeof adapterExecutionResultSchema>;

/** Full context passed to AdapterModule.execute(). */
export const adapterExecutionContextSchema = z
  .object({
    protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
    runId: identifierSchema,
    organizationId: identifierSchema,
    agent: adapterAgentSchema,
    runtime: adapterRuntimeSchema,
    config: jsonObjectSchema,
    context: z
      .object({
        cwd: z.string().trim().min(1),
        prompt: z.string().trim().min(1).max(1_048_576),
        role: z.string().trim().min(1).max(64).optional(),
        attachments: z
          .array(
            z
              .object({
                kind: z.enum(["file", "url", "inline"]),
                path: z.string().trim().min(1).max(8_192).optional(),
                url: z.string().trim().min(1).max(8_192).optional(),
                content: z.string().trim().min(1).max(1_048_576).optional(),
                mimeType: z.string().trim().min(1).max(256).optional(),
              })
              .strict(),
          )
          .max(64)
          .optional(),
      })
      .strict(),
    signal: z
      .custom<AbortSignal>((v) => typeof v === "object" && v !== null, {
        message: "signal must be an AbortSignal",
      })
      .optional(),
    onLog: z.custom<(stream: "stdout" | "stderr", chunk: string) => Promise<void> | void>(
      (v) => typeof v === "function",
      { message: "onLog must be a function" },
    ),
    /**
     * Optional: a tool dispatcher the adapter can use to handle
     * `tool_use` events. When provided, the adapter looks up the
     * tool by name and (if found) awaits the dispatcher's
     * `invoke(name, input)` method, then emits the result back
     * through `onLog` / `onRuntimeProgress` as a `tool_result` event.
     * The adapter does NOT itself decide what a tool does — it
     * just routes the call.
     */
    tools: z
      .custom<{
        invoke(name: string, input: unknown, ctx: unknown): Promise<unknown>;
        /** Look up a tool by name; returns null if unknown. */
        get?(name: string): unknown;
        /** List all available tool names. */
        list?(): readonly string[];
      }>((v) => typeof v === "object" && v !== null, {
        message: "tools must be a tool-dispatcher object",
      })
      .optional(),
    onMeta: z
      .custom<(meta: Record<string, unknown>) => Promise<void> | void>(
        (v) => typeof v === "function",
        { message: "onMeta must be a function" },
      )
      .optional(),
    onRuntimeProgress: z
      .custom<(update: unknown) => Promise<void> | void>((v) => typeof v === "function", {
        message: "onRuntimeProgress must be a function",
      })
      .optional(),
    onSpawn: z
      .custom<(meta: { pid: number }) => Promise<void> | void>((v) => typeof v === "function", {
        message: "onSpawn must be a function",
      })
      .optional(),
  })
  .strict();
export type AdapterExecutionContext = z.infer<typeof adapterExecutionContextSchema>;

/** Canonical transcript entry union (the wire format fan-in). */
export const transcriptEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("assistant"),
      ts: z.string(),
      text: z.string(),
      delta: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thinking"),
      ts: z.string(),
      text: z.string(),
      delta: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("user"),
      ts: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_call"),
      ts: z.string(),
      name: z.string(),
      status: z.enum(["started", "completed", "failed", "cancelled"]),
      id: z.string().optional(),
      input: jsonObjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_result"),
      ts: z.string(),
      name: z.string(),
      id: z.string().optional(),
      output: z.string().optional(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("init"),
      ts: z.string(),
      model: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      ts: z.string(),
      summary: z.string().optional(),
      stopReason: z.string().optional(),
      isError: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stderr"),
      ts: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      ts: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stdout"),
      ts: z.string(),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("diff"),
      ts: z.string(),
      path: z.string(),
      patch: z.string(),
    })
    .strict(),
]);
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** Static metadata describing an adapter for the host registry. */
export const adapterInfoSchema = z
  .object({
    type: adapterTypeSchema,
    label: z.string().trim().min(1).max(128),
    transport: z.enum(["local_subprocess", "cloud_sdk", "gateway"]),
    models: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(256),
            label: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    agentConfigurationDoc: z.string().max(65_536).default(""),
    status: z.enum(["ready", "stub"]).default("stub"),
    capabilities: providerCapabilitiesSchema.optional(),
  })
  .strict();
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;

/* ────────────────────────────────────────────────────────────────────
 *  Tier 3 (this pass): typed ResultJson + Usage + SessionEvent enum +
 *  Adapter.compact / cancel / describe / fork operations
 *  ──────────────────────────────────────────────────────────────────── */

/** Token usage breakdown (per step or per run). */
export const usageSchema = z
  .object({
    inputTokens: nonNegativeIntegerSchema.optional(),
    outputTokens: nonNegativeIntegerSchema.optional(),
    reasoningTokens: nonNegativeIntegerSchema.optional(),
    cacheReadTokens: nonNegativeIntegerSchema.optional(),
    cacheWriteTokens: nonNegativeIntegerSchema.optional(),
    totalTokens: nonNegativeIntegerSchema.optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

/** Discriminated union of session events written to the `session_events` table. */
export const sessionEventKindSchema = z.enum([
  "init",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
  "user",
  "result",
  "stderr",
  "compaction",
  "snapshot",
  "permission_ask",
  "question",
  "cost",
  "info",
  "warn",
  "error",
]);
export type SessionEventKind = z.infer<typeof sessionEventKindSchema>;

/** Typed ResultJson — replaces the untyped `jsonObjectSchema` for adapters. */
export const resultJsonSchema = z
  .object({
    cli: z.string().optional(),
    model: z.string().optional(),
    resumedSession: z.boolean().optional(),
    continuedLast: z.boolean().optional(),
    attached: z.boolean().optional(),
    cliSessionId: z.string().optional(),
    thinkingEventCount: nonNegativeIntegerSchema.optional(),
    toolEventCount: nonNegativeIntegerSchema.optional(),
    toolEvents: z
      .array(
        z
          .object({
            name: z.string(),
            status: z.string().optional(),
            output: z.string().optional(),
            id: z.string().optional(),
            ts: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    textEvents: z
      .array(
        z
          .object({
            text: z.string(),
            ts: z.string().optional(),
            delta: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    thinkingEvents: z
      .array(
        z
          .object({
            text: z.string(),
            ts: z.string().optional(),
            delta: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    toolsInvoked: z.array(z.string()).optional(),
    /** Per-step usage entries. */
    stepUsage: z
      .array(usageSchema.extend({ step: nonNegativeIntegerSchema.optional() }))
      .optional(),
    /** Session events that were forwarded to the adapter. */
    sessionEvents: z
      .array(
        z
          .object({
            kind: sessionEventKindSchema,
            ts: z.string().optional(),
            seq: nonNegativeIntegerSchema.optional(),
            payload: jsonObjectSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    /** Compaction event records. */
    compactions: z
      .array(
        z
          .object({
            at: z.string(),
            tailTurns: nonNegativeIntegerSchema.optional(),
            tokensBefore: nonNegativeIntegerSchema.optional(),
            tokensAfter: nonNegativeIntegerSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    /** Snapshot event records. */
    snapshots: z
      .array(
        z
          .object({
            at: z.string(),
            hash: z.string(),
          })
          .strict(),
      )
      .optional(),
    /** MCP servers configured for this run. */
    mcpServers: z.array(z.string()).optional(),
    /** Skills materialized for this run. */
    skills: z.array(z.string()).optional(),
    /** Free-form per-adapter extras (escape hatch for adapter-specific data). */
    extra: jsonObjectSchema.optional(),
  })
  .strict();
export type ResultJson = z.infer<typeof resultJsonSchema>;

/** Cancellation token shape for `Adapter.cancel()`. */
export const adapterCancelRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    /** When the cancellation was requested. */
    requestedAt: z.string().optional(),
    /** Who/what requested the cancellation. */
    requestedBy: z.string().optional(),
    /** Optional reason (e.g. "budget_exceeded", "user_cancelled"). */
    reason: z.string().max(512).optional(),
  })
  .strict();
export type AdapterCancelRequest = z.infer<typeof adapterCancelRequestSchema>;

/** Result of an `Adapter.cancel()` call. */
export const adapterCancelResultSchema = z
  .object({
    cancelled: z.boolean(),
    sessionId: z.string(),
    /** Final status of the run (if known). */
    finalStatus: z.enum(["cancelled", "interrupted", "completed", "already_finished"]).optional(),
  })
  .strict();
export type AdapterCancelResult = z.infer<typeof adapterCancelResultSchema>;

/** Compaction request — shrinks session context. */
export const adapterCompactRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(512),
    /** Keep this many tail turns; older ones get summarized. */
    tailTurns: nonNegativeIntegerSchema.optional(),
    /** Force compaction even if under the auto threshold. */
    force: z.boolean().default(false),
  })
  .strict();
export type AdapterCompactRequest = z.infer<typeof adapterCompactRequestSchema>;

/** Result of an `Adapter.compact()` call. */
export const adapterCompactResultSchema = z
  .object({
    compacted: z.boolean(),
    sessionId: z.string(),
    tokensBefore: nonNegativeIntegerSchema.optional(),
    tokensAfter: nonNegativeIntegerSchema.optional(),
    summary: z.string().optional(),
  })
  .strict();
export type AdapterCompactResult = z.infer<typeof adapterCompactResultSchema>;

/** Fork request — copy a session to a new one. */
export const adapterForkRequestSchema = z
  .object({
    parentSessionId: z.string().min(1).max(512),
    /** Fork from this step (inclusive). Default: latest. */
    fromStep: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type AdapterForkRequest = z.infer<typeof adapterForkRequestSchema>;

/** Result of an `Adapter.fork()` call. */
export const adapterForkResultSchema = z
  .object({
    forked: z.boolean(),
    parentSessionId: z.string(),
    childSessionId: z.string().optional(),
  })
  .strict();
export type AdapterForkResult = z.infer<typeof adapterForkResultSchema>;

/** Describes the capabilities + tool set of an adapter. */
export const adapterDescribeSchema = z
  .object({
    type: adapterTypeSchema,
    label: z.string(),
    models: z.array(z.object({ id: z.string(), label: z.string() }).strict()).optional(),
    /** Native tools the adapter ships with (not via ctx.tools). */
    nativeTools: z.array(z.string()).optional(),
    /** Whether the adapter supports out-of-band cancel. */
    supportsCancel: z.boolean().default(false),
    /** Whether the adapter supports explicit compaction. */
    supportsCompact: z.boolean().default(false),
    /** Whether the adapter supports explicit fork. */
    supportsFork: z.boolean().default(false),
    /** Whether the adapter supports `--session` resume. */
    supportsResume: z.boolean().default(false),
    /** Whether the adapter supports thinking/extended-reasoning. */
    supportsThinking: z.boolean().default(false),
    /** Whether the adapter supports `--session <id> --fork`. */
    supportsForkSession: z.boolean().default(false),
    /** Max output tokens (best-effort). */
    maxOutputTokens: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type AdapterDescribe = z.infer<typeof adapterDescribeSchema>;

/** The full adapter contract. */
export const serverAdapterModuleSchema = z
  .object({
    info: adapterInfoSchema,
    execute: z.custom<(ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>>(
      (v) => typeof v === "function",
      { message: "execute must be a function" },
    ),
    testEnvironment: z.custom<
      (ctx: AdapterEnvironmentTestContext) => Promise<AdapterEnvironmentTestResult>
    >((v) => typeof v === "function", { message: "testEnvironment must be a function" }),
    // Tier 3 (this pass): out-of-band operations. All optional; default = "not supported".
    cancel: z
      .custom<(req: AdapterCancelRequest) => Promise<AdapterCancelResult>>(
        (v) => typeof v === "function",
        { message: "cancel must be a function" },
      )
      .optional(),
    compact: z
      .custom<(req: AdapterCompactRequest) => Promise<AdapterCompactResult>>(
        (v) => typeof v === "function",
        { message: "compact must be a function" },
      )
      .optional(),
    fork: z
      .custom<(req: AdapterForkRequest) => Promise<AdapterForkResult>>(
        (v) => typeof v === "function",
        { message: "fork must be a function" },
      )
      .optional(),
    describe: z
      .custom<() => AdapterDescribe | Promise<AdapterDescribe>>((v) => typeof v === "function", {
        message: "describe must be a function",
      })
      .optional(),
  })
  .strict();
export type ServerAdapterModule = z.infer<typeof serverAdapterModuleSchema>;

/** A single config field the UI can render. */
export const configFieldOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(256),
    value: z.string().trim().min(1).max(256),
  })
  .strict();
export type ConfigFieldOption = z.infer<typeof configFieldOptionSchema>;

export const configFieldSchemaSchema = z
  .object({
    key: identifierSchema,
    label: z.string().trim().min(1).max(256),
    kind: z.enum(["text", "select", "toggle", "number", "textarea", "combobox", "secret"]),
    help: z.string().trim().min(1).max(2_048).optional(),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(configFieldOptionSchema).max(256).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    placeholder: z.string().max(256).optional(),
  })
  .strict();
export type ConfigFieldSchema = z.infer<typeof configFieldSchemaSchema>;

export const adapterConfigSchemaSchema = z
  .object({
    fields: z.array(configFieldSchemaSchema).max(64),
  })
  .strict();
export type AdapterConfigSchema = z.infer<typeof adapterConfigSchemaSchema>;

export const adapterSessionCodecSchema = z
  .object({
    deserialize: z.custom<(raw: unknown) => unknown>((v) => typeof v === "function"),
    serialize: z.custom<(params: unknown) => unknown>((v) => typeof v === "function"),
    getDisplayId: z
      .custom<(params: unknown) => string | null>((v) => typeof v === "function")
      .optional(),
  })
  .strict();
export type AdapterSessionCodec = z.infer<typeof adapterSessionCodecSchema>;
