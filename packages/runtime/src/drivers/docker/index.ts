import type {
  DockerExecutionTarget,
  RunProcessOptions,
  RunProcessResult,
} from "@aaspai/contracts/runtime";
import { runProcess } from "@aaspai/harness";
import type { RuntimeTarget } from "../../shared/execution-target.js";

export type DockerLifecyclePhase =
  | "provision"
  | "ready"
  | "execute"
  | "finalize"
  | "release"
  | "recover";

export interface DockerLifecycleEvent {
  phase: DockerLifecyclePhase;
  containerId: string;
  message: string;
}

export interface DockerCommandRunner {
  run(options: RunProcessOptions): Promise<RunProcessResult>;
}

export interface DockerEnvironmentLease {
  containerId: string;
  workspacePath: string;
  remoteCwd: string;
  createdAt: string;
}

export interface DockerEnvironmentProviderOptions {
  commandRunner?: DockerCommandRunner;
  onEvent?: (event: DockerLifecycleEvent) => Promise<void> | void;
  command?: string;
  cleanupRetries?: number;
}

export interface DockerEnvironmentProvider {
  provision(
    target: DockerExecutionTarget,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<DockerEnvironmentLease>;
  prepare(lease: DockerEnvironmentLease): Promise<void>;
  execute(
    lease: DockerEnvironmentLease,
    target: DockerExecutionTarget,
    options: RunProcessOptions,
  ): Promise<RunProcessResult>;
  finalize(lease: DockerEnvironmentLease): Promise<void>;
  release(lease: DockerEnvironmentLease): Promise<void>;
  recover(containerId: string): Promise<"running" | "exited" | "missing">;
}

const DEFAULT_REMOTE_CWD = "/workspace";

/**
 * Docker is the first complete isolated provider. The host workspace is the
 * persistence boundary; the container is disposable and never owns git
 * history. This also keeps the provider usable on Windows.
 */
export function createDockerEnvironmentProvider(
  options: DockerEnvironmentProviderOptions = {},
): DockerEnvironmentProvider {
  const commandRunner = options.commandRunner ?? { run: runProcess };
  const command = options.command ?? "docker";
  const cleanupRetries = Math.max(1, options.cleanupRetries ?? 3);
  const emit = async (event: DockerLifecycleEvent): Promise<void> => {
    await options.onEvent?.(event);
  };

  const docker = async (
    args: readonly string[],
    runOptions: Omit<RunProcessOptions, "command" | "args"> = {},
  ): Promise<RunProcessResult> => {
    const result = await commandRunner.run({ command, args: [...args], ...runOptions });
    if (result.exitCode !== 0 || result.signal || result.timedOut) {
      throw new DockerRuntimeError(args[0] ?? "command", result.stderr || result.stdout);
    }
    return result;
  };

  const provider: DockerEnvironmentProvider = {
    async provision(target, workspacePath, signal) {
      const remoteCwd = target.remoteCwd ?? DEFAULT_REMOTE_CWD;
      const args = [
        "create",
        "--init",
        "--network",
        target.network,
        "--mount",
        `type=bind,source=${workspacePath},target=${DEFAULT_REMOTE_CWD}`,
        "--workdir",
        remoteCwd,
      ];
      if (target.memoryMb !== undefined) args.push("--memory", `${target.memoryMb}m`);
      if (target.cpuShares !== undefined) args.push("--cpu-shares", String(target.cpuShares));
      args.push(target.image, "tail", "-f", "/dev/null");
      const created = await docker(args, { signal });
      const containerId = created.stdout.trim().split(/\s+/)[0];
      if (!containerId) throw new DockerRuntimeError("create", "Docker returned no container ID");
      const lease = {
        containerId,
        workspacePath,
        remoteCwd,
        createdAt: new Date().toISOString(),
      } satisfies DockerEnvironmentLease;
      await emit({ phase: "provision", containerId, message: "container created" });
      try {
        await docker(["start", containerId], { signal });
        const state = await provider.recover(containerId);
        if (state !== "running") throw new DockerRuntimeError("start", `container is ${state}`);
      } catch (error) {
        try {
          await provider.release(lease);
        } catch {
          // Preserve the readiness error; the orphan reconciler can retry removal.
        }
        throw error;
      }
      await emit({ phase: "ready", containerId, message: "container is ready" });
      return lease;
    },

    async prepare(lease) {
      await emit({ phase: "ready", containerId: lease.containerId, message: "workspace mounted" });
    },

    async execute(lease, target, options) {
      await emit({ phase: "execute", containerId: lease.containerId, message: "process started" });
      const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]);
      return await docker(
        [
          "exec",
          "--workdir",
          target.remoteCwd ?? lease.remoteCwd,
          ...envArgs,
          lease.containerId,
          options.command,
          ...options.args,
        ],
        {
          stdin: options.stdin,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onLog: options.onLog,
          onSpawn: options.onSpawn,
        },
      );
    },

