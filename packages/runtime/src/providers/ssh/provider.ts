import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runtimeError } from "../../core/contracts/errors.js";
import type {
  RuntimeExecutionIdentity,
  RuntimeExecutionResult,
} from "../../core/contracts/execution.js";
import type {
  RuntimeAcquireContext,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeProbeResult,
  RuntimeProcessHandle,
  RuntimeProvider,
  RuntimeReleaseContext,
  RuntimeResumeContext,
  RuntimeResumeResult,
  RuntimeStartExecutionContext,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "../../core/contracts/index.js";
import { BoundedByteBuffer } from "../../core/process/bounded-buffer.js";
import { OrderedStream } from "../../core/process/ordered-stream.js";
import { assertValidEnvMap, shellQuote } from "../../core/shell/quote.js";
import { type SshProviderConfig, sshConfigSchema } from "./config.js";
import { sshManifest } from "./manifest.js";

function resolveSshBinary(name: "ssh" | "scp"): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", `${name}.exe`);
  }
  return `/usr/bin/${name}`;
}

function buildSshArgs(config: SshProviderConfig, command: string): string[] {
  const args: string[] = [];
  if (config.port !== 22) args.push("-p", String(config.port));
  if (config.privateKey) args.push("-i", config.privateKey);
  if (config.strictHostKeyChecking === false) {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  } else if (config.knownHosts) {
    args.push("-o", `UserKnownHostsFile=${config.knownHosts}`);
  }
  args.push("-o", "BatchMode=yes", "-o", "LogLevel=ERROR");
  args.push(`${config.username}@${config.host}`);
  args.push(command);
  return args;
}

interface SshExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
}

function sshExec(
  config: SshProviderConfig,
  command: string,
  options: {
    timeoutMs?: number;
    onStdout?: (c: string) => void;
    onStderr?: (c: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const bin = resolveSshBinary("ssh");
    const child = spawn(bin, buildSshArgs(config, command), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
      timeoutHandle.unref();
    }
    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stdout.push(s);
      options.onStdout?.(s);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString("utf8");
      stderr.push(s);
      options.onStderr?.(s);
    });
    child.on("close", (code, signal) => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      resolve({
        exitCode: code,
        signal: signal ?? undefined,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
    });
  });
}

function buildRemoteCommand(
  remoteWorkdir: string,
  request: { command: string; args?: string[]; env?: Record<string, string>; stdinPath?: string },
): string {
  assertValidEnvMap(request.env);
  const env = Object.entries(request.env ?? {}).map(([k, v]) => shellQuote(`${k}=${v}`));
  const cmd = ["env", ...env, shellQuote(request.command), ...(request.args ?? []).map(shellQuote)];
  const base = `cd ${shellQuote(remoteWorkdir)} && ${cmd.join(" ")}`;
  return request.stdinPath ? `${base} < ${shellQuote(request.stdinPath)}` : base;
}

/**
 * SSH V2 provider. Remote execution over the host OpenSSH client.
 * Cancellation is not yet proven (killing the remote process group is
 * not implemented), so `cancellation: false`.
 */
