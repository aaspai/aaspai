import type { ProviderCapabilities } from "@aaspai/contracts/capabilities";
import type { RuntimeTargetInfo, SandboxExecutionTarget } from "@aaspai/contracts/runtime";
import type { RuntimeTarget } from "./execution-target.js";
import type { SdkSandboxDriver } from "./sdk-sandbox-driver.js";
import { prepareRuntimeForExecution, restoreRuntimeFromExecution } from "./workspace-roundtrip.js";

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
      const reuseLease = sandboxTarget.metadata?.reuseLease === true;
      const existingLeaseId =
        typeof sandboxTarget.metadata?.providerLeaseId === "string"
          ? sandboxTarget.metadata.providerLeaseId
          : undefined;
      const resumedRemoteCwd =
        typeof sandboxTarget.metadata?.providerLeaseRemoteCwd === "string"
          ? sandboxTarget.metadata.providerLeaseRemoteCwd
          : remoteCwd;
      const lease = existingLeaseId
        ? await driver.resume(existingLeaseId, resumedRemoteCwd)
        : await driver.acquire(remoteCwd, {
            timeoutMs: sandboxTarget.timeoutMs,
            reuseLease,
          });
      if (!lease) {
        throw new Error(`sdk-sandbox(${input.providerKey}) lease not found: ${existingLeaseId}`);
      }
      const client = driver.client(lease);
      const localDir = runOptions.cwd;
      let prepared = false;
      try {
        if (localDir) {
          await prepareRuntimeForExecution({
            client,
            localDir,
            remoteDir: lease.remoteCwd,
          });
          prepared = true;
        }
        const result = await client.run({ ...runOptions, cwd: lease.remoteCwd });
        return {
          ...result,
          runtimeIdentity: {
            kind: "sandbox",
            cwd: lease.remoteCwd,
            remoteCwd: lease.remoteCwd,
            connectionIdentity: `${input.providerKey}:${lease.providerLeaseId}`,
          },
        };
      } finally {
        try {
          if (prepared && localDir) {
            await restoreRuntimeFromExecution({
              client,
              localDir,
              remoteDir: lease.remoteCwd,
            });
          }
        } finally {
          await driver.release(lease, { reuseLease });
        }
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
