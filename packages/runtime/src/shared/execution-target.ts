import type {
  ExecutionTarget,
  RunProcessOptions,
  RunProcessResult,
  RuntimeTargetInfo,
} from "@aaspai/contracts/runtime";
import { resolveTarget } from "../registry.js";
import { LocalSandboxClient, type SandboxClient } from "./sandbox-client.js";

/**
 * The single host-facing API for running a process against any
 * `ExecutionTarget`. Dispatches to the right driver based on `kind`.
 *
 * Foundation slice: `local` is fully implemented. `docker`, `ssh`,
 * and `sandbox` resolve to a stub that throws "not yet implemented"
 * with a clear message — the package layout is in place, the SDK
 * calls come in once an API key is available.
 */
export interface RuntimeTarget {
  info: RuntimeTargetInfo;
  run(target: ExecutionTarget, options: RunProcessOptions): Promise<RunProcessResult>;
  prepareWorkspace?(
    target: ExecutionTarget,
    options: { localDir: string; remoteDir: string },
  ): Promise<void>;
  restoreWorkspace?(
    target: ExecutionTarget,
    options: { localDir: string; remoteDir: string },
  ): Promise<void>;
}

/** Pick the right `RuntimeTarget` for an `ExecutionTarget`. */
export function pickTarget(target: ExecutionTarget): RuntimeTarget {
  return resolveTarget(target);
}

/** Adapter for the in-process local filesystem sandbox client. */
export function createLocalSandboxClient(baseDir: string): SandboxClient {
  return new LocalSandboxClient(baseDir);
}