export function createSshProvider(config: SshProviderConfig): RuntimeProvider<SshProviderConfig> {
  return {
    manifest: sshManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<SshProviderConfig>> {
      try {
        const parsed = sshConfigSchema.parse(input);
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid ssh config"],
        };
      }
    },

    async probe(): Promise<RuntimeProbeResult> {
      const result = await sshExec(config, "true", { timeoutMs: 10_000 });
      return result.exitCode === 0
        ? { ok: true, summary: `ssh ${config.username}@${config.host} reachable` }
        : {
            ok: false,
            summary: "ssh connectivity check failed",
            error: result.stderr || "ssh failed",
          };
    },

    async acquireLease(_ctx: RuntimeAcquireContext<SshProviderConfig>): Promise<RuntimeLease> {
      const leaseId = `ssh-${randomUUID().slice(0, 8)}`;
      return {
        version: 1,
        provider: "ssh",
        providerLeaseId: leaseId,
        reusable: false,
        createdAt: new Date().toISOString(),
        metadata: {
          provider: "ssh",
          backend: "ssh",
          host: config.host,
          remoteCwd: config.remoteCwd,
          shellCommand: config.shellCommand,
          nativeState: "connected",
        },
      };
    },

    async resumeLease(_ctx: RuntimeResumeContext<SshProviderConfig>): Promise<RuntimeResumeResult> {
      return { status: "expired", reason: "ssh provider leases are ephemeral" };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<SshProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? config.remoteCwd;
      const result = await sshExec(config, `mkdir -p ${shellQuote(cwd)}`, { timeoutMs: 15_000 });
      if (result.exitCode !== 0) {
        throw runtimeError("WORKSPACE_FAILED", `ssh mkdir failed: ${result.stderr}`, result);
      }
      return { cwd, metadata: { provider: "ssh", cwd, host: config.host } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<SshProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const remoteCwd = ctx.request.cwd ?? ctx.lease.metadata.remoteCwd ?? config.remoteCwd;
      const executionId = `exec_${randomUUID()}`;
      const stdoutStream = new OrderedStream(ctx.onStdout ?? (() => undefined));
      const stderrStream = new OrderedStream(ctx.onStderr ?? (() => undefined));
      const stdoutBuffer = new BoundedByteBuffer({ maxBytes: 256 * 1024, mode: "tail" });
      const stderrBuffer = new BoundedByteBuffer({ maxBytes: 256 * 1024, mode: "tail" });

      const stdinPath =
        ctx.request.stdin !== undefined ? `/tmp/aaspai-stdin-${executionId}` : undefined;
      const command = buildRemoteCommand(remoteCwd, {
        command: ctx.request.command,
        args: ctx.request.args,
        env: ctx.request.env,
        stdinPath: stdinPath,
      });

      const identity: RuntimeExecutionIdentity = {
        executionId,
        provider: "ssh",
        providerLeaseId: ctx.lease.providerLeaseId,
        nativeProcessId: remoteCwd,
      };

      const startedAt = new Date();
      let settled = false;
      let result: RuntimeExecutionResult | undefined;
      const waiters: Array<() => void> = [];

      const run = async (): Promise<void> => {
        if (stdinPath && ctx.request.stdin !== undefined) {
          const stdinValue =
            typeof ctx.request.stdin === "string"
              ? ctx.request.stdin
              : new TextDecoder().decode(ctx.request.stdin);
          await sshExec(
            config,
            `printf '%s' ${shellQuote(stdinValue)} > ${shellQuote(stdinPath)}`,
            { timeoutMs: 15_000 },
          );
        }
        try {
          const resultOut = await sshExec(config, command, {
            timeoutMs: ctx.request.timeoutMs,
            onStdout: (s) => {
              const bytes = new TextEncoder().encode(s);
              stdoutBuffer.append(bytes);
              stdoutStream.push(bytes);
            },
            onStderr: (s) => {
              const bytes = new TextEncoder().encode(s);
              stderrBuffer.append(bytes);
              stderrStream.push(bytes);
            },
          });
          await stdoutStream.close();
          await stderrStream.close();
          const finishedAt = new Date();
          let status: RuntimeExecutionResult["status"] = "completed";
          let terminationReason: RuntimeExecutionResult["terminationReason"] = "exit";
          if ((resultOut.exitCode ?? 0) !== 0) {
            status = "failed";
            terminationReason = "exit";
          }
          if (resultOut.signal === "SIGTERM") {
            status = "timed_out";
            terminationReason = "timeout";
          }
          result = {
            status,
            exitCode: resultOut.exitCode,
            signal: resultOut.signal,
            terminationReason,
            stdoutTail: stdoutBuffer.toUint8Array(),
            stderrTail: stderrBuffer.toUint8Array(),
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            identity,
          };
        } finally {
          if (stdinPath) {
            await sshExec(config, `rm -f ${shellQuote(stdinPath)}`, { timeoutMs: 15_000 }).catch(
              () => undefined,
            );
          }
          settled = true;
          for (const w of waiters) w();
        }
      };

      const runPromise = run();

      return {
        executionId,
        identity,
        async wait() {
          if (settled && result) return result;
          await new Promise<void>((resolve) => waiters.push(resolve));
          await runPromise;
          return result as RuntimeExecutionResult;
        },
        async cancel(_reason) {
          // Not proven: killing the remote process group is not implemented.
          throw runtimeError("EXECUTION_CANCELLED", "ssh cancellation not yet supported");
        },
      };
    },

    async execute(
      ctx: RuntimeStartExecutionContext<SshProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(
      ctx: RuntimeReleaseContext<SshProviderConfig>,
    ): Promise<{ disposition: "retained" | "hibernated" | "destroyed"; warnings?: string[] }> {
      void ctx;
      return { disposition: "destroyed" };
    },

    async destroyLease(
      _ctx: RuntimeDestroyContext<SshProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      return { destroyed: true };
    },
  };
}

export function createSshProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<SshProviderConfig>> {
  try {
    const parsed = sshConfigSchema.parse(input ?? {});
    return Promise.resolve(createSshProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid ssh config",
      error,
    );
  }
}
