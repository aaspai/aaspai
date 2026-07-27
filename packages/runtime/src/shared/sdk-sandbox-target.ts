import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTargetInfo, SandboxExecutionTarget } from "@aaspai/contracts/runtime";
import type { RuntimeTarget } from "./execution-target.js";
import type { SdkSandboxDriver } from "./sdk-sandbox-driver.js";

/**
 * Build a `RuntimeTarget` from an `SdkSandboxDriver`. Each `run`
 * acquires a fresh sandbox, runs the command, and releases.
 */
export function createSdkSandboxTarget(input: {
  driver: SdkSandboxDriver<unknown>;
  providerKey: string;
  label: string;
  capabilities: ProviderCapabilities;
}): RuntimeTarget {
  const driver = input.driver as SdkSandboxDriver<never>;

  return {
    info: {
      kind: "sandbox",
      provider: input.providerKey as never,
      label: input.label,
      status: "ready",
      capabilities: input.capabilities,
    } as RuntimeTargetInfo,
    async run(target, runOptions) {
      if (target.kind !== "sandbox") {
        throw new Error(`sdk-sandbox(${input.providerKey}) cannot run a ${target.kind} target.`);
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
      if (target.kind !== "sandbox") throw new Error(`sdk-sandbox(${input.providerKey}) only.`);
    },
    async restoreWorkspace(target) {
      if (target.kind !== "sandbox") throw new Error(`sdk-sandbox(${input.providerKey}) only.`);
    },
  };
}
