import { spawn } from "node:child_process";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_BYTES = (() => {
  const raw = process.env.AASPAI_RUN_MAX_BUFFER_BYTES;
  if (!raw) return DEFAULT_MAX_BUFFER_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BUFFER_BYTES;
})();

const TRUNCATE_MARKER = "\n... [truncated] ...\n";

function truncate(chunk: string, current: number): string {
  if (current + chunk.length <= MAX_BUFFER_BYTES) return chunk;
  const remaining = Math.max(0, MAX_BUFFER_BYTES - current);
  if (remaining === 0) return "";
  const head = chunk.slice(0, Math.floor(remaining / 2));
  const tail = chunk.slice(chunk.length - Math.ceil(remaining / 2));
  return `${head}${TRUNCATE_MARKER}${tail}`;
}

/**
 * Run a process on the local host. Mirrors the contract used by every
 * execution target in `@aaspai/runtime`. Streams stdout/stderr through
 * `options.onLog` (if provided) and always returns a `RunProcessResult`.
 *
 * Honours `AASPAI_RUN_MAX_BUFFER_BYTES` (default 16 MiB) per stream.
 * Past the limit, old content is dropped from the head and a truncation
 * marker is inserted.
 */
export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const startedAt = new Date();
  const { command, args, cwd, env: envOverrides, stdin, timeoutMs, signal: abortSignal } = options;
  const workingDir = cwd ?? process.cwd();
  const env = { ...process.env, ...(envOverrides ?? {}) };

  return await new Promise<RunProcessResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: workingDir,
      env,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let stopReason: "timeout" | "aborted" | null = null;

    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let closed = false;
    const terminate = (signalName: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, signalName);
        } else {
          child.kill(signalName);
        }
      } catch {
        // already dead
      }
    };
    const stop = (reason: "timeout" | "aborted"): void => {
      if (closed || stopReason !== null) return;
      stopReason = reason;
      timedOut = reason === "timeout";
      terminate("SIGTERM");
      killHandle = setTimeout(() => terminate("SIGKILL"), 5_000);
      killHandle.unref();
    };
    const onAbort = (): void => stop("aborted");
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        stop("timeout");
      }, timeoutMs);
      timeoutHandle.unref();
    }
    if (abortSignal?.aborted) stop("aborted");
    else abortSignal?.addEventListener("abort", onAbort, { once: true });

    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }

    if (options.onSpawn && child.pid !== undefined) {
      Promise.resolve()
        .then(() => options.onSpawn?.({ pid: child.pid as number }))
        .catch(() => {
          // listener errors must not break the run
        });
    }

    const onChunk = async (
      streamName: "stdout" | "stderr",
      sink: string[],
      state: { bytes: number },
      buffer: Buffer,
    ): Promise<void> => {
      const text = buffer.toString("utf8");
      const piece = truncate(text, state.bytes);
      state.bytes += piece.length;
      if (piece.length > 0) sink.push(piece);
      if (options.onLog) {
        try {
          await options.onLog(streamName, text);
        } catch {
          // listener errors must not break the run
        }
      }
    };

    const drain = (stream: NodeJS.ReadableStream | null, streamName: "stdout" | "stderr"): void => {
      if (!stream) return;
      const sink = streamName === "stdout" ? stdoutChunks : stderrChunks;
      const state = streamName === "stdout" ? stdoutState : stderrState;
      let pending: Promise<void> = Promise.resolve();
      stream.on("data", (buf: Buffer) => {
        pending = pending.then(() => onChunk(streamName, sink, state, buf));
      });
      (stream as unknown as { _aaspaiDrained?: Promise<void> })._aaspaiDrained = pending;
    };

    drain(child.stdout, "stdout");
    drain(child.stderr, "stderr");

    child.on("error", (err) => {
      stderrChunks.push(`[spawn error] ${err.message}\n`);
    });

    child.on("close", async (code, signal) => {
      closed = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (killHandle !== undefined) clearTimeout(killHandle);
      abortSignal?.removeEventListener("abort", onAbort);
      const stdoutDrained =
        (child.stdout as unknown as { _aaspaiDrained?: Promise<void> })?._aaspaiDrained ??
        Promise.resolve();
      const stderrDrained =
        (child.stderr as unknown as { _aaspaiDrained?: Promise<void> })?._aaspaiDrained ??
        Promise.resolve();
      await Promise.all([stdoutDrained, stderrDrained]);

      const finishedAt = new Date();
      const result: RunProcessResult = {
        exitCode: code,
        signal: signal ?? (stopReason !== null ? "SIGTERM" : undefined),
        timedOut,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        pid: child.pid,
      };
      resolve(result);
    });
  });
}
