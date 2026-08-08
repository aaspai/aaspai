import type {
  RuntimeExecutionBinding,
  RuntimeExecutionResult,
  RuntimeProcessHandle,
} from "./contracts/execution.js";
import type {
  RuntimeAcquireContext,
  RuntimeCredentialSet,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeLogger,
  RuntimeProvider,
  RuntimeProviderContext,
  RuntimeReleaseContext,
  RuntimeReleaseResult,
  RuntimeResumeContext,
  RuntimeStartExecutionContext,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "./contracts/index.js";

const defaultLogger: RuntimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Stateless convenience façade over a V2 provider. It deliberately stores no
 * lease, session, database, or reuse policy; callers pass the lease back to
 * every operation so serialized lifecycle state remains authoritative.
 */
export class RuntimeController<TConfig = unknown> {
  readonly provider: RuntimeProvider<TConfig>;
  readonly credentials: RuntimeCredentialSet;
  readonly logger: RuntimeLogger;
  readonly clock: { now(): Date };

  constructor(options: {
    provider: RuntimeProvider<TConfig>;
    credentials?: RuntimeCredentialSet;
    logger?: RuntimeLogger;
    clock?: { now(): Date };
  }) {
    this.provider = options.provider;
    this.credentials = options.credentials ?? {};
    this.logger = options.logger ?? defaultLogger;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  validateConfig(input: unknown) {
    return this.provider.validateConfig(input);
  }

  probe(config: TConfig, labels?: Record<string, string>) {
    return this.provider.probe(this.context<RuntimeAcquireContext<TConfig>>({ config, labels }));
  }

  acquire(
    config: TConfig,
    options: Omit<
      RuntimeAcquireContext<TConfig>,
      "config" | "credentials" | "logger" | "clock"
    > = {},
  ) {
    return this.provider.acquireLease(
      this.context<RuntimeAcquireContext<TConfig>>({ ...options, config }),
    );
  }

  resume(config: TConfig, providerLeaseId: string, leaseMetadata?: Record<string, unknown>) {
    return this.provider.resumeLease(
      this.context<RuntimeResumeContext<TConfig>>({ config, providerLeaseId, leaseMetadata }),
    );
  }

  realize(
    config: TConfig,
    lease: RuntimeLease,
    options: Omit<
      RuntimeWorkspaceContext<TConfig>,
      "config" | "lease" | "credentials" | "logger" | "clock"
    > = {},
  ): Promise<RuntimeWorkspace> {
    return this.provider.realizeWorkspace(
      this.context<RuntimeWorkspaceContext<TConfig>>({ ...options, config, lease }),
    );
  }

  start(
    config: TConfig,
    lease: RuntimeLease,
    request: RuntimeStartExecutionContext<TConfig>["request"],
    options: Omit<
      RuntimeStartExecutionContext<TConfig>,
      "config" | "lease" | "request" | "credentials" | "logger" | "clock"
    > = {},
  ): Promise<RuntimeProcessHandle> {
    return this.provider.startExecution(
      this.context<RuntimeStartExecutionContext<TConfig>>({ ...options, config, lease, request }),
    );
  }

  reattach(
    config: TConfig,
    lease: RuntimeLease,
    request: RuntimeStartExecutionContext<TConfig>["request"],
    executionBinding: RuntimeExecutionBinding,
    options: Omit<
      RuntimeStartExecutionContext<TConfig>,
      "config" | "lease" | "request" | "executionBinding" | "credentials" | "logger" | "clock"
    > = {},
  ): Promise<RuntimeProcessHandle> {
    if (!this.provider.reattachExecution) {
      throw new Error(`runtime provider ${this.provider.manifest.type} cannot reattach processes`);
    }
    return this.provider.reattachExecution(
      this.context<RuntimeStartExecutionContext<TConfig>>({
        ...options,
        config,
        lease,
        request,
        executionBinding,
      }),
    );
  }

  async execute(
    config: TConfig,
    lease: RuntimeLease,
    request: RuntimeStartExecutionContext<TConfig>["request"],
    options: Omit<
      RuntimeStartExecutionContext<TConfig>,
      "config" | "lease" | "request" | "credentials" | "logger" | "clock"
    > = {},
  ): Promise<RuntimeExecutionResult> {
    const handle = await this.start(config, lease, request, options);
    return await handle.wait();
  }

  filesystem(lease: RuntimeLease) {
    if (!this.provider.filesystem) throw new Error("runtime provider does not expose a filesystem");
    return this.provider.filesystem(lease, this.context<RuntimeProviderContext>({}));
  }

  exposeEndpoint(
    config: TConfig,
    lease: RuntimeLease,
    port: number,
    protocol?: "http" | "https" | "tcp",
  ) {
    if (!this.provider.exposeEndpoint)
      throw new Error("runtime provider does not expose private endpoints");
    return this.provider.exposeEndpoint(
      this.context({ config, lease, port, ...(protocol ? { protocol } : {}) }),
    );
  }

  release(
    config: TConfig,
    lease: RuntimeLease,
    disposition: RuntimeReleaseContext<TConfig>["disposition"],
  ): Promise<RuntimeReleaseResult> {
    return this.provider.releaseLease(
      this.context<RuntimeReleaseContext<TConfig>>({ config, lease, disposition }),
    );
  }

  destroy(config: TConfig, providerLeaseId: string, leaseMetadata?: Record<string, unknown>) {
    return this.provider.destroyLease(
      this.context<RuntimeDestroyContext<TConfig>>({ config, providerLeaseId, leaseMetadata }),
    );
  }

  private context<T extends { credentials: RuntimeCredentialSet; logger: RuntimeLogger }>(
    input: Omit<T, "credentials" | "logger">,
  ): T {
    return {
      ...input,
      credentials: this.credentials,
      logger: this.logger,
      clock: this.clock,
    } as unknown as T;
  }
}
