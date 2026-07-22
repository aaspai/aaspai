import type { ExecutionTarget, RuntimeTargetInfo } from "@aaspai/contracts/runtime";
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
  ];
}

export const RUNTIME_REGISTRY_VERSION = 1 as const;
