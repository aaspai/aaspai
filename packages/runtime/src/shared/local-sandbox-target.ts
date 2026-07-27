import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTargetInfo, SandboxExecutionTarget } from "@aaspai/contracts/runtime";
import type { RuntimeTarget } from "./execution-target.js";
export type { RuntimeTarget } from "./execution-target.js";
import { LocalSandboxDriver } from "./sandbox-driver.js";

/**
 * Capability matrix for sandbox providers. Each provider gets a
 * different "fingerprint" of which features it claims to support —
 * the `RuntimeProgressUpdate` / `restore` / `resume` / `artifacts`
 * columns are the ones a real implementation will toggle on.
 */
const DEFAULT_SANDBOX_CAPABILITIES: ProviderCapabilities = {
  execute: true,
  streaming: true,
  cancellation: true,
  timeout: true,
  workspaceIsolation: true,
  restore: false,
  resume: true,
  artifacts: false,
};

export interface CreateSandboxTargetOptions {
  providerKey: string;
  label: string;
  status?: "ready" | "stub";
  capabilities?: ProviderCapabilities;
  driver?: LocalSandboxDriver;
}

/**
 * Build a `RuntimeTarget` from a provider key. The target exposes
 * `info` with the provider's identity, and `run` / `prepareWorkspace`
 * / `restoreWorkspace` that acquire a lease, execute, and release.
 */
export function createLocalSandboxTarget(
  options: CreateSandboxTargetOptions,
): RuntimeTarget {
  const driver = options.driver ?? new LocalSandboxDriver(options.providerKey);
  const capabilities = options.capabilities ?? DEFAULT_SANDBOX_CAPABILITIES;
  const status = options.status ?? "ready";

  return {
    info: {
      kind: "sandbox",
      provider: options.providerKey as never,
      label: options.label,
      status,
      capabilities,
    } as RuntimeTargetInfo,
    async run(target, runOptions) {
      if (target.kind !== "sandbox") {
        throw new Error(`sandboxTarget(${options.providerKey}) cannot run a ${target.kind} target.`);
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
    async prepareWorkspace(target, _opts) {
      if (target.kind !== "sandbox") throw new Error(`sandboxTarget(${options.providerKey}) only.`);
      // Local backends don't need workspace round-trip — the host
      // filesystem is the source of truth.
    },
    async restoreWorkspace(target, _opts) {
      if (target.kind !== "sandbox") throw new Error(`sandboxTarget(${options.providerKey}) only.`);
    },
  };
}
