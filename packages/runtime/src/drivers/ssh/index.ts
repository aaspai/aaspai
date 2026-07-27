import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunProcessOptions,
  RunProcessResult,
  SshExecutionTarget,
} from "@aaspai/contracts/runtime";
import { runProcess } from "@aaspai/harness";
import type { RuntimeTarget } from "../../shared/execution-target.js";
import { shellQuote } from "../../shared/shell.js";

/**
 * Resolve the path to the `ssh` and `scp` binaries on the host.
 * On Windows, the OpenSSH client is at `C:\Windows\System32\OpenSSH\`.
 */
function resolveSshBinary(name: "ssh" | "scp"): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", `${name}.exe`);
  }
  return `/usr/bin/${name}`;
}

/**
 * Throws if the user did not set `AASPAI_SSH_HOST`. Tests can call
 * this to skip the SSH target gracefully.
 */
export class SshNotConfiguredError extends Error {
  readonly code = "AASPAI_SSH_NOT_CONFIGURED";
  constructor() {
    super(
      "sshTarget requires AASPAI_SSH_HOST (and optionally AASPAI_SSH_USER, AASPAI_SSH_PORT, AASPAI_SSH_KEY). " +
        "Set them to run the SSH scenarios; otherwise the test runner will mark SSH as 'skipped: no host configured'.",
    );
    this.name = "SshNotConfiguredError";
  }
}

export function isSshConfigured(): boolean {
  return Boolean(process.env.AASPAI_SSH_HOST);
}

/**
 * Build the `ssh` argv for a remote command. Honors `privateKey`,
 * `port`, `strictHostKeyChecking`, and `knownHosts` from the target.
 */
function buildSshArgs(target: SshExecutionTarget, command: string): string[] {
  const args: string[] = [];
  if (target.port !== 22) args.push("-p", String(target.port));
  if (target.privateKey) args.push("-i", target.privateKey);
  if (target.strictHostKeyChecking === false) {
    args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
  } else if (target.knownHosts) {
    args.push("-o", `UserKnownHostsFile=${target.knownHosts}`);
  }
  args.push("-o", "BatchMode=yes", "-o", "LogLevel=ERROR");
  args.push(`${target.username}@${target.host}`);
  // Everything after the destination is the remote command. Do not pass
  // `-c`; OpenSSH parses it as its own cipher option even after the host.
  args.push(command);
  return args;
}

function buildScpSecurityArgs(target: SshExecutionTarget): string[] {
  return [
    "-P",
    String(target.port),
    ...(target.privateKey ? ["-i", target.privateKey] : []),
    ...(target.strictHostKeyChecking === false
      ? ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]
      : target.knownHosts
        ? ["-o", `UserKnownHostsFile=${target.knownHosts}`]
        : []),
    "-o",
    "BatchMode=yes",
  ];
}

/**
 * Run a process on a remote host over SSH. Returns the same shape as
 * a local `RunProcessResult`. Streams stdout/stderr through `onLog`.
 *
 * Round-trips the local cwd to a remote tempdir before each call
 * (using `scp -r`), runs the command there, then cleans up.
 */
