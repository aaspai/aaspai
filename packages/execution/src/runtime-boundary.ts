import type { AdapterRuntimeExecution } from "@aaspai/contracts/harness";
import type {
  ExecutionTarget,
  RunProcessOptions,
  RunProcessResult,
} from "@aaspai/contracts/runtime";
import {
  createLocalProviderFromConfig,
  type LocalProviderConfig,
  RuntimeController,
  type RuntimeExecutionResult,
} from "@aaspai/runtime";

/** A runtime boundary owned by an execution attempt. */
export interface ManagedRuntimeBoundary {
  execution: AdapterRuntimeExecution;
  close(): Promise<void>;
}

/**
 * Construct the production local boundary used by execution callers.
 *
 * Remote target acquisition is intentionally not hidden here: Daytona leases
 * must be acquired and persisted by the caller that owns the attempt. Until
 * that migration is complete, silently falling back to the host would violate
 * the requested target, so non-local targets fail closed.
 */
export async function createManagedRuntimeBoundary(
  target: ExecutionTarget,
  cwd: string,
  credentials?: Record<string, string | undefined>,
): Promise<ManagedRuntimeBoundary> {
  if (target.kind !== "local") {
    throw new Error(
      `Runtime V2 boundary for ${target.kind === "sandbox" ? `${target.kind}:${target.provider}` : target.kind} must be acquired by the execution caller; only local is available here`,
    );
  }

  const config: LocalProviderConfig = { root: cwd };
  const provider = await createLocalProviderFromConfig(config);
  const runtime = new RuntimeController({ provider, credentials });
  const lease = await runtime.acquire(config, { localPath: cwd });
  await runtime.realize(config, lease, { localPath: cwd });
  let closed = false;

  const start = async (
    options: RunProcessOptions,
    hooks?: {
      onStdout?(chunk: Uint8Array): Promise<void> | void;
      onStderr?(chunk: Uint8Array): Promise<void> | void;
    },
  ) => {
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const handle = await runtime.start(
      config,
      lease,
      {
        command: options.command,
        args: [...(options.args ?? [])],
        cwd: options.cwd ?? cwd,
        env: options.env,
        inheritEnv: options.inheritEnv,
        stdin: options.stdin,
        timeoutMs: options.timeoutMs,
        graceMs: options.graceMs,
      },
      {
        onStdout: async (chunk) => {
          await hooks?.onStdout?.(chunk);
          await options.onLog?.("stdout", stdoutDecoder.decode(chunk, { stream: true }));
        },
        onStderr: async (chunk) => {
          await hooks?.onStderr?.(chunk);
          await options.onLog?.("stderr", stderrDecoder.decode(chunk, { stream: true }));
        },
      },
    );
    await options.onSpawn?.({ pid: handle.identity.pid ?? 0 });
    const abort = async (): Promise<void> => {
      await handle.cancel("cancelled");
    };
    if (options.signal?.aborted) await abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    return {
      wait: async (): Promise<RunProcessResult> => {
        try {
          const result = await handle.wait();
          stdoutDecoder.decode();
          stderrDecoder.decode();
          return toExecutionResult(result, cwd);
        } finally {
          options.signal?.removeEventListener("abort", abort);
        }
      },
      cancel: async (reason?: string): Promise<void> => {
        await handle.cancel(reason);
      },
    };
  };

  const execution: AdapterRuntimeExecution = {
    identity: { kind: "local", cwd, runtimeScope: cwd },
    run: async (options) => await (await start(options)).wait(),
    start,
    exposeEndpoint: async ({ port, protocol }) =>
      await runtime.exposeEndpoint(config, lease, port, protocol),
  };

  return {
    execution,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await runtime.release(config, lease, "destroy");
    },
  };
}

function toExecutionResult(result: RuntimeExecutionResult, cwd: string): RunProcessResult {
  const decode = (value: Uint8Array | undefined): string =>
    value ? new TextDecoder().decode(value) : "";
  return {
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    timedOut: result.status === "timed_out",
    stdout: decode(result.stdoutTail),
    stderr: decode(result.stderrTail),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    ...(result.identity.pid ? { pid: result.identity.pid } : {}),
    runtimeIdentity: {
      kind: "local",
      cwd,
      pid: result.identity.pid,
    },
  };
}
