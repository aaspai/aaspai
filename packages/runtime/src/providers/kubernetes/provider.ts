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
import { shellQuote } from "../../core/shell/quote.js";
import { type KubernetesProviderConfig, kubernetesConfigSchema } from "./config.js";
import { kubernetesManifest } from "./manifest.js";

interface KubeClientSurface {
  create(input: {
    name: string;
    namespace: string;
    image: string;
    workingDir: string;
  }): Promise<{ podName: string; namespace: string }>;
  get(name: string, namespace: string): Promise<{ podName: string; namespace: string } | null>;
  destroy(name: string, namespace: string): Promise<void>;
  exec(input: {
    podName: string;
    namespace: string;
    command: string;
    args: string[];
    stdin?: string;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export function createKubernetesProvider(
  config: KubernetesProviderConfig,
  options: {
    clientFactory?: (config: KubernetesProviderConfig) => Promise<KubeClientSurface>;
  } = {},
): RuntimeProvider<KubernetesProviderConfig> {
  const clientFor = async (): Promise<KubeClientSurface> => {
    if (options.clientFactory) return await options.clientFactory(config);
    const { createKubectlClient } = await import("./client.js");
    return await createKubectlClient(config);
  };

  return {
    manifest: kubernetesManifest,

    async validateConfig(
      input: unknown,
    ): Promise<RuntimeValidationOutcome<KubernetesProviderConfig>> {
      try {
        const parsed = kubernetesConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid kubernetes config"],
        };
      }
    },

    async probe(): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor();
        void client;
        return { ok: true, summary: "kubectl available" };
      } catch (error) {
        return {
          ok: false,
          summary: "kubernetes probe failed",
          error: classifyError(error).message,
        };
      }
    },

    async acquireLease(
      ctx: RuntimeAcquireContext<KubernetesProviderConfig>,
    ): Promise<RuntimeLease> {
      const client = await clientFor();
      const podName = `aaspai-${randomUUID().slice(0, 8).toLowerCase()}`;
      const namespace = ctx.config?.namespace ?? config.namespace ?? "default";
      const image = ctx.profile?.image ?? config.image ?? "alpine:3.20";
      try {
        await client.create({ name: podName, namespace, image, workingDir: "/workspace" });
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `kubernetes pod create failed: ${classifyError(error).message}`,
          error,
        );
      }
      const remoteCwd = "/workspace";
      return {
        version: 1,
        provider: "kubernetes",
        providerLeaseId: podName,
        reusable: true,
        createdAt: new Date().toISOString(),
        metadata: {
          provider: "kubernetes",
          backend: "kubernetes",
          namespace,
          podName,
          image,
          remoteCwd,
          nativeState: "running",
        },
      };
    },