    async finalize(lease) {
      await emit({
        phase: "finalize",
        containerId: lease.containerId,
        message: "workspace finalized",
      });
    },

    async release(lease) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= cleanupRetries; attempt += 1) {
        try {
          await docker(["rm", "--force", "--volumes", lease.containerId]);
          await emit({
            phase: "release",
            containerId: lease.containerId,
            message: "container removed",
          });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < cleanupRetries) {
            await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
          }
        }
      }
      throw new DockerRuntimeError(
        "rm",
        `failed to remove ${lease.containerId} after ${cleanupRetries} attempts: ${String(lastError)}`,
      );
    },

    async recover(containerId) {
      try {
        const inspected = await docker(["inspect", "--format", "{{.State.Status}}", containerId]);
        const status = inspected.stdout.trim();
        await emit({ phase: "recover", containerId, message: `container status: ${status}` });
        return status === "running" ? "running" : "exited";
      } catch (error) {
        if (
          error instanceof DockerRuntimeError &&
          /no such|not found|does not exist/i.test(error.message)
        ) {
          await emit({ phase: "recover", containerId, message: "container is missing" });
          return "missing";
        }
        throw error;
      }
    },
  };
  return provider;
}

export class DockerRuntimeError extends Error {
  readonly code = "AASPAI_DOCKER_RUNTIME";

  constructor(operation: string, detail: string) {
    super(`Docker ${operation} failed${detail ? `: ${detail}` : ""}`);
    this.name = "DockerRuntimeError";
  }
}

export function createDockerTarget(options: DockerEnvironmentProviderOptions = {}): RuntimeTarget {
  const provider = createDockerEnvironmentProvider(options);
  return {
    info: { kind: "docker", label: "Docker isolated environment", status: "ready" },
    async run(target, runOptions) {
      if (target.kind !== "docker")
        throw new Error(`dockerTarget cannot run a ${target.kind} target.`);
      const workspacePath = target.cwd ?? runOptions.cwd;
      if (!workspacePath) throw new DockerRuntimeError("provision", "a workspace path is required");
      const lease = await provider.provision(target, workspacePath, runOptions.signal);
      try {
        await provider.prepare(lease);
        const result = await provider.execute(lease, target, runOptions);
        await provider.finalize(lease);
        return result;
      } finally {
        await provider.release(lease);
      }
    },
    async prepareWorkspace(target, { localDir }) {
      if (target.kind !== "docker") throw new Error("dockerTarget only.");
      if (!localDir) throw new DockerRuntimeError("prepare", "a local workspace path is required");
    },
    async restoreWorkspace(target, { localDir }) {
      if (target.kind !== "docker") throw new Error("dockerTarget only.");
      if (!localDir) throw new DockerRuntimeError("restore", "a local workspace path is required");
    },
  };
}

export const dockerTarget: RuntimeTarget = createDockerTarget();
