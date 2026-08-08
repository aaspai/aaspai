/**
 * First-class process model. A runtime provider returns a process handle
 * from `startExecution`; the caller controls it and awaits its result.
 * One-shot `run()` is convenience syntax over start+wait.
 */

/** Breaking-version marker for the Runtime V2 contract surface. */
export const RUNTIME_V2_PROTOCOL_VERSION = 2 as const;

export interface RuntimeExecutionRequest {
  command: string;
  args: string[];
  /** Execute through a shell only when explicitly requested. */
  shell?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Whether the provider should merge the supplied environment with its
   * process environment. Providers must never implicitly copy credentials
   * into a lease; this flag only affects the short-lived child process.
   */
  inheritEnv?: boolean;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  graceMs?: number;
}

export interface RuntimeExecutionIdentity {
  executionId: string;
  provider: string;
  providerLeaseId: string | null;
  pid?: number;
  processGroupId?: number;
  nativeProcessId?: string;
}

export interface RuntimeExecutionHooks {
  onStdout?(chunk: Uint8Array): Promise<void> | void;
  onStderr?(chunk: Uint8Array): Promise<void> | void;
  onStarted?(identity: RuntimeExecutionIdentity): Promise<void> | void;
  onProgress?(update: RuntimeProgressUpdate): Promise<void> | void;
}

export interface RuntimeProgressUpdate {
  phase: RuntimeProgressPhase;
  label: string;
  direction: "upload" | "download" | "none";
  transferredBytes: number;
  totalBytes?: number;
  percent?: number;
}

export type RuntimeProgressPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "upload"
  | "download";

export type RuntimeExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out";

export type RuntimeTerminationReason =
  | "exit"
  | "cancelled"
  | "timeout"
  | "signal"
  | "spawn_error"
  | "provider_error";

export interface RuntimeExecutionResult {
  status: RuntimeExecutionStatus;
  exitCode: number | null;
  signal?: string;
  terminationReason: RuntimeTerminationReason;
  stdoutTail?: Uint8Array;
  stderrTail?: Uint8Array;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  identity: RuntimeExecutionIdentity;
}

export interface RuntimeProcessHandle {
  readonly executionId: string;
  readonly identity: RuntimeExecutionIdentity;
  wait(): Promise<RuntimeExecutionResult>;
  cancel(reason?: string): Promise<void>;
  signal?(signal: RuntimeSignal): Promise<void>;
  writeStdin?(data: string | Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
}

/** Durable identity required to reconstruct a provider process after a worker restart. */
export interface RuntimeExecutionBinding {
  provider: string;
  providerLeaseId: string | null;
  nativeProcessId?: string;
  metadata?: Record<string, unknown>;
}

export type RuntimeSignal =
  | "SIGTERM"
  | "SIGKILL"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGHUP"
  | "SIGSTOP"
  | "SIGCONT";
