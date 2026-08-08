import type {
  RuntimeExecutionBinding,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeProcessHandle,
} from "./execution.js";
import type { RuntimeFilesystem } from "./filesystem.js";
import type {
  RuntimeCredentialSet,
  RuntimeLease,
  RuntimeLogger,
  RuntimeProbeResult,
  RuntimeProviderManifest,
  RuntimeReleaseDisposition,
  RuntimeReleaseResult,
  RuntimeResumeResult,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
} from "./lease.js";
import type { RuntimeProfile } from "./profile.js";

export interface RuntimeProviderContext {
  logger: RuntimeLogger;
  credentials: RuntimeCredentialSet;
  clock?: { now(): Date };
  trace?: { executionId?: string; sessionId?: string };
}

/** Private service endpoint with ephemeral credentials and refresh semantics. */
export interface RuntimeEndpointHandle {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly expiresAt?: string;
  refresh(): Promise<RuntimeEndpointHandle>;
  close(): Promise<void>;
}

export interface RuntimeAcquireContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  /** Opaque identifiers for labeling/naming; the provider makes no business decisions from them. */
  labels?: Record<string, string>;
  profile?: RuntimeProfile;
  /** Local workspace path the provider may bind-mount / seed during provisioning. */
  localPath?: string;
}

export interface RuntimeResumeContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  providerLeaseId: string;
  leaseMetadata?: Record<string, unknown>;
  profile?: RuntimeProfile;
}

export interface RuntimeWorkspaceContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  lease: RuntimeLease;
  /** Local workspace path the provider may use to seed remote cwd. */
  localPath?: string;
  remotePath?: string;
}

export interface RuntimeStartExecutionContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  lease: RuntimeLease;
  request: RuntimeExecutionRequest;
  /** Optional durable identity used when a provider reattaches after restart. */
  executionBinding?: RuntimeExecutionBinding;
  onStdout?: (chunk: Uint8Array) => Promise<void> | void;
  onStderr?: (chunk: Uint8Array) => Promise<void> | void;
}

export interface RuntimeReleaseContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  lease: RuntimeLease;
  disposition: RuntimeReleaseDisposition;
}

export interface RuntimeDestroyContext<TConfig> extends RuntimeProviderContext {
  config: TConfig;
  providerLeaseId: string;
  leaseMetadata?: Record<string, unknown>;
}

/**
 * The single V2 provider contract. Stateless lease lifecycle: the
 * platform above persists `providerLeaseId` + `metadata` and calls these
 * methods; no in-memory SDK object is ever required for correctness.
 */
export interface RuntimeProvider<TConfig = unknown> {
  readonly manifest: RuntimeProviderManifest;

  validateConfig(input: unknown): Promise<RuntimeValidationOutcome<TConfig>>;

  probe(ctx: RuntimeAcquireContext<TConfig>): Promise<RuntimeProbeResult>;

  acquireLease(ctx: RuntimeAcquireContext<TConfig>): Promise<RuntimeLease>;

  resumeLease(ctx: RuntimeResumeContext<TConfig>): Promise<RuntimeResumeResult>;

  realizeWorkspace(ctx: RuntimeWorkspaceContext<TConfig>): Promise<RuntimeWorkspace>;

  startExecution(ctx: RuntimeStartExecutionContext<TConfig>): Promise<RuntimeProcessHandle>;

  /** Reconstruct a previously-started provider process when supported. */
  reattachExecution?(ctx: RuntimeStartExecutionContext<TConfig>): Promise<RuntimeProcessHandle>;

  /**
   * One-shot convenience over `startExecution().wait()`. Providers may
   * override for efficiency; the default composes the handle contract.
   */
  execute?(ctx: RuntimeStartExecutionContext<TConfig>): Promise<RuntimeExecutionResult>;

  releaseLease(ctx: RuntimeReleaseContext<TConfig>): Promise<RuntimeReleaseResult>;

  destroyLease(
    ctx: RuntimeDestroyContext<TConfig>,
  ): Promise<{ destroyed: boolean; warnings?: string[] }>;

  filesystem?(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem;
  exposeEndpoint?(
    ctx: {
      config: TConfig;
      lease: RuntimeLease;
      port: number;
      protocol?: "http" | "https" | "tcp";
    } & RuntimeProviderContext,
  ): Promise<RuntimeEndpointHandle>;
}
