import { type ChildProcess, spawn, spawn as spawnKill } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  RuntimeExecutionIdentity,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeProcessHandle,
  RuntimeSignal,
} from "../contracts/execution.js";
import { assertSafeEnvKey } from "../filesystem/safe-path.js";
import { shellQuote } from "../shell/quote.js";
import { BoundedByteBuffer } from "./bounded-buffer.js";
import { OrderedStream } from "./ordered-stream.js";

export interface LocalProcessOptions {
  /** Per-stream output cap in bytes. */
  maxBufferBytes?: number;
  /** Kill escalation grace after SIGTERM, in ms. */
  defaultGraceMs?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_GRACE_MS = 5_000;

interface LocalProcessState {
  child: ChildProcess;
  stdoutBuffer: BoundedByteBuffer;
  stderrBuffer: BoundedByteBuffer;
  startedAt: string;
  status: "running" | "settling" | "settled";
  stopRequested: "cancelled" | "timeout" | null;
  result?: RuntimeExecutionResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
}

function encode(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function signalToRuntimeSignal(signal: NodeJS.Signals): RuntimeSignal {
  return signal as RuntimeSignal;
}

/**
 * Reference local process implementation. Byte-streamed, bounded, with
 * ordered callbacks, stdin, cancel, signal, timeout and grace-escalated
 * termination. Every other provider's `startExecution` must satisfy the
 * same observable behavior.
 */
export async function startLocalProcess(
  request: RuntimeExecutionRequest,
  options: LocalProcessOptions = {},
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
    onStarted?: (identity: RuntimeExecutionIdentity) => Promise<void> | void;
  } = {},
): Promise<RuntimeProcessHandle> {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const defaultGraceMs = options.defaultGraceMs ?? DEFAULT_GRACE_MS;
  const executionId = `exec_${randomUUID()}`;

  const stdoutStream = new OrderedStream(hooks.onStdout ?? (() => undefined));
  const stderrStream = new OrderedStream(hooks.onStderr ?? (() => undefined));

  const state: LocalProcessState = {
    child: undefined as unknown as ChildProcess,
    stdoutBuffer: new BoundedByteBuffer({ maxBytes: maxBufferBytes, mode: "tail" }),
    stderrBuffer: new BoundedByteBuffer({ maxBytes: maxBufferBytes, mode: "tail" }),
    startedAt: new Date().toISOString(),
    status: "running",
    stopRequested: null,
    exitCode: null,
    signal: null,
    spawnError: null,
  };

  for (const key of Object.keys(request.env ?? {})) assertSafeEnvKey(key);
  const env = {
    ...(request.inheritEnv === false ? {} : process.env),
    ...(request.env ?? {}),
  } as NodeJS.ProcessEnv;
  const invocation = request.shell
    ? {
        command:
          process.platform === "win32"
            ? [request.command, ...request.args].map(quoteWindowsShellArg).join(" ")
            : [shellQuote(request.command), ...request.args.map(shellQuote)].join(" "),
        args: [] as string[],
      }
    : { command: request.command, args: request.args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.cwd,
    env,
    shell: request.shell === true,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  state.child = child;

  if (request.stdin !== undefined && child.stdin) {
    child.stdin.end(encode(request.stdin));
  }

  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "local",
    providerLeaseId: null,
    pid: child.pid,
    processGroupId: process.platform === "win32" ? undefined : child.pid,
  };
  // `onStarted` is an observer. A throwing observer must not change process
  // ownership or leave an unhandled rejection on the runtime boundary.
  void Promise.resolve(hooks.onStarted?.(identity)).catch(() => undefined);

  const terminate = (sig: NodeJS.Signals): void => {
    if (state.status === "settled") return;
    try {
      if (process.platform === "win32" && child.pid !== undefined) {
        const killer = spawnKill("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref();
      } else if (child.pid !== undefined) {
        process.kill(-child.pid, sig);
      } else {
        child.kill(sig);
      }
    } catch {
      // already dead
    }
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  let processDeathPromise: Promise<void> | undefined;
  let cancelResolve: (() => void) | undefined;
  const cancelGate = new Promise<void>((resolve) => {
    cancelResolve = resolve;
  });

  const stop = (reason: "cancelled" | "timeout"): void => {
    if (state.status !== "running" || state.stopRequested !== null) return;
    state.stopRequested = reason;
    state.status = "settling";
    const graceMs = request.graceMs ?? defaultGraceMs;
    terminate("SIGTERM");
    processDeathPromise = waitForProcessGroupDeath(graceMs);
  };

  if (request.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => stop("timeout"), request.timeoutMs);
    timeoutHandle.unref();
  }

  child.stdout?.on("data", (buf: Buffer) => {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    state.stdoutBuffer.append(bytes);
    stdoutStream.push(bytes);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    state.stderrBuffer.append(bytes);
    stderrStream.push(bytes);
  });
  child.on("error", (err) => {
    state.spawnError = err.message;
    if (state.status === "running") state.status = "settling";
    cancelResolve?.();
    // Node normally follows a spawn error with `close`, but that is not
    // guaranteed for a custom ChildProcess implementation. Settle here as
    // well so wait/cancel cannot hang forever on a failed spawn.
    void runSettle();
  });
  child.on("close", (code, signal) => {
    state.status = "settling";
    state.exitCode = code;
    state.signal = signal;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    cancelResolve?.();
    void runSettle();
  });

  let settlePromise: Promise<void> | undefined;
  async function runSettle(): Promise<void> {
    if (settlePromise) return settlePromise;
    settlePromise = settle();
    await settlePromise;
  }

  async function settle(): Promise<void> {
    if (state.result) return;
    if (processDeathPromise) await processDeathPromise;
    await stdoutStream.close();
    await stderrStream.close();
    const finishedAt = new Date();
    const stopReason = state.stopRequested;
    let status: RuntimeExecutionResult["status"] = "completed";
    let terminationReason: RuntimeExecutionResult["terminationReason"] = "exit";
    if (stopReason === "cancelled") {
      status = "cancelled";
      terminationReason = "cancelled";
    } else if (stopReason === "timeout") {
      status = "timed_out";
      terminationReason = "timeout";
    } else if (state.spawnError !== null) {
      status = "failed";
      terminationReason = "spawn_error";
    } else if ((state.exitCode ?? 0) !== 0) {
      status = "failed";
      terminationReason = "exit";
    } else if (state.signal !== null) {
      status = "failed";
      terminationReason = "signal";
    }
    state.result = {
      status,
      exitCode: stopReason !== null ? null : state.exitCode,
      signal:
        state.signal !== null
          ? signalToRuntimeSignal(state.signal)
          : stopReason !== null
            ? "SIGTERM"
            : undefined,
      terminationReason,
      stdoutTail: state.stdoutBuffer.toUint8Array(),
      stderrTail: state.stderrBuffer.toUint8Array(),
      stdoutBytes: state.stdoutBuffer.totalBytes,
      stderrBytes: state.stderrBuffer.totalBytes,
      stdoutSha256: state.stdoutBuffer.sha256,
      stderrSha256: state.stderrBuffer.sha256,
      stdoutTruncated: state.stdoutBuffer.isTruncated,
      stderrTruncated: state.stderrBuffer.isTruncated,
      startedAt: state.startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - new Date(state.startedAt).getTime(),
      identity,
    };
    state.status = "settled";
  }

  async function waitForProcessGroupDeath(graceMs: number): Promise<void> {
    if (child.pid === undefined) return;
    const groupPid = child.pid;
    const isAlive = (): boolean => {
      try {
        process.kill(process.platform === "win32" ? groupPid : -groupPid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const deadline = Date.now() + Math.max(0, graceMs);
    while (isAlive() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (!isAlive()) return;
    terminate("SIGKILL");
    const killDeadline = Date.now() + Math.max(1_000, graceMs);
    while (isAlive() && Date.now() < killDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  const wait = async (): Promise<RuntimeExecutionResult> => {
    if (state.result) return state.result;
    await cancelGate;
    await runSettle();
    if (!state.result) throw new Error("local process settled without a result");
    return state.result;
  };

  return {
    executionId,
    identity,
    async wait() {
      return await wait();
    },
    async cancel(_reason) {
      stop("cancelled");
      // wait for the process to actually die before returning. A second
      // cancellation joins the same gate and never sends a second kill.
      await cancelGate;
      await runSettle();
    },
    async signal(sig) {
      if (state.status !== "running") return;
      terminate(sig);
    },
    async writeStdin(data) {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return;
      try {
        const accepted = stdin.write(encode(data));
        if (!accepted && !stdin.destroyed && !stdin.writableEnded) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              stdin.off("drain", done);
              stdin.off("close", done);
              stdin.off("error", done);
              resolve();
            };
            stdin.once("drain", done);
            stdin.once("close", done);
            stdin.once("error", done);
          });
        }
      } catch {
        // A process may close stdin concurrently with a live write. The
        // process result remains authoritative; late input is idempotently
        // ignored instead of turning a completed run into an unhandled error.
      }
    },
    async closeStdin() {
      const stdin = child.stdin;
      if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.end();
    },
  };
}

/** Convenience one-shot: start + wait. */
export async function runLocalProcess(
  request: RuntimeExecutionRequest,
  options?: LocalProcessOptions,
  hooks?: RuntimeProcessHandleHooks,
): Promise<RuntimeExecutionResult> {
  const handle = await startLocalProcess(request, options, hooks);
  return await handle.wait();
}

export interface RuntimeProcessHandleHooks {
  onStdout?: (chunk: Uint8Array) => Promise<void> | void;
  onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  onStarted?: (identity: RuntimeExecutionIdentity) => Promise<void> | void;
}

export { decode as bytesToString };

function quoteWindowsShellArg(value: string): string {
  if (/^[A-Za-z0-9_./\\:-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}