    async resumeLease(
      ctx: RuntimeResumeContext<KubernetesProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      const client = await clientFor();
      const namespace = String(ctx.leaseMetadata?.namespace ?? config.namespace ?? "default");
      const pod = await client.get(ctx.providerLeaseId, namespace).catch(() => null);
      if (!pod) return { status: "expired", reason: "pod not found" };
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? ctx.leaseMetadata.remoteCwd
          : "/workspace";
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "kubernetes",
          providerLeaseId: pod.podName,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "kubernetes",
            backend: "kubernetes",
            namespace,
            podName: pod.podName,
            remoteCwd,
            nativeState: "running",
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<KubernetesProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor();
      if (ctx.lease.providerLeaseId) {
        await client.exec({
          podName: ctx.lease.providerLeaseId,
          namespace: String(ctx.lease.metadata.namespace ?? "default"),
          command: "mkdir",
          args: ["-p", ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace"],
        });
      }
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace";
      return { cwd, metadata: { provider: "kubernetes", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<KubernetesProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor();
      const podName = ctx.lease.providerLeaseId;
      if (!podName) throw runtimeError("EXECUTION_FAILED", "kubernetes lease has no pod name");
      const namespace = String(ctx.lease.metadata.namespace ?? "default");
      return createKubeProcessHandle(
        client,
        podName,
        namespace,
        ctx.request,
        ctx.lease.metadata.remoteCwd ?? "/workspace",
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<KubernetesProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<KubernetesProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor();
      if (!ctx.lease.providerLeaseId)
        return { disposition: "destroyed", warnings: ["no pod name"] };
      if (ctx.disposition === "retain") return { disposition: "retained" };
      await client
        .destroy(
          ctx.lease.providerLeaseId,
          String(ctx.lease.metadata.namespace ?? config.namespace ?? "default"),
        )
        .catch(() => undefined);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<KubernetesProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor();
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no pod name"] };
      await client
        .destroy(
          ctx.providerLeaseId,
          String(ctx.leaseMetadata?.namespace ?? config.namespace ?? "default"),
        )
        .catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, _ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new KubeFilesystem({
        clientFor,
        podName: lease.providerLeaseId as string,
        namespace: String(lease.metadata.namespace ?? "default"),
      });
    },
  };
}

function createKubeProcessHandle(
  client: KubeClientSurface,
  podName: string,
  namespace: string,
  request: RuntimeExecutionRequest,
  _remoteCwd: string,
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): RuntimeProcessHandle {
  const executionId = `exec_${randomUUID()}`;
  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "kubernetes",
    providerLeaseId: podName,
    nativeProcessId: podName,
  };
  const startedAt = new Date();
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  const waiters: Array<() => void> = [];
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

  const run = async (): Promise<void> => {
    try {
      const out = await client.exec({
        podName,
        namespace,
        command: request.command,
        args: request.args,
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
        stderrTail: encode(`kubernetes execution failed: ${classifyError(error).message}\n`),
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
      await client
        .exec({
          podName,
          namespace,
          command: "sh",
          args: ["-c", "pkill -TERM 2>/dev/null || true"],
        })
        .catch(() => undefined);
    },
  };
}

class KubeFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: () => Promise<KubeClientSurface>;
      podName: string;
      namespace: string;
    },
  ) {}

  private async client(): Promise<KubeClientSurface> {
    return await this.ctx.clientFor();
  }

  async mkdir(p: string): Promise<void> {
    const client = await this.client();
    await client.exec({
      podName: this.ctx.podName,
      namespace: this.ctx.namespace,
      command: "mkdir",
      args: ["-p", p],
    });
  }

  async read(p: string): Promise<Uint8Array> {
    const client = await this.client();
    const r = await client.exec({
      podName: this.ctx.podName,
      namespace: this.ctx.namespace,
      command: "cat",
      args: [p],
    });
    return new TextEncoder().encode(r.stdout);
  }

  async write(p: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    const text = new TextDecoder().decode(content);
    await client.exec({
      podName: this.ctx.podName,
      namespace: this.ctx.namespace,
      command: "sh",
      args: [
        "-c",
        `mkdir -p ${shellQuote(p.split("/").slice(0, -1).join("/") || ".")} && cat > ${shellQuote(p)}`,
      ],
      stdin: text,
    });
  }

  async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    await client.exec({
      podName: this.ctx.podName,
      namespace: this.ctx.namespace,
      command: "rm",
      args: [options?.recursive === false ? "-f" : "-rf", p],
    });
  }

  async list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const r = await client.exec({
      podName: this.ctx.podName,
      namespace: this.ctx.namespace,
      command: "sh",
      args: ["-c", `cd ${shellQuote(p)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`],
    });
    return r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const [name, sizeStr, typeChar] = line.split("|");
        return {
          name: name ?? "",
          size: Number.parseInt(sizeStr ?? "0", 10),
          isDir: typeChar === "d",
        };
      });
  }
}

export function createKubernetesProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<KubernetesProviderConfig>> {
  try {
    const parsed = kubernetesConfigSchema.parse(input ?? {});
    return Promise.resolve(createKubernetesProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid kubernetes config",
      error,
    );
  }
}
