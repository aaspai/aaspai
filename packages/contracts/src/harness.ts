import { z } from "zod";
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
  })
  .strict();
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;

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
