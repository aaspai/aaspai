import { z } from "zod";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./primitives";

/**
 * Version of the runtime (execution target) contract.
 *
 * Bump when ExecutionTarget, SandboxSpec, or the runtime-side
 * callbacks change in a way that is not backward compatible.
 */
export const RUNTIME_PROTOCOL_VERSION = 1 as const;

/** All execution target kinds known to the foundation. */
export const EXECUTION_TARGET_KIND_VALUES = ["local", "docker", "ssh", "sandbox"] as const;
export const executionTargetKindSchema = z.enum(EXECUTION_TARGET_KIND_VALUES);
export type ExecutionTargetKind = z.infer<typeof executionTargetKindSchema>;

/** All sandbox provider keys known to the foundation. */
export const SANDBOX_PROVIDER_VALUES = [
  "e2b",
  "daytona",
  "cloudflare",
  "modal",
  "novita",
  "exe_dev",
  "kubernetes",
] as const;
export const sandboxProviderSchema = z.enum(SANDBOX_PROVIDER_VALUES);
export type SandboxProvider = z.infer<typeof sandboxProviderSchema>;

/** The shape returned by a process run. */
export const runProcessResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(32).optional(),
    timedOut: z.boolean().default(false),
    stdout: z
      .string()
      .max(16 * 1024 * 1024)
      .default(""),
    stderr: z
      .string()
      .max(16 * 1024 * 1024)
      .default(""),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema,
    durationMs: nonNegativeIntegerSchema,
    pid: positiveIntegerSchema.optional(),
  })
  .strict();
export type RunProcessResult = z.infer<typeof runProcessResultSchema>;

/** Options for running a process through any target. */
export const runProcessOptionsSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(256).default([]),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdin: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    signal: z
      .custom<AbortSignal>(
        (value) => value !== null && typeof value === "object" && "aborted" in value,
      )
      .optional(),
    timeoutMs: positiveIntegerSchema.optional(),
    onLog: z
      .custom<(stream: "stdout" | "stderr", chunk: string) => Promise<void> | void>(
        (v) => typeof v === "function",
      )
      .optional(),
    onSpawn: z
      .custom<(meta: { pid: number }) => Promise<void> | void>((v) => typeof v === "function")
      .optional(),
  })
  .strict();
export type RunProcessOptions = z.infer<typeof runProcessOptionsSchema>;

/** Local execution target — runs on the host. */
export const localExecutionTargetSchema = z
  .object({
    kind: z.literal("local"),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    envPassthrough: z.boolean().default(false),
  })
  .strict();
export type LocalExecutionTarget = z.infer<typeof localExecutionTargetSchema>;

/** Docker execution target — runs inside a container on the host. */
export const dockerExecutionTargetSchema = z
  .object({
    kind: z.literal("docker"),
    image: z.string().trim().min(1).max(512),
    cwd: z.string().trim().min(1).max(8_192).optional(),
    network: z.enum(["none", "bridge", "host"]).default("bridge"),
    memoryMb: positiveIntegerSchema.optional(),
    cpuShares: positiveIntegerSchema.optional(),
  })
  .strict();
export type DockerExecutionTarget = z.infer<typeof dockerExecutionTargetSchema>;

/** SSH execution target — runs on a remote host over SSH. */
export const sshExecutionTargetSchema = z
  .object({
    kind: z.literal("ssh"),
    host: z.string().trim().min(1).max(256),
    port: positiveIntegerSchema.default(22),
    username: z.string().trim().min(1).max(128),
    privateKey: z.string().min(1).max(32_768).optional(),
    password: z.string().min(1).max(1_024).optional(),
    remoteCwd: z.string().trim().min(1).max(8_192),
    strictHostKeyChecking: z.boolean().default(true),
    knownHosts: z.string().max(65_536).optional(),
    shellCommand: z.enum(["bash", "sh"]).default("bash"),
  })
  .strict();
export type SshExecutionTarget = z.infer<typeof sshExecutionTargetSchema>;

