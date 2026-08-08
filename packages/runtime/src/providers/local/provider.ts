import { runtimeError, UnsupportedDispositionError } from "../../core/contracts/errors.js";
import type {
  RuntimeExecutionResult,
  RuntimeProcessHandle,
} from "../../core/contracts/execution.js";
import type {
  RuntimeAcquireContext,
  RuntimeClock,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeProbeResult,
  RuntimeProvider,
  RuntimeReleaseContext,
  RuntimeResumeContext,
  RuntimeResumeResult,
  RuntimeStartExecutionContext,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "../../core/contracts/index.js";
import { LocalFilesystem } from "../../core/filesystem/local-filesystem.js";
import { startLocalProcess } from "../../core/process/local-process.js";
import { type LocalProviderConfig, localConfigSchema } from "./config.js";
import { localManifest } from "./manifest.js";

const LEASE_ID = "local";

export interface LocalProviderOptions {
  clock?: RuntimeClock;
}

/**
 * Local runtime provider. Runs processes on the host and exposes the
 * host filesystem. Not a sandbox: `workspaceIsolation: false`. Used as
 * the reference non-isolated provider for the contract suite.
 */
export function createLocalProvider(
  config: LocalProviderConfig = {},
  options: LocalProviderOptions = {},
): RuntimeProvider<LocalProviderConfig> {
  const root = config.root ?? config.cwd ?? process.cwd();
  const now = () => (options.clock ?? { now: () => new Date() }).now().toISOString();

  return {
    manifest: localManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<LocalProviderConfig>> {
      try {
        const parsed = localConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid local config"],
        };
      }
    },

    async probe(): Promise<RuntimeProbeResult> {
      return { ok: true, summary: "local runtime ready" };
    },

    async acquireLease(ctx: RuntimeAcquireContext<LocalProviderConfig>): Promise<RuntimeLease> {
      const workspace = ctx.localPath ?? config.root ?? config.cwd ?? root;
      return {
        version: 1,
        provider: "local",
        providerLeaseId: LEASE_ID,
        reusable: false,
        createdAt: now(),
        metadata: { provider: "local", backend: "host", remoteCwd: workspace },
      };
    },

    async resumeLease(
      ctx: RuntimeResumeContext<LocalProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      // Local has no persistent lease; a resumed lease always expires.
      void ctx;
      return { status: "expired", reason: "local runtime has no reusable lease" };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<LocalProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? ctx.localPath ?? root;
      const fs = new LocalFilesystem(cwd);
      await fs.mkdir(".");
      return { cwd, metadata: { provider: "local", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<LocalProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      return await startLocalProcess(
        {
          ...ctx.request,
          cwd: ctx.request.cwd ?? ctx.lease.metadata.remoteCwd ?? root,
        },
        { maxBufferBytes: ctx.config.maxBufferBytes },
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<LocalProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<LocalProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      if (ctx.disposition === "hibernate") {
        throw new UnsupportedDispositionError("hibernate", "local");
      }
      void ctx;
      return { disposition: ctx.disposition === "destroy" ? "destroyed" : "retained" };
    },

    async destroyLease(
      _ctx: RuntimeDestroyContext<LocalProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease) {
      const cwd = lease.metadata.remoteCwd ?? root;
      return new LocalFilesystem(cwd);
    },
    async exposeEndpoint(ctx) {
      const protocol = ctx.protocol ?? "http";
      const endpoint = `${protocol}://127.0.0.1:${ctx.port}`;
      return {
        url: endpoint,
        async refresh() {
          return this;
        },
        async close() {
          // Local endpoints are process-owned; the process handle closes them.
        },
      };
    },
  };
}

export function createLocalProviderFromConfig(
  input: unknown,
  options: LocalProviderOptions = {},
): Promise<RuntimeProvider<LocalProviderConfig>> {
  try {
    const parsed = localConfigSchema.parse(input ?? {});
    return Promise.resolve(createLocalProvider(parsed, options));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid local config",
      error,
    );
  }
}

export { LEASE_ID as LOCAL_LEASE_ID };
