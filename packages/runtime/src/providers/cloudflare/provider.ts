import { randomUUID } from "node:crypto";
import { classifyError, runtimeError } from "../../core/contracts/errors.js";
import type {
  RuntimeExecutionIdentity,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "../../core/contracts/execution.js";
import type { RuntimeFilesystem } from "../../core/contracts/filesystem.js";
import type {
  RuntimeAcquireContext,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeProbeResult,
  RuntimeProcessHandle,
  RuntimeProvider,
  RuntimeProviderContext,
  RuntimeReleaseContext,
  RuntimeResumeContext,
  RuntimeResumeResult,
  RuntimeStartExecutionContext,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "../../core/contracts/index.js";
import { type CloudflareProviderConfig, cloudflareConfigSchema } from "./config.js";
import { cloudflareManifest } from "./manifest.js";

interface CloudflareBridgeClient {
  acquire(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ providerLeaseId: string; remoteCwd: string }>;
  resume(providerLeaseId: string): Promise<{ providerLeaseId: string } | null>;
  destroy(providerLeaseId: string): Promise<void>;
  run(input: {
    providerLeaseId: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
    stdin?: string;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
  fs(op: string, payload: Record<string, unknown>): Promise<unknown>;
}

/**
 * Cloudflare Workers bridge provider. The "sandbox" is a Durable Object
 * behind a Worker REST surface. Streaming/cancellation are not exposed
 * by the bridge, so both capabilities are false.
 */
export function createCloudflareProvider(
  config: CloudflareProviderConfig,
  options: {
    clientFactory?: (creds: {
      bridgeUrl: string;
      authToken?: string;
    }) => Promise<CloudflareBridgeClient>;
  } = {},
): RuntimeProvider<CloudflareProviderConfig> {
  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<CloudflareBridgeClient> => {
    const bridgeUrl =
      config.bridgeUrl?.trim() ||
      ctx.credentials?.bridgeUrl ||
      process.env.AASPAI_CF_BRIDGE_URL?.trim() ||
      "";
    const authToken =
      config.authToken?.trim() ||
      ctx.credentials?.authToken ||
      process.env.AASPAI_CF_BRIDGE_TOKEN?.trim() ||
      undefined;
    if (!bridgeUrl)
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "cloudflare sandbox requires a bridgeUrl or AASPAI_CF_BRIDGE_URL",
      );
    if (options.clientFactory) return await options.clientFactory({ bridgeUrl, authToken });
    const { createCloudflareBridgeClient } = await import("./client.js");
    return await createCloudflareBridgeClient({ bridgeUrl, authToken });
  };

  return {
    manifest: cloudflareManifest,

    async validateConfig(
      input: unknown,
    ): Promise<RuntimeValidationOutcome<CloudflareProviderConfig>> {
      try {
        const parsed = cloudflareConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid cloudflare config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<CloudflareProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const data = await client.acquire({ remoteCwd: "/workspace", timeoutMs: 60_000 });
        try {
          await client.run({
            providerLeaseId: data.providerLeaseId,
            command: "true",
            args: [],
            cwd: "/workspace",
          });
          return {
            ok: true,
            summary: "cloudflare bridge reachable",
            metadata: { provider: "cloudflare" },
          };
        } finally {
          await client.destroy(data.providerLeaseId).catch(() => undefined);
        }
      } catch (error) {
        return {
          ok: false,
          summary: "cloudflare probe failed",
          error: classifyError(error).message,
        };
      }
    },

    async acquireLease(
      ctx: RuntimeAcquireContext<CloudflareProviderConfig>,
    ): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      let data: { providerLeaseId: string; remoteCwd: string };
      try {
        data = await client.acquire({ remoteCwd: "/workspace" });
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `cloudflare acquire failed: ${classifyError(error).message}`,
          error,
        );
      }
      return {
        version: 1,
        provider: "cloudflare",
        providerLeaseId: data.providerLeaseId,
        reusable: true,
        createdAt: new Date().toISOString(),
        metadata: {
          provider: "cloudflare",
          backend: "cloudflare",
          remoteCwd: data.remoteCwd,
          nativeState: "running",
        },
      };
    },

    async resumeLease(
      ctx: RuntimeResumeContext<CloudflareProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      const client = await clientFor(ctx);
      const data = await client.resume(ctx.providerLeaseId).catch((error) => {
        if (/404|409|not found/i.test(classifyError(error).message)) return null;
        throw classifyError(error);
      });
      if (!data) return { status: "expired", reason: "lease not found on bridge" };
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? ctx.leaseMetadata.remoteCwd
          : "/workspace";
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "cloudflare",
          providerLeaseId: data.providerLeaseId,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "cloudflare",
            backend: "cloudflare",
            remoteCwd,
            nativeState: "running",
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<CloudflareProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor(ctx);
      if (ctx.lease.providerLeaseId) {
        await client.fs("mkdir", {
          path: ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace",
          recursive: true,
        });
      }
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace";
      return { cwd, metadata: { provider: "cloudflare", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<CloudflareProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId)
        throw runtimeError("EXECUTION_FAILED", "cloudflare lease has no providerLeaseId");
      return createCloudflareProcessHandle(
        client,
        leaseId,
        ctx.request,
        ctx.lease.metadata.remoteCwd ?? "/workspace",
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<CloudflareProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<CloudflareProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor(ctx);
      if (!ctx.lease.providerLeaseId)
        return { disposition: "destroyed", warnings: ["no provider lease id"] };
      if (ctx.disposition === "retain") return { disposition: "retained" };
      await client.destroy(ctx.lease.providerLeaseId).catch(() => undefined);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<CloudflareProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      await client.destroy(ctx.providerLeaseId).catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new CloudflareFilesystem({
        clientFor,
        leaseId: lease.providerLeaseId as string,
        credentials: ctx.credentials,
      });
    },
  };
}

function createCloudflareProcessHandle(
  client: CloudflareBridgeClient,
  leaseId: string,
  request: RuntimeExecutionRequest,
  remoteCwd: string,
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): RuntimeProcessHandle {
  const executionId = `exec_${randomUUID()}`;
  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "cloudflare",
    providerLeaseId: leaseId,
    nativeProcessId: leaseId,
  };
  const startedAt = new Date();
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  const waiters: Array<() => void> = [];
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

  const run = async (): Promise<void> => {
    try {
      const out = await client.run({
        providerLeaseId: leaseId,
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? remoteCwd,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.stdin !== undefined
          ? {
              stdin:
                typeof request.stdin === "string"
                  ? request.stdin
                  : new TextDecoder().decode(request.stdin),
            }
          : {}),
      });
      if (out.stdout) await hooks.onStdout?.(encode(out.stdout));
      if (out.stderr) await hooks.onStderr?.(encode(out.stderr));
      const finishedAt = new Date();
      result = {
        status: (out.exitCode ?? 0) === 0 ? "completed" : "failed",
        exitCode: out.exitCode,
        terminationReason: "exit",
        stdoutTail: encode(out.stdout.slice(-256 * 1024)),
        stderrTail: encode(out.stderr.slice(-256 * 1024)),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } catch (error) {
      const finishedAt = new Date();
      result = {
        status: "failed",
        exitCode: null,
        terminationReason: "provider_error",
        stdoutTail: new Uint8Array(),
        stderrTail: encode(`cloudflare execution failed: ${classifyError(error).message}\n`),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } finally {
      settled = true;
      for (const w of waiters) w();
    }
  };

  const runPromise = run();

  return {
    executionId,
    identity,
    async wait() {
      if (settled && result) return result;
      await new Promise<void>((resolve) => waiters.push(resolve));
      await runPromise;
      return result as RuntimeExecutionResult;
    },
    async cancel(_reason) {
      throw runtimeError("EXECUTION_CANCELLED", "cloudflare bridge does not support cancellation");
    },
  };
}

class CloudflareFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<CloudflareBridgeClient>;
      leaseId: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<CloudflareBridgeClient> {
    return await this.ctx.clientFor({ credentials: this.ctx.credentials });
  }

  async mkdir(p: string): Promise<void> {
    const client = await this.client();
    await client.fs("mkdir", { path: p, recursive: true });
  }

  async read(p: string): Promise<Uint8Array> {
    const client = await this.client();
    const data = (await client.fs("read", { path: p })) as { content?: string };
    return new TextEncoder().encode(data.content ?? "");
  }

  async write(p: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    await client.fs("write", { path: p, content: new TextDecoder().decode(content) });
  }

  async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    await client.fs("remove", { path: p, recursive: options?.recursive ?? true });
  }

  async list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const data = (await client.fs("list", { path: p })) as {
      entries?: { name: string; size: number; isDir: boolean }[];
    };
    return data.entries ?? [];
  }
}

export function createCloudflareProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<CloudflareProviderConfig>> {
  try {
    const parsed = cloudflareConfigSchema.parse(input ?? {});
    return Promise.resolve(createCloudflareProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid cloudflare config",
      error,
    );
  }
}