/** Cloud sandbox execution target — runs in a provider sandbox. */
export const sandboxExecutionTargetSchema = z
  .object({
    kind: z.literal("sandbox"),
    provider: sandboxProviderSchema,
    apiKey: z.string().min(1).max(2_048).optional(),
    template: z.string().trim().min(1).max(256).optional(),
    remoteCwd: z.string().trim().min(1).max(8_192),
    timeoutMs: positiveIntegerSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
export type SandboxExecutionTarget = z.infer<typeof sandboxExecutionTargetSchema>;

/** Discriminated union over all execution targets. */
export const executionTargetSchema = z.discriminatedUnion("kind", [
  localExecutionTargetSchema,
  dockerExecutionTargetSchema,
  sshExecutionTargetSchema,
  sandboxExecutionTargetSchema,
]);
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;

export const EXECUTION_TARGET_KINDS: Readonly<Record<ExecutionTargetKind, true>> = Object.freeze({
  local: true,
  docker: true,
  ssh: true,
  sandbox: true,
});

/** Saved spec for resuming a sandbox lease. */
export const sandboxSpecSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    provider: sandboxProviderSchema,
    providerLeaseId: z.string().trim().min(1).max(512),
    remoteCwd: z.string().trim().min(1).max(8_192),
    shellCommand: z.enum(["bash", "sh"]).default("bash"),
    apiKey: z.string().min(1).max(2_048).optional(),
    template: z.string().trim().min(1).max(256).optional(),
    metadata: jsonObjectSchema.optional(),
    acquiredAt: isoTimestampSchema,
  })
  .strict();
export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;

/** Static metadata describing a runtime driver for the host registry. */
export const runtimeTargetInfoSchema = z
  .object({
    kind: executionTargetKindSchema,
    provider: z.string().trim().min(1).max(64).optional(),
    label: z.string().trim().min(1).max(128),
    status: z.enum(["ready", "stub"]),
  })
  .strict();
export type RuntimeTargetInfo = z.infer<typeof runtimeTargetInfoSchema>;

/** The 6-method client every sandbox provider implements. */
export const sandboxClientSchema = z
  .object({
    makeDir: z.custom<(path: string, options?: { recursive?: boolean }) => Promise<void>>(
      (v) => typeof v === "function",
    ),
    writeFile: z.custom<(path: string, content: string | Uint8Array) => Promise<void>>(
      (v) => typeof v === "function",
    ),
    readFile: z.custom<(path: string) => Promise<Buffer>>((v) => typeof v === "function"),
    listFiles: z.custom<
      (path: string) => Promise<{ name: string; size: number; isDir: boolean }[]>
    >((v) => typeof v === "function"),
    remove: z.custom<(path: string, options?: { recursive?: boolean }) => Promise<void>>(
      (v) => typeof v === "function",
    ),
    run: z.custom<(options: RunProcessOptions) => Promise<RunProcessResult>>(
      (v) => typeof v === "function",
    ),
  })
  .strict();
export type SandboxClient = z.infer<typeof sandboxClientSchema>;

/** Progress phase. */
export const runtimeProgressPhaseSchema = z.enum([
  "git_sync",
  "config_sync",
  "adapter_startup",
  "restore",
  "export",
  "finalize",
  "upload",
  "download",
]);
export type RuntimeProgressPhase = z.infer<typeof runtimeProgressPhaseSchema>;

/** Progress update the host can render. */
export const runtimeProgressUpdateSchema = z
  .object({
    phase: runtimeProgressPhaseSchema,
    label: z.string().trim().min(1).max(256),
    direction: z.enum(["upload", "download", "none"]),
    transferredBytes: nonNegativeIntegerSchema,
    totalBytes: nonNegativeIntegerSchema.optional(),
    percent: z.number().min(0).max(100).optional(),
  })
  .strict();
export type RuntimeProgressUpdate = z.infer<typeof runtimeProgressUpdateSchema>;
