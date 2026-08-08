import { z } from "zod";
import { providerCapabilitiesSchema } from "./capabilities";
import {
  identifierSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives";
import type { RunProcessOptions, RunProcessResult } from "./runtime";

/**
 * Current production harness contract version. Bump when
 * AdapterExecutionContext, AdapterExecutionResult, or TranscriptEntry
 * changes in a way that is not backward compatible.
 */
export const HARNESS_PROTOCOL_VERSION = 2 as const;

/**
 * Adapter identifiers accepted by durable definitions. Only `opencode_local`
 * is enabled by the production registry; the remaining values are retained
 * for explicit migration errors in older persisted records.
 */
export const ADAPTER_TYPE_VALUES = [
  "claude_local",
  "codex_local",
  "cursor_local",
  "cursor_cloud",
  "gemini_local",
  "grok_local",
  "pi_local",
  "hermes_local",
  "hermes",
  "openclaw_gateway",
  "hermes_gateway",
  "dry_run_local",
  "opencode_cli",
  "opencode_local",
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
    runtimeIdentity: jsonObjectSchema.optional(),
  })
  .strict();
export type AdapterRuntime = z.infer<typeof adapterRuntimeSchema>;

/** Runtime-owned process boundary used by provider adapters. */
export interface AdapterRuntimeExecution {
  run(options: RunProcessOptions): Promise<RunProcessResult>;
  /** Optional long-lived process boundary used by server-based adapters. */
  start?(
    options: RunProcessOptions,
    hooks?: {
      onStdout?(chunk: Uint8Array): Promise<void> | void;
      onStderr?(chunk: Uint8Array): Promise<void> | void;
    },
  ): Promise<{
    wait(): Promise<unknown>;
    cancel(reason?: string): Promise<void>;
  }>;
  identity?: Record<string, unknown>;
  /**
   * Environment selected by the runtime owner for adapter-owned child
   * processes. This is deliberately ephemeral and is not persisted with the
   * agent configuration.
   */
  environment?: {
    env: Record<string, string>;
    inheritEnv?: boolean;
  };
  /** Expose a private runtime port for a server living in a remote sandbox. */
  exposeEndpoint?(options: { port: number; protocol?: "http" | "https" | "tcp" }): Promise<{
    url: string;
    headers?: Record<string, string>;
    expiresAt?: string;
    refresh?(): Promise<unknown>;
    close?(): Promise<void>;
  }>;
}

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