async function runOverSsh(
  target: SshExecutionTarget,
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const sshBin = resolveSshBinary("ssh");
  const scpBin = resolveSshBinary("scp");
  const startedAt = new Date();

  // 1. Create a fresh remote workspace dir
  const remoteBase = target.remoteCwd ?? "/tmp/aaspai";
  const mkTmpCmd =
    `mkdir -p ${shellQuote(remoteBase)} && ` +
    `mktemp -d ${shellQuote(`${remoteBase.replace(/\/+$/, "")}/aaspai-ssh-XXXXXX`)}`;
  const mkArgs = buildSshArgs(target, mkTmpCmd);
  const mkChild = spawn(sshBin, mkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal: options.signal,
  });
  const mkOut: Buffer[] = [];
  const mkErr: Buffer[] = [];
  mkChild.stdout.on("data", (b: Buffer) => mkOut.push(b));
  mkChild.stderr.on("data", (b: Buffer) => mkErr.push(b));
  const mkExit: number = await new Promise((res, rej) => {
    mkChild.on("error", rej);
    mkChild.on("close", (code) => res(code ?? 1));
  });
  if (mkExit !== 0) {
    return {
      exitCode: mkExit,
      timedOut: false,
      stdout: "",
      stderr: Buffer.concat(mkErr).toString("utf8"),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  }
  const remoteWorkdir = Buffer.concat(mkOut).toString("utf8").trim();
  if (!remoteWorkdir) {
    return {
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "ssh returned an empty remote workspace path",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  try {
    // 2. If `options.cwd` is set, sync it to remoteWorkdir (best effort)
    if (options.cwd) {
      const scpArgs = [
        ...buildScpSecurityArgs(target),
        "-r",
        `${options.cwd}/.`,
        `${target.username}@${target.host}:${remoteWorkdir}/`,
      ];
      await new Promise<void>((res, rej) => {
        const c = spawn(scpBin, scpArgs, {
          stdio: "ignore",
          windowsHide: true,
          signal: options.signal,
        });
        c.on("close", (code) => (code === 0 ? res() : rej(new Error(`scp exited ${code}`))));
        c.on("error", rej);
      });
    }

    // 3. Run the actual command remotely
    const cmd =
      options.args.length === 0
        ? options.command
        : `${options.command} ${options.args.map(shellQuote).join(" ")}`;
    const remotePidFile = `${remoteWorkdir}/.aaspai-remote-pid`;
    const tracked = `cd ${shellQuote(remoteWorkdir)} && printf '%s' "$$" > ${shellQuote(remotePidFile)} && exec ${cmd}`;
    const runArgs = buildSshArgs(target, tracked);

    return await new Promise<RunProcessResult>((resolve) => {
      const child = spawn(sshBin, runArgs, {
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal: options.signal,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timeoutHandle: NodeJS.Timeout | undefined;
      let closed = false;
      const terminate = (sig: NodeJS.Signals): void => {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      };
      if (options.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => terminate("SIGTERM"), options.timeoutMs);
        timeoutHandle.unref();
      }
      child.stdout?.on("data", (b: Buffer) => {
        stdoutChunks.push(b);
        const s = b.toString("utf8");
        if (options.onLog) Promise.resolve(options.onLog("stdout", s)).catch(() => undefined);
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderrChunks.push(b);
        const s = b.toString("utf8");
        if (options.onLog) Promise.resolve(options.onLog("stderr", s)).catch(() => undefined);
      });
      child.on("close", (code, signal) => {
        closed = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        const finishedAt = new Date();
        void runProcess({
          command: sshBin,
          args: buildSshArgs(target, `cat ${shellQuote(remotePidFile)}`),
          timeoutMs: 5_000,
        }).then((pidResult) => {
          const remotePid = Number.parseInt(pidResult.stdout.trim(), 10);
          resolve({
            exitCode: code,
            signal: signal ?? undefined,
            timedOut: signal === "SIGTERM",
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            runtimeIdentity: {
              kind: "ssh",
              cwd: remoteWorkdir,
              host: target.host,
              remoteCwd: remoteWorkdir,
              connectionIdentity: `${target.username}@${target.host}:${target.port}`,
              ...(Number.isInteger(remotePid) && remotePid > 0 ? { remotePid } : {}),
            },
          });
        });
      });
      void closed;
    });
  } finally {
    // 4. Restore the assigned workspace before removing the remote lease.
    if (options.cwd) {
      const restoreArgs = [
        ...buildScpSecurityArgs(target),
        "-r",
        `${target.username}@${target.host}:${remoteWorkdir}/.`,
        `${options.cwd}/`,
      ];
      await new Promise<void>((resolve) => {
        const c = spawn(scpBin, restoreArgs, { stdio: "ignore", windowsHide: true });
        c.on("close", () => resolve());
        c.on("error", () => resolve());
      });
    }
    // 5. Clean up the remote tempdir (best effort)
    const cleanupArgs = buildSshArgs(target, `rm -rf ${shellQuote(remoteWorkdir)}`);
    spawn(sshBin, cleanupArgs, { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
  }
}

/**
 * Build an `SshExecutionTarget` from the `AASPAI_SSH_*` env vars.
 * If `AASPAI_SSH_HOST` is not set, throws `SshNotConfiguredError`.
 */
export function sshTargetFromEnv(): SshExecutionTarget {
  if (!isSshConfigured()) throw new SshNotConfiguredError();
  const host = process.env.AASPAI_SSH_HOST;
  if (!host) throw new SshNotConfiguredError();
  const port = Number.parseInt(process.env.AASPAI_SSH_PORT ?? "22", 10);
  const username = process.env.AASPAI_SSH_USER ?? "root";
  const privateKey = process.env.AASPAI_SSH_KEY;
  const remoteCwd = process.env.AASPAI_SSH_REMOTE_CWD ?? "/tmp/aaspai";
  return {
    kind: "ssh",
    host,
    port,
    username,
    ...(privateKey ? { privateKey } : {}),
    remoteCwd,
    strictHostKeyChecking: process.env.AASPAI_SSH_STRICT !== "false",
    shellCommand: (process.env.AASPAI_SSH_SHELL as "bash" | "sh" | undefined) ?? "bash",
  };
}

/**
 * Singleton SSH target. The first call to `run`/`prepareWorkspace` will
 * read the AASPAI_SSH_* env vars to build an `SshExecutionTarget`.
 */
export const sshTarget: RuntimeTarget = {
  info: {
    kind: "ssh",
    label: "SSH (remote host)",
    status: "ready",
    capabilities: {
      execute: true,
      streaming: true,
      cancellation: true,
      timeout: true,
      workspaceIsolation: true,
      restore: true, // scp round-trip supports restore
      resume: true,
      artifacts: true,
    },
  },
  async readiness(target) {
    if (target.kind !== "ssh") return { ready: false, reason: "wrong target kind" };
    const result = await runProcess({
      command: resolveSshBinary("ssh"),
      args: buildSshArgs(target, "true"),
      timeoutMs: 10_000,
    });
    return result.exitCode === 0
      ? { ready: true }
      : { ready: false, reason: result.stderr || "SSH connectivity check failed" };
  },
  async run(target, options) {
    if (target.kind !== "ssh") {
      throw new Error(`sshTarget cannot run a ${target.kind} target.`);
    }
    return await runOverSsh(target, options);
  },
  async prepareWorkspace(target, { localDir, remoteDir }) {
    if (target.kind !== "ssh") throw new Error("sshTarget only.");
    const scpBin = resolveSshBinary("scp");
    const args = [
      ...buildScpSecurityArgs(target),
      "-r",
      `${localDir}/.`,
      `${target.username}@${target.host}:${remoteDir}/`,
    ];
    return await new Promise<void>((res, rej) => {
      const c = spawn(scpBin, args, { stdio: "ignore", windowsHide: true });
      c.on("close", (code) => (code === 0 ? res() : rej(new Error(`scp exited ${code}`))));
      c.on("error", rej);
    });
  },
  async restoreWorkspace(target, { localDir, remoteDir }) {
    if (target.kind !== "ssh") throw new Error("sshTarget only.");
    const scpBin = resolveSshBinary("scp");
    const args = [
      ...buildScpSecurityArgs(target),
      "-r",
      `${target.username}@${target.host}:${remoteDir}/.`,
      `${localDir}/`,
    ];
    return await new Promise<void>((res, rej) => {
      const c = spawn(scpBin, args, { stdio: "ignore", windowsHide: true });
      c.on("close", (code) => (code === 0 ? res() : rej(new Error(`scp exited ${code}`))));
      c.on("error", rej);
    });
  },
};

/**
 * Write a one-line SSH keyfile from an env var (used for tests that
 * have the key in env, not on disk).
 */
export async function writeSshKeyFromEnv(): Promise<string | undefined> {
  const key = process.env.AASPAI_SSH_KEY_CONTENT;
  if (!key) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "aaspai-ssh-"));
  const path = join(dir, "id_ed25519");
  await writeFile(path, key, { mode: 0o600 });
  return path;
}

/** Test helper: clear all temp dirs we created. */
export async function rmSshKeyFile(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}
