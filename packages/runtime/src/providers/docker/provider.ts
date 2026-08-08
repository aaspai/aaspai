import { randomUUID } from "node:crypto";
import { runtimeError } from "../../core/contracts/errors.js";
import type { RuntimeExecutionResult } from "../../core/contracts/execution.js";
import type {
  RuntimeAcquireContext,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeProbeResult,
  RuntimeProcessHandle,
  RuntimeProvider,
  RuntimeReleaseContext,
  RuntimeResumeContext,
  RuntimeResumeResult,
  RuntimeStartExecutionContext,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "../../core/contracts/index.js";
import { runLocalProcess, startLocalProcess } from "../../core/process/local-process.js";
import { type DockerProviderConfig, dockerConfigSchema } from "./config.js";
import { DockerFilesystem } from "./filesystem.js";
import { dockerManifest } from "./manifest.js";

interface DockerCommandInput {
  args?: string[];
  stdin?: string;
  timeoutMs?: number;
}

/**
 * Docker V2 provider. Disposable container per lease; the host workspace
 * is bind-mounted at /workspace. Ephemeral (no resume/hibernate yet);
 * `releaseLease` always destroys the container. `destroyLease` works by
 * container id after a worker restart.
 */
export function createDockerProvider(
  config: DockerProviderConfig,
  options: {
    commandRunner?: (
      input: DockerCommandInput,
    ) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  } = {},
): RuntimeProvider<DockerProviderConfig> {
  const command = config.command ?? "docker";
  const cleanupRetries = Math.max(1, config.cleanupRetries ?? 3);
  const network = config.network ?? "bridge";

  const docker = async (args: string[], input: DockerCommandInput = {}): Promise<string> => {
    if (options.commandRunner) {
      const result = await options.commandRunner({
        args: [...args, ...(input.args ?? [])],
        stdin: input.stdin,
        timeoutMs: input.timeoutMs,
      });
      if ((result.exitCode ?? 1) !== 0) {
        throw runtimeError(
          "PROVISION_FAILED",
          `docker ${args[0]} failed: ${result.stderr || result.stdout}`,
        );
      }
      return result.stdout;
    }
    const result = await runLocalProcess({
      command,
      args: [...args, ...(input.args ?? [])],
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw runtimeError(
        "PROVISION_FAILED",
        `docker ${args[0]} failed: ${bytesText(result.stderrTail)}${bytesText(result.stdoutTail)}`,
      );
    }
    return bytesText(result.stdoutTail);
  };

  const provision = async (
    ctx: RuntimeAcquireContext<DockerProviderConfig>,
    workspacePath: string,
    signal?: { aborted: boolean },
  ) => {
    const image = ctx.profile?.image ?? config.defaultImage;
    const args = [
      "create",
      "--init",
      "--network",
      network,
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace`,
      "--workdir",
      "/workspace",
    ];
    if (config.memoryMb !== undefined) args.push("--memory", `${config.memoryMb}m`);
    if (config.cpuShares !== undefined) args.push("--cpu-shares", String(config.cpuShares));
    args.push(image, "tail", "-f", "/dev/null");
    const created = await docker(args, {});
    const containerId = created.trim().split(/\s+/)[0];
    if (!containerId)
      throw runtimeError("PROVISION_FAILED", "docker create returned no container id");
    await docker(["start", containerId]);
    void signal;
    return containerId;
  };

  return {
    manifest: dockerManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<DockerProviderConfig>> {
      try {
        const parsed = dockerConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid docker config"],
        };
      }
    },

    async probe(): Promise<RuntimeProbeResult> {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"]);
        return { ok: true, summary: "docker daemon reachable" };
      } catch (error) {
        return {
          ok: false,
          summary: "docker daemon unreachable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<DockerProviderConfig>): Promise<RuntimeLease> {
      const workspacePath = ctx.localPath ?? process.cwd();
      const containerId = await provision(ctx, workspacePath);
      const leaseId = `docker-${randomUUID().slice(0, 8)}`;
      return {
        version: 1,
        provider: "docker",
        providerLeaseId: leaseId,
        reusable: false,
        createdAt: new Date().toISOString(),
        metadata: {
          provider: "docker",
          backend: "docker",
          containerId,
          image: ctx.profile?.image ?? config.defaultImage,
          remoteCwd: "/workspace",
          nativeState: "running",
        },
      };
    },

    async resumeLease(
      ctx: RuntimeResumeContext<DockerProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      // Ephemeral provider: containers are disposable; a persisted lease is expired.
      void ctx;
      return { status: "expired", reason: "docker provider leases are ephemeral" };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<DockerProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const lease = ctx.lease;
      const containerId = String(lease.metadata.containerId ?? "");
      if (!containerId) throw runtimeError("WORKSPACE_FAILED", "docker lease has no container id");
      await docker(["exec", containerId, "mkdir", "-p", "/workspace"]);
      return {
        cwd: "/workspace",
        metadata: { provider: "docker", cwd: "/workspace", containerId },
      };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<DockerProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const containerId = String(ctx.lease.metadata.containerId ?? "");
      if (!containerId) throw runtimeError("EXECUTION_FAILED", "docker lease has no container id");
      const envArgs = Object.entries(ctx.request.env ?? {}).flatMap(([k, v]) => [
        "--env",
        `${k}=${v}`,
      ]);
      return await startDockerProcess(
        command,
        {
          args: [
            "exec",
            "--workdir",
            ctx.request.cwd ?? "/workspace",
            ...envArgs,
            containerId,
            ctx.request.command,
            ...ctx.request.args,
          ],
          ...(ctx.request.stdin !== undefined
            ? {
                stdin:
                  typeof ctx.request.stdin === "string"
                    ? ctx.request.stdin
                    : new TextDecoder().decode(ctx.request.stdin),
              }
            : {}),
          ...(ctx.request.timeoutMs !== undefined ? { timeoutMs: ctx.request.timeoutMs } : {}),
        },
        { onStdout: ctx.onStdout, onStderr: ctx.onStderr },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<DockerProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<DockerProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      if (ctx.disposition !== "destroy") {
        // Docker V2 is ephemeral; anything other than destroy means destroy.
        await destroyContainer(ctx.lease.metadata.containerId);
        return {
          disposition: "destroyed",
          fallbackUsed: true,
          warnings: ["docker provider is ephemeral; lease destroyed"],
        };
      }
      await destroyContainer(ctx.lease.metadata.containerId);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<DockerProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const containerId = ctx.leaseMetadata?.containerId ?? ctx.providerLeaseId;
      if (!containerId)
        return { destroyed: false, warnings: ["no container id in lease metadata"] };
      await destroyContainer(String(containerId));
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease) {
      const containerId = String(lease.metadata.containerId ?? "");
      return new DockerFilesystem(command, containerId);
    },
  };

  async function destroyContainer(containerId: unknown): Promise<void> {
    if (!containerId) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= cleanupRetries; attempt += 1) {
      try {
        await docker(["rm", "--force", "--volumes", String(containerId)]);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < cleanupRetries) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }
    throw runtimeError(
      "DESTROY_FAILED",
      `failed to remove docker container ${containerId}`,
      lastError,
    );
  }
}

async function startDockerProcess(
  command: string,
  run: { args: string[]; stdin?: string; timeoutMs?: number },
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): Promise<RuntimeProcessHandle> {
  return await startLocalProcess(
    {
      command,
      args: run.args,
      ...(run.stdin !== undefined ? { stdin: run.stdin } : {}),
      ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
    },
    {},
    hooks,
  );
}

function bytesText(bytes?: Uint8Array): string {
  if (!bytes || bytes.byteLength === 0) return "";
  return new TextDecoder().decode(bytes);
}

export function createDockerProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<DockerProviderConfig>> {
  try {
    const parsed = dockerConfigSchema.parse(input ?? {});
    return Promise.resolve(createDockerProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid docker config",
      error,
    );
  }
}