/** Final disposition of a single adapter execution. */
export const executionStatusSchema = z.enum(["completed", "failed", "cancelled", "timed_out"]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const adapterExecutionResultSchema = z
  .object({
    protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(32).optional(),
    timedOut: z.boolean().default(false),
    /** High-level run disposition; orchestrators consume this instead of exitCode/signal. */
    status: executionStatusSchema.optional(),
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
    runtimeIdentity: jsonObjectSchema.optional(),
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
        systemPrompt: z.string().max(1_048_576).optional(),
        role: z.string().trim().min(1).max(64).optional(),
        issueId: identifierSchema.optional(),
        taskId: identifierSchema.optional(),
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
    /**
     * The runtime process boundary. REQUIRED: even local execution
     * goes through a runtime (`runtime.run()`), so adapters never
     * spawn / kill / taskkill processes themselves. Callers that run
     * directly on the host inject a local runtime here.
     */
    execution: z.custom<AdapterRuntimeExecution>((v) => typeof v === "object" && v !== null, {
      message: "execution must be a runtime process boundary",
    }),
    onLog: z.custom<(stream: "stdout" | "stderr", chunk: string) => Promise<void> | void>(
      (v) => typeof v === "function",
      { message: "onLog must be a function" },
    ),
    /**
     * Semantic event channel (replaces JSON-string round-trips on
     * `onLog`). Adapters that emit typed `HarnessEvent`s call this
     * instead of serializing events back into `onLog` stdout chunks.
     */
    onEvent: z
      .custom<(event: HarnessEvent) => Promise<void> | void>((v) => typeof v === "function", {
        message: "onEvent must be a function",
      })
      .optional(),
    /**
     * Raw native process output channel, for observability/debugging.
     * Untouched bytes from the child's stdout/stderr; distinct from
     * `onLog` (which carries normalized/structured lines today) and
     * from `onEvent` (typed semantic events).
     */
    onRawLog: z
      .custom<(entry: RawLogEntry) => Promise<void> | void>((v) => typeof v === "function", {
        message: "onRawLog must be a function",
      })
      .optional(),
    /** OpenCode-native tools are caller-prepared and observed through events. */
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
    /**
     * Interactive question/answer channel. When the adapter needs a
     * human decision it calls this with the prompt (and optional
     * choices). The handler pauses the session (`paused_for_question`)
     * and resolves with the human's answer once they respond. Adapters
     * that cannot block (for example, a detached transport) may call it
     * fire-and-forget.
     */
    onQuestion: z
      .custom<
        (question: {
          prompt: string;
          options?: string[];
        }) => Promise<string | undefined> | string | undefined
      >((v) => typeof v === "function", {
        message: "onQuestion must be a function",
      })
      .optional(),
    /** Permission decisions are distinct from free-form questions. */
    onPermission: z
      .custom<
        (permission: {
          toolName: string;
          description?: string;
          input?: unknown;
        }) => Promise<"once" | "always" | "reject"> | "once" | "always" | "reject"
      >((v) => typeof v === "function", {
        message: "onPermission must be a function",
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

/**
 * Canonical, typed event emitted by an adapter as it runs.
 *
 * This is the semantic channel that sessions / UI / orchestration
 * consume. It is deliberately separate from:
 *  - `onRawLog` — the untouched native process bytes (observability),
 *  - `onRuntimeProgress` — coarse transfer-phase progress
 *    (`git_sync` / `upload` / `download`, …).
 *
 * Adapters decode their native protocol once and emit `HarnessEvent`s;
 * they must NOT re-serialize semantic events back into JSON strings on
 * the raw-log channel (that's what `onEvent` is for).
 */
export const harnessEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run.started"),
      timestamp: z.string(),
      runId: z.string().trim().min(1).max(128),
      sessionId: z.string().trim().min(1).max(512).optional(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
      adapter: z.string().trim().min(1).max(64),
      model: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("native.session"),
      timestamp: z.string(),
      nativeSessionId: z.string().trim().min(1).max(512),
      sessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("assistant.delta"),
      timestamp: z.string(),
      text: z.string(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning.delta"),
      timestamp: z.string(),
      text: z.string(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool.started"),
      timestamp: z.string(),
      toolName: z.string().trim().min(1).max(128),
      toolCallId: z.string().trim().min(1).max(256).optional(),
      input: z.unknown().optional(),
      /**
       * Who actually runs this tool. `native` = the provider executes it
       * in its own loop (harness only observes). `aaspai` = AASPAI
       * owns execution (adapter-defined tool). The distinction stops
       * double-execution of native tools.
       */
      executionAuthority: z.enum(["native", "aaspai"]),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool.completed"),
      timestamp: z.string(),
      toolName: z.string().trim().min(1).max(128),
      toolCallId: z.string().trim().min(1).max(256).optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      executionAuthority: z.enum(["native", "aaspai"]),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool.failed"),
      timestamp: z.string(),
      toolName: z.string().trim().min(1).max(128),
      toolCallId: z.string().trim().min(1).max(256).optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      errorMessage: z.string().max(8_192).optional(),
      executionAuthority: z.enum(["native", "aaspai"]),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("step.started"),
      timestamp: z.string(),
      step: z.number().int().nonnegative().optional(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("step.completed"),
      timestamp: z.string(),
      step: z.number().int().nonnegative().optional(),
      usage: usageSummarySchema.optional(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      timestamp: z.string(),
      usage: usageSummarySchema,
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("warning"),
      timestamp: z.string(),
      message: z.string().trim().min(1).max(8_192),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      timestamp: z.string(),
      message: z.string().trim().min(1).max(8_192),
      code: z.string().trim().min(1).max(128).optional(),
      family: errorFamilySchema.optional(),
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.completed"),
      timestamp: z.string(),
      status: executionStatusSchema,
      nativeSessionId: z.string().trim().min(1).max(512).optional(),
    })
    .strict(),
]);
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

/** One chunk of untouched native process output (for observability). */
export const rawLogEntrySchema = z
  .object({
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string(),
    ts: z.string().optional(),
  })
  .strict();
export type RawLogEntry = z.infer<typeof rawLogEntrySchema>;

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
 * Persisted result, usage, session-event, and native-session control schemas.
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
    /** Native tools the adapter exposes through its prepared configuration. */
    nativeTools: z.array(z.string()).optional(),
    /** Whether the adapter supports out-of-band cancel. */
    supportsCancel: z.boolean().default(false),
    /** Whether the adapter supports explicit compaction. */
    supportsCompact: z.boolean().default(false),
    /** Whether the adapter supports explicit fork. */
    supportsFork: z.boolean().default(false),
    /** Whether the adapter supports native-session resume. */
    supportsResume: z.boolean().default(false),
    /** Whether the adapter supports thinking/extended-reasoning. */
    supportsThinking: z.boolean().default(false),
    /** Whether the adapter supports forking a native session. */
    supportsForkSession: z.boolean().default(false),
    /** Max output tokens (best-effort). */
    maxOutputTokens: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type AdapterDescribe = z.infer<typeof adapterDescribeSchema>;

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

/**
 * The adapter's handle on a provider-native session, persisted by the
 * sessions layer so a later run can decide whether resuming that native
 * session is safe (same harness / runtime / workspace) or must start
 * fresh (PR8).
 */
export const nativeSessionBindingSchema = z
  .object({
    harness: z.string().trim().min(1).max(64),
    nativeSessionId: z.string().trim().min(1).max(512),
    driver: z.string().trim().min(1).max(64).optional(),
    runtime: z
      .object({
        kind: z.string().trim().min(1).max(64),
        instanceId: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
    workspace: z
      .object({
        id: z.string().trim().min(1).max(256).optional(),
        cwd: z.string().trim().min(1).max(8_192),
      })
      .strict()
      .optional(),
    nativeVersion: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type NativeSessionBinding = z.infer<typeof nativeSessionBindingSchema>;

/** Internal native transport contract consumed by `HarnessController`. */
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
    sessionCodec: adapterSessionCodecSchema.optional(),
    // Optional native-session controls. Unsupported operations fail closed.
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

/** Run-bound harness surface: every operation belongs to one native session. */

export const harnessInteractionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: identifierSchema,
      kind: z.literal("question"),
      prompt: z.string().trim().min(1).max(8_192),
      options: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      kind: z.literal("permission"),
      toolName: z.string().trim().min(1).max(256),
      description: z.string().max(8_192).optional(),
      input: z.unknown().optional(),
    })
    .strict(),
]);
export type HarnessInteraction = z.infer<typeof harnessInteractionSchema>;

export const harnessInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), answer: z.string().max(8_192) }).strict(),
  z
    .object({ kind: z.literal("permission"), response: z.enum(["once", "always", "reject"]) })
    .strict(),
]);
export type HarnessInteractionResponse = z.infer<typeof harnessInteractionResponseSchema>;

export const harnessRunResultSchema = z
  .object({
    status: z.enum(["completed", "failed", "cancelled", "timed_out", "lost"]),
    exitCode: z.number().int().nullable().optional(),
    usage: usageSummarySchema.optional(),
    error: z.string().max(8_192).optional(),
  })
  .strict();
export type HarnessRunResult = z.infer<typeof harnessRunResultSchema>;

export const harnessRunSnapshotSchema = z
  .object({
    protocolVersion: z.literal(HARNESS_PROTOCOL_VERSION),
    executionId: identifierSchema,
    revision: nonNegativeIntegerSchema,
    state: z.enum([
      "created",
      "starting",
      "recovering",
      "running",
      "waiting_for_interaction",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "lost",
    ]),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    runtimeBinding: jsonObjectSchema.optional(),
    nativeSessionBinding: nativeSessionBindingSchema.optional(),
    pendingInteractions: z.array(harnessInteractionSchema).max(128),
    result: harnessRunResultSchema.optional(),
    error: z.string().max(8_192).optional(),
  })
  .strict();
export type HarnessRunSnapshot = z.infer<typeof harnessRunSnapshotSchema>;

export interface HarnessEventV2 {
  protocolVersion: typeof HARNESS_PROTOCOL_VERSION;
  executionId: string;
  sequence: number;
  timestamp: string;
  adapter: string;
  nativeSessionId?: string;
  payload: HarnessEvent;
}

export interface HarnessAdapterRun {
  readonly executionId: string;
  readonly nativeSessionId?: string;
  events(): AsyncIterable<HarnessEventV2>;
  respond(interactionId: string, response: HarnessInteractionResponse): Promise<void>;
  abort(reason?: string): Promise<void>;
  fork?(fromMessageId?: string): Promise<HarnessAdapterRun>;
  wait(): Promise<HarnessRunResult>;
  close(): Promise<void>;
}

export interface HarnessAdapter<TConfig = unknown> {
  readonly manifest: {
    type: string;
    label: string;
    version: number;
    status: "ready" | "experimental" | "disabled";
    capabilities: Record<string, boolean>;
  };
  validateConfig(
    input: unknown,
  ): Promise<{ ok: true; config: TConfig } | { ok: false; errors: string[] }>;
  probe(ctx: { config: TConfig; runtime?: unknown }): Promise<{ ok: boolean; error?: string }>;
  start(ctx: {
    config: TConfig;
    runtime: unknown;
    executionId: string;
  }): Promise<HarnessAdapterRun>;
  recover?(ctx: {
    config: TConfig;
    runtime: unknown;
    executionId: string;
    nativeSessionId: string;
  }): Promise<HarnessAdapterRun | null>;
}
