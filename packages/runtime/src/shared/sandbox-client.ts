import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";

/**
 * 6-method filesystem + exec client every sandbox provider implements.
 * Mirrors paperclip's `SandboxManagedRuntimeClient` shape.
 */
export interface SandboxClient {
  makeDir(remotePath: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(remotePath: string, content: string | Uint8Array): Promise<void>;
  readFile(remotePath: string): Promise<Buffer>;
  listFiles(remotePath: string): Promise<{ name: string; size: number; isDir: boolean }[]>;
  remove(remotePath: string, options?: { recursive?: boolean }): Promise<void>;
  run(options: RunProcessOptions): Promise<RunProcessResult>;
}

/**
 * The lease lifecycle every sandbox driver implements.
 * `release` is "pause if reuseLease, else destroy".
 * `destroy` is always "force destroy, ignore reuseLease".
 */
export interface SandboxLease {
  providerLeaseId: string;
  remoteCwd: string;
  shellCommand?: "bash" | "sh";
  metadata?: Record<string, unknown>;
}

export interface SandboxDriver {
  /** Acquire a new lease. Returns the lease descriptor. */
  acquire(remoteCwd: string, options?: { timeoutMs?: number }): Promise<SandboxLease>;
  /** Reconnect to an existing lease by providerLeaseId. Returns null if expired. */
  resume(providerLeaseId: string): Promise<SandboxLease | null>;
  /** Release the lease — pause if reuseLease, destroy otherwise. */
  release(lease: SandboxLease, options?: { reuseLease?: boolean }): Promise<void>;
  /** Force-destroy the lease, ignoring reuseLease. */
  destroy(providerLeaseId: string): Promise<void>;
  /** Return a 6-method client bound to this lease. */
  client(lease: SandboxLease): SandboxClient;
}

/**
 * Factory for `LocalSandboxClient`. Mirrors how a sandbox provider
 * would expose its client — adapter code takes a `SandboxClient` and
 * doesn't know whether it's local or remote.
 */
export function createLocalSandboxClient(baseDir: string): SandboxClient {
  return new LocalSandboxClient(baseDir);
}

/**
 * In-process local filesystem implementation of `SandboxClient`. Used by
 * the `local` execution target and as a no-network reference for the
 * sandbox contract. Mirrors what every sandbox driver must implement
 * in spirit; sandbox providers swap the actual operations for their
 * SDK calls.
 */
export class LocalSandboxClient implements SandboxClient {
  constructor(private readonly baseDir: string) {}

  async makeDir(remotePath: string, options?: { recursive?: boolean }): Promise<void> {
    const { mkdir: fsMkdir } = await import("node:fs/promises");
    await fsMkdir(this.resolve(remotePath), { recursive: options?.recursive ?? true });
  }

  async writeFile(remotePath: string, content: string | Uint8Array): Promise<void> {
    const { writeFile: fsWriteFile } = await import("node:fs/promises");
    const full = this.resolve(remotePath);
    await mkdir(dirname(full), { recursive: true });
    await fsWriteFile(full, content);
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const { readFile: fsReadFile } = await import("node:fs/promises");
    return await fsReadFile(this.resolve(remotePath));
  }

  async listFiles(remotePath: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const { readdir, stat } = await import("node:fs/promises");
    const full = this.resolve(remotePath);
    const entries = await readdir(full, { withFileTypes: true });
    const out: { name: string; size: number; isDir: boolean }[] = [];
    for (const entry of entries) {
      const s = await stat(`${full}/${entry.name}`);
      out.push({ name: entry.name, size: s.size, isDir: entry.isDirectory() });
    }
    return out;
  }

  async remove(remotePath: string, options?: { recursive?: boolean }): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.resolve(remotePath), { recursive: options?.recursive ?? true, force: true });
  }

  async run(options: RunProcessOptions): Promise<RunProcessResult> {
    const startedAt = new Date();
    return await new Promise<RunProcessResult>((resolve) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd ?? this.baseDir,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      let closed = false;
      const terminate = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // already dead
        }
      };
      const stop = (reason: "timeout" | "aborted"): void => {
        if (closed) return;
        timedOut = reason === "timeout";
        terminate("SIGTERM");
        killHandle = setTimeout(() => terminate("SIGKILL"), 5_000);
        killHandle.unref();
      };
      const onAbort = (): void => stop("aborted");
      if (options.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          stop("timeout");
        }, options.timeoutMs);
        timeoutHandle.unref();
      }
      if (options.signal?.aborted) stop("aborted");
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.stdin !== undefined && child.stdin) child.stdin.end(options.stdin);
      child.stdout?.on("data", (b: Buffer) => {
        const s = b.toString("utf8");
        stdoutChunks.push(s);
        if (options.onLog) Promise.resolve(options.onLog("stdout", s)).catch(() => undefined);
      });
      child.stderr?.on("data", (b: Buffer) => {
        const s = b.toString("utf8");
        stderrChunks.push(s);
        if (options.onLog) Promise.resolve(options.onLog("stderr", s)).catch(() => undefined);
      });
      child.on("close", (code, signal) => {
        closed = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (killHandle !== undefined) clearTimeout(killHandle);
        options.signal?.removeEventListener("abort", onAbort);
        const finishedAt = new Date();
        resolve({
          exitCode: code,
          signal: signal ?? (timedOut ? "SIGTERM" : undefined),
          timedOut,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          pid: child.pid,
        });
      });
    });
  }

  private resolve(remotePath: string): string {
    if (remotePath.startsWith("/")) {
      return `${this.baseDir}${remotePath}`;
    }
    return `${this.baseDir}/${remotePath}`;
  }
}
