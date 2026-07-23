import type { ExecutionTarget, ProviderCapabilities, RuntimeTargetInfo } from "@aaspai/contracts";
import { dockerTarget } from "./drivers/docker/index.js";
import { localTarget } from "./drivers/local/index.js";
import { sshTarget } from "./drivers/ssh/index.js";
import type { RuntimeTarget } from "./shared/execution-target.js";
import { listSandboxProviders, pickSandboxTarget } from "./shared/sandbox-dispatch.js";

/**
 * Resolve the right `RuntimeTarget` for any `ExecutionTarget`. Thin
 * wrapper around the dispatch table so the public API of
 * `@aaspai/runtime` is one function call away from "I have an
 * ExecutionTarget, give me the thing that runs it."
 */
export function resolveTarget(target: ExecutionTarget): RuntimeTarget {
  switch (target.kind) {
    case "local":
      return localTarget;
    case "docker":
      return dockerTarget;
    case "ssh":
      return sshTarget;
    case "sandbox":
      return pickSandboxTarget(target.provider);
  }
}

export function listRuntimeTargets(): RuntimeTargetInfo[] {
  return [
    localTarget.info,
    dockerTarget.info,
    sshTarget.info,
    ...listSandboxProviders().map((p) => pickSandboxTarget(p).info),
  ].map((info) => ({ ...info, capabilities: capabilitiesFor(info) }));
}

function capabilitiesFor(info: RuntimeTargetInfo): ProviderCapabilities {
  if (info.status !== "ready") {
    return {
      execute: false,
      streaming: false,
      cancellation: false,
      timeout: false,
      workspaceIsolation: false,
      restore: false,
      resume: false,
      artifacts: false,
    };
  }
  return {
    execute: true,
    streaming: true,
    cancellation: true,
    timeout: true,
    workspaceIsolation: info.kind === "docker",
    restore: false,
    resume: false,
    artifacts: false,
  };
}

export function getRuntimeTargetCapabilities(target: ExecutionTarget): ProviderCapabilities {
  const info = resolveTarget(target).info;
  return capabilitiesFor(info);
}

export const RUNTIME_REGISTRY_VERSION = 1 as const;
