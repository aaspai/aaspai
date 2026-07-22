import type {
  ExecutionTarget,
  RunProcessOptions,
  RunProcessResult,
  RuntimeTargetInfo,
  SandboxProvider,
} from "@aaspai/contracts/runtime";
import { runProcess as harnessRunProcess } from "@aaspai/harness";
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

class NotYetImplementedError extends Error {
  readonly code = "AASPAI_RUNTIME_STUB";
  constructor(kind: string) {
    super(
      `Execution target "${kind}" is not yet implemented in @aaspai/runtime. Use the local target for now.`,
    );
    this.name = "NotYetImplementedError";
  }
}

function makeLocalTarget(): RuntimeTarget {
  return {
    info: { kind: "local", label: "Local", status: "ready" },
    async run(target, options) {
      if (target.kind !== "local") {
        throw new Error(`Local target cannot run a ${target.kind} target.`);
      }
      return await harnessRunProcess({
        ...options,
        cwd: target.cwd ?? options.cwd ?? process.cwd(),
        env: target.envPassthrough ? options.env : { ...(options.env ?? {}) },
      });
    },
    async prepareWorkspace(target, { localDir, remoteDir }) {
      if (target.kind !== "local") throw new Error("Local target only.");
      void localDir;
      void remoteDir;
    },
    async restoreWorkspace(target, { localDir, remoteDir }) {
      if (target.kind !== "local") throw new Error("Local target only.");
      void localDir;
      void remoteDir;
    },
  };
}

function makeStubTarget(kind: "docker" | "ssh"): RuntimeTarget {
  return {
    info: { kind, label: kind === "docker" ? "Docker" : "SSH", status: "stub" },
    async run() {
      throw new NotYetImplementedError(kind);
    },
    async prepareWorkspace() {
      throw new NotYetImplementedError(kind);
    },
    async restoreWorkspace() {
      throw new NotYetImplementedError(kind);
    },
  };
}

/** Pick the right `RuntimeTarget` for an `ExecutionTarget`. */
export function pickTarget(target: ExecutionTarget): RuntimeTarget {
  switch (target.kind) {
    case "local":
      return makeLocalTarget();
    case "docker":
      return makeStubTarget("docker");
    case "ssh":
      return makeStubTarget("ssh");
    case "sandbox":
      return pickSandboxTarget(target.provider);
  }
}

/** Adapter for the in-process local filesystem sandbox client. */
export function createLocalSandboxClient(baseDir: string): SandboxClient {
  return new LocalSandboxClient(baseDir);
}

// Sandbox dispatch is wired up in drivers/sandbox/<provider>/index.ts.
// We import lazily so the registry can resolve any provider without
// pulling in the SDK of every other provider at module load.
import { pickSandboxTarget as _pickSandboxTarget } from "./sandbox-dispatch.js";

const pickSandboxTarget: (provider: SandboxProvider) => RuntimeTarget = _pickSandboxTarget;
