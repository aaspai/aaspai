import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTargetInfo, SandboxExecutionTarget } from "@aaspai/contracts/runtime";
import type { RuntimeTarget } from "./execution-target.js";
import { DockerSandboxDriver, type DockerSandboxConfig } from "./docker-sandbox-driver.js";

/**
 * Build a `RuntimeTarget` backed by a real docker container
 * (per-provider config: image, network, memory, CPU, env).
 *
 * Each `run` acquires a fresh container, runs the command, and
 * releases the container. The provider-specific config differentiates
 * the 7 sandbox targets in a way that's visible via `docker ps`.
 */
export function createDockerSandboxTarget(
  options: DockerSandboxConfig & { label: string; capabilities?: ProviderCapabilities },
): RuntimeTarget {
  const driver = new DockerSandboxDriver(options.providerKey, options);
  const capabilities = options.capabilities ?? {
    execute: true,
    streaming: true,
    cancellation: true,
    timeout: true,
    workspaceIsolation: true,
    restore: false,
    resume: true,
    artifacts: true,
  };

  return {
    info: {
      kind: "sandbox",
      provider: options.providerKey as never,
      label: options.label,
      status: "ready",
      capabilities,
    } as RuntimeTargetInfo,
    async run(target, runOptions) {
      if (target.kind !== "sandbox") {
        throw new Error(`docker-sandbox(${options.providerKey}) cannot run a ${target.kind} target.`);
      }
      const sandboxTarget = target as SandboxExecutionTarget;
      const remoteCwd = sandboxTarget.remoteCwd ?? "/workspace";
      const lease = await driver.acquire(remoteCwd, { timeoutMs: sandboxTarget.timeoutMs });
      try {
        const client = driver.client(lease);
        return await client.run(runOptions);
      } finally {
        await driver.release(lease);
      }
    },
    async prepareWorkspace(target) {
      if (target.kind !== "sandbox") throw new Error(`docker-sandbox(${options.providerKey}) only.`);
    },
    async restoreWorkspace(target) {
      if (target.kind !== "sandbox") throw new Error(`docker-sandbox(${options.providerKey}) only.`);
    },
  };
}
