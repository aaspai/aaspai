import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Sandbox,
} from "@daytonaio/sdk";
import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import { SdkSandboxDriver, shellQuote, toRunResult } from "../sdk-sandbox-driver.js";

/**
 * Daytona sandboxes are disposable containers whose default login
 * shell doesn't include `/usr/local/bin` in PATH (where `npm install
 * -g` writes binaries). Every command we run needs the explicit
 * PATH so the `opencode` binary is found.
 */
const DEFAULT_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
} as const;

/**
 * Resolve the Daytona API key + URL.
 */
function resolveCredentials(input: { apiKey?: string | null; apiUrl?: string | null }): {
  apiKey: string;
  apiUrl: string | undefined;
} {
  const apiKey = input.apiKey?.trim() || process.env.DAYTONA_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error("daytona sandbox requires an API key in config or DAYTONA_API_KEY env var");
  }
  const apiUrl = input.apiUrl?.trim() || process.env.DAYTONA_API_URL?.trim() || undefined;
  return { apiKey, apiUrl };
}

/**
 * Real Daytona-backed `SandboxDriver`. Uses `@daytonaio/sdk`:
 *   - `new Daytona({apiKey, apiUrl}).create({...})` for `acquire`
 *   - `daytona.get(sandboxId)` for `resume`
 *   - detached processes plus polled output files for streamed `client.run`
 *   - `sandbox.fs.upload/download/list/remove` for the FS methods
 *   - `sandbox.delete()` for `release()` / `destroy()`
 *   - `sandbox.stop()` for `release({ reuseLease: true })`
 */
export class DaytonaSandboxDriver extends SdkSandboxDriver<Sandbox> {
  private daytonaClient: Daytona;
  private readonly defaultImage: string;
  private readonly defaultSnapshot: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly defaultCpu: number | undefined;
  private readonly defaultMemory: number | undefined;

  constructor(
    options: {
      apiKey?: string | null;
      apiUrl?: string | null;
      image?: string;
      snapshot?: string;
      timeoutMs?: number;
      cpu?: number;
      memory?: number;
    } = {},
  ) {
    super("daytona");
    // Defer the API key check to `acquire` so the module loads
    // cleanly even when DAYTONA_API_KEY is not set. Also build the
    // Daytona client lazily at acquire time so it always sees the
    // current process.env (not a snapshot from module load).
    this.configApiKey = options.apiKey ?? null;
    this.configApiUrl = options.apiUrl ?? null;
    this.defaultImage = options.image ?? "debian:12.9";
    this.defaultSnapshot = options.snapshot;
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
    this.defaultCpu = options.cpu;
    this.defaultMemory = options.memory;
    // Initial client with a placeholder; replaced at `acquire` time.
    this.daytonaClient = new Daytona({ apiKey: "placeholder" });
  }

  private configApiKey: string | null;
  private configApiUrl: string | null;

  private getCredentials(): { apiKey: string; apiUrl?: string } {
    return resolveCredentials({
      apiKey: this.configApiKey,
      apiUrl: this.configApiUrl,
    });
  }

  private getClient(): Daytona {
    const creds = this.getCredentials();
    // Rebuild the client if the credentials have changed since
    // construction. This handles the case where the test runner
    // sets DAYTONA_API_KEY after the driver was imported.
    const desired = creds.apiUrl
      ? { apiKey: creds.apiKey, apiUrl: creds.apiUrl }
      : { apiKey: creds.apiKey };
    this.daytonaClient = new Daytona(desired);
    return this.daytonaClient;
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
    reuseLease?: boolean;
  }): Promise<{ raw: Sandbox; remoteCwd: string; metadata: Record<string, unknown> }> {
    // Defer the API key check via getCredentials (throws "API key required").
    // getClient() rebuilds the client so it always sees the current
    // process.env (handles the case where DAYTONA_API_KEY is set
    // after the driver module was imported).
    this.getCredentials();
    const client = this.getClient();
    const attemptId = randomUUID();
    const snapshot = process.env.DAYTONA_SNAPSHOT?.trim() || this.defaultSnapshot;
    const baseParams = {
      ephemeral: input.reuseLease !== true,
      ...(input.reuseLease ? { autoDeleteInterval: -1 } : {}),
      labels: { "aaspai-attempt": attemptId },
    };
    const params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams = snapshot
      ? {
          ...baseParams,
          snapshot,
        }
      : {
          ...baseParams,
          image: this.defaultImage,
          ...(this.defaultCpu !== undefined || this.defaultMemory !== undefined
            ? {
                resources: {
                  ...(this.defaultCpu !== undefined ? { cpu: this.defaultCpu } : {}),
                  ...(this.defaultMemory !== undefined ? { memory: this.defaultMemory } : {}),
                },
              }
            : {}),
        };
    let sandbox: Sandbox;
    let usedSnapshot = Boolean(snapshot);
    try {
      sandbox = await client.create(params, {
        // Daytona SDK expects seconds, not ms
        timeout: Math.ceil((input.timeoutMs ?? this.defaultTimeoutMs) / 1000),
      });
    } catch (error) {
      if (snapshot && error instanceof DaytonaNotFoundError) {
        usedSnapshot = false;
        try {
          sandbox = await client.create(
            { ...baseParams, image: this.defaultImage },
            { timeout: Math.ceil((input.timeoutMs ?? this.defaultTimeoutMs) / 1000) },
          );
        } catch (fallbackError) {
          const leaked = await client
            .list({ "aaspai-attempt": attemptId }, 1, 10)
            .catch(() => null);
          await Promise.all(
            leaked?.items.map((item) => item.delete(60).catch(() => undefined)) ?? [],
          );
          throw fallbackError;
        }
      } else {
        const leaked = await client.list({ "aaspai-attempt": attemptId }, 1, 10).catch(() => null);
        await Promise.all(
          leaked?.items.map((item) => item.delete(60).catch(() => undefined)) ?? [],
        );
        throw error;
      }
    }

    try {
      // Bootstrap the workspace: ensure opencode is installed and the
      // host's auth.json is in place. This is the "one-time setup per
      // lease" cost that mirrors what every cloud sandbox does.
      await this.bootstrapSandbox(sandbox);

      // Resolve working directory
      let remoteCwd = input.remoteCwd;
      try {
        const pwdResult = await sandbox.process.executeCommand("pwd", "/", DEFAULT_ENV, 30);
        const out = (pwdResult.result ?? pwdResult.artifacts?.stdout ?? "").trim();
        remoteCwd = path.posix.join(out.length > 0 ? out : "/", "aaspai-workspace");
      } catch {
        /* keep input.remoteCwd */
      }
      await sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(remoteCwd)}`,
        "/",
        DEFAULT_ENV,
        30,
      );

      return {
        raw: sandbox,
        remoteCwd,
        metadata: {
          sandboxId: sandbox.id,
          remoteCwd,
          state: sandbox.state,
          ...(usedSnapshot ? { snapshot } : { image: this.defaultImage }),
        },
      };
    } catch (error) {
      await sandbox.delete(60).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Bootstrap: install opencode if missing, upload host's auth.json.
   * Idempotent — skips work that's already done.
   */
  private async bootstrapSandbox(sandbox: Sandbox): Promise<void> {
    // 1. Install the bounded baseline used by company agents and evidence checks.
    const baseline = await sandbox.process.executeCommand(
      "command -v git >/dev/null && command -v chromium >/dev/null && command -v curl >/dev/null && command -v ddgr >/dev/null && command -v jq >/dev/null && command -v python3 >/dev/null && command -v rg >/dev/null && test -s /etc/ssl/certs/ca-certificates.crt; echo $?",
      "/",
      DEFAULT_ENV,
      30,
    );
    if ((baseline.result ?? "").trim() !== "0") {
      const install = await sandbox.process.executeCommand(
        "apt-get update -qq && apt-get install -y -qq bash build-essential ca-certificates chromium curl ddgr file git jq openssh-client openssl python3 python3-pip ripgrep rsync unzip wget zip && update-ca-certificates && rm -rf /var/lib/apt/lists/*",
        "/",
        DEFAULT_ENV,
        240,
      );
      if (install.exitCode !== 0) {
        throw new Error("daytona bootstrap failed to install the required tool baseline");
      }
    }

    // 2. Check + install opencode
    const which = await sandbox.process.executeCommand(
      "which opencode || true",
      "/",
      DEFAULT_ENV,
      30,
    );
    const hasOpencode = (which.result ?? "").trim().length > 0;
    if (!hasOpencode) {
      console.log("[daytona] bootstrap: installing opencode-ai (this takes ~30s)...");
      const install = await sandbox.process.executeCommand(
        "npm install -g opencode-ai@1.18.5 2>&1; echo EXIT=$?; which opencode; opencode --version 2>&1 || echo OPENCODE_MISSING",
        "/",
        DEFAULT_ENV,
        240,
      );
      console.log("[daytona] bootstrap: install result:", install.result);
    }
    // Host provider credentials must never enter an agent-controlled sandbox.
    if (process.env.AASPAI_HOST_AUTH_PATH) {
      throw new Error(
        "AASPAI_HOST_AUTH_PATH is not supported for Daytona; use attempt-scoped gateway credentials",
      );
    }
  }

  protected override async reconnect(providerLeaseId: string): Promise<Sandbox | null> {
    try {
      const client = this.getClient();
      const sandbox = await client.get(providerLeaseId);
      if (sandbox.state !== "started") await sandbox.start(Math.ceil(this.defaultTimeoutMs / 1000));
      return sandbox;
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  }

  protected override async destroySandbox(raw: Sandbox): Promise<void> {
    await raw.delete(Math.ceil(this.defaultTimeoutMs / 1000));
  }

  protected override async pauseSandbox(raw: Sandbox): Promise<void> {
    await raw.stop(Math.ceil(this.defaultTimeoutMs / 1000));
  }

  protected override leaseId(raw: Sandbox): string {
    return raw.id;
  }

  protected override buildClient(raw: Sandbox, lease: SandboxLease): SandboxClient {
    const remoteCwd = lease.remoteCwd;
    const uploadContent = async (
      remotePath: string,
      content: string | Uint8Array,
    ): Promise<void> => {
      // Daytona's Buffer overload corrupts binary payloads in SDK v0.171.
      const stagingDir = await mkdtemp(path.join(tmpdir(), "aaspai-daytona-upload-"));
      const stagingPath = path.join(stagingDir, "payload");
      try {
        await writeFile(stagingPath, content);
        await raw.fs.uploadFile(stagingPath, remotePath);
      } finally {
        await rm(stagingDir, { recursive: true, force: true });
      }
    };
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      const sessionId = `aaspai-${randomUUID()}`;
      const runDir = `/tmp/${sessionId}`;
      const stdinPath = options.stdin === undefined ? null : `${runDir}/stdin`;
      const stdoutPath = `${runDir}/stdout`;
      const stderrPath = `${runDir}/stderr`;
      const exitPath = `${runDir}/exit`;
      const pidPath = `${runDir}/pid`;
      const cmdParts = [options.command, ...(options.args ?? [])];
      const quotedParts = cmdParts.map(shellQuote);
      const envInline = Object.entries(options.env ?? {})
        .map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`invalid Daytona environment variable name: ${key}`);
          }
          return `${key}=${shellQuote(value)}`;
        })
        .join(" ");
      const invocation =
        envInline.length > 0 ? `env ${envInline} ${quotedParts.join(" ")}` : quotedParts.join(" ");
      const command = `cd ${shellQuote(options.cwd ?? remoteCwd)} && ${invocation}${
        stdinPath ? ` < ${shellQuote(stdinPath)}` : ""
      }`;
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let stopReason: "aborted" | "timeout" | undefined;
      let abortResolve: (() => void) | undefined;
      const stopped = new Promise<void>((resolve) => {
        abortResolve = resolve;
      });
      const stop = (reason: "aborted" | "timeout") => {
        if (stopReason) return;
        stopReason = reason;
        abortResolve?.();
      };
      const onAbort = () => stop("aborted");

      if (options.signal?.aborted) stop("aborted");
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutHandle = setTimeout(() => stop("timeout"), timeoutMs);
      timeoutHandle.unref();

      try {
        await raw.process.executeCommand(`mkdir -p ${shellQuote(runDir)}`, "/", DEFAULT_ENV, 30);
        if (stdinPath) {
          await uploadContent(stdinPath, Buffer.from(options.stdin ?? "", "utf8"));
        }
        const childScript = `${command}; code=$?; printf '%s' "$code" > ${shellQuote(exitPath)}`;
        const launch = [
          `setsid sh -lc ${shellQuote(childScript)}`,
          `> ${shellQuote(stdoutPath)}`,
          `2> ${shellQuote(stderrPath)}`,
          "< /dev/null",
          `& echo $! > ${shellQuote(pidPath)}`,
        ].join(" ");
        const launched = await raw.process.executeCommand(launch, "/", DEFAULT_ENV, 30);
        if (launched.exitCode !== 0) {
          throw new Error(launched.result || "daytona failed to launch command");
        }
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let pendingLogs = Promise.resolve();
        const emit = (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout += chunk;
          else stderr += chunk;
          pendingLogs = pendingLogs.then(async () => {
            await options.onLog?.(stream, chunk);
          });
        };
        const drain = async () => {
          for (const [stream, remotePath] of [
            ["stdout", stdoutPath],
            ["stderr", stderrPath],
          ] as const) {
            const content = await raw.fs.downloadFile(remotePath).catch(() => Buffer.alloc(0));
            const buffer = Buffer.from(content);
            const offset = stream === "stdout" ? stdoutBytes : stderrBytes;
            if (buffer.length > offset) {
              const decoder = stream === "stdout" ? stdoutDecoder : stderrDecoder;
              const chunk = decoder.write(buffer.subarray(offset));
              if (chunk) emit(stream, chunk);
            }
            if (stream === "stdout") stdoutBytes = buffer.length;
            else stderrBytes = buffer.length;
          }
        };
        const flushDecoders = () => {
          const stdoutTail = stdoutDecoder.end();
          const stderrTail = stderrDecoder.end();
          if (stdoutTail) emit("stdout", stdoutTail);
          if (stderrTail) emit("stderr", stderrTail);
        };

        let exitCode: number | null = null;
        while (!stopReason) {
          await drain();
          const status = await raw.process.executeCommand(
            `test -f ${shellQuote(exitPath)} && cat ${shellQuote(exitPath)} || true`,
            "/",
            DEFAULT_ENV,
            30,
          );
          const value = (status.result ?? "").trim();
          if (/^\d+$/.test(value)) {
            exitCode = Number(value);
            break;
          }
          await Promise.race([delay(250), stopped]);
        }
        if (stopReason) {
          const pidResult = await raw.process.executeCommand(
            `cat ${shellQuote(pidPath)} 2>/dev/null || true`,
            "/",
            DEFAULT_ENV,
            30,
          );
          const pid = (pidResult.result ?? "").trim();
          if (/^\d+$/.test(pid)) {
            await raw.process
              .executeCommand(
                `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null || true`,
                "/",
                DEFAULT_ENV,
                30,
              )
              .catch(() => undefined);
          }
          await delay(250);
          await drain();
          flushDecoders();
          await pendingLogs;
          return toRunResult({
            exitCode: null,
            signal: "SIGTERM",
            timedOut: stopReason === "timeout",
            stdout,
            stderr,
            startedAt,
          });
        }
        await drain();
        flushDecoders();
        await pendingLogs;
        return toRunResult({
          exitCode,
          stdout,
          stderr,
          startedAt,
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        await raw.process
          .executeCommand(`rm -rf -- ${shellQuote(runDir)}`, "/", DEFAULT_ENV, 30)
          .catch(() => undefined);
      }
    };

    return {
      async makeDir(remotePath, options) {
        await sandboxExec(
          raw,
          `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}`,
          { cwd: remoteCwd },
        );
      },
      async writeFile(remotePath, content) {
        await uploadContent(remotePath, content);
      },
      async readFile(remotePath) {
        return await raw.fs.downloadFile(remotePath);
      },
      async listFiles(remotePath) {
        const r = await sandboxExec(
          raw,
          `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
          { cwd: remoteCwd },
        );
        return r.stdout
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((line) => {
            const [name, sizeStr, typeChar] = line.split("|");
            return {
              name: name ?? "",
              size: Number.parseInt(sizeStr ?? "0", 10),
              isDir: typeChar === "d",
            };
          });
      },
      async remove(remotePath, options) {
        await sandboxExec(
          raw,
          `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(remotePath)}`,
          { cwd: remoteCwd },
        );
      },
      run: execCommand,
    };
  }
}

type ExecResult = { exitCode: number | null; stdout: string; stderr: string };

async function sandboxExec(
  sandbox: Sandbox,
  command: string,
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  // Daytona's executeCommand signature: (command, cwd?, env?, timeout?)
  // timeout is in seconds here.
  const timeoutSec =
    options.timeoutMs !== undefined ? Math.ceil(options.timeoutMs / 1000) : undefined;
  const env = { ...DEFAULT_ENV, ...(options.env ?? {}) };
  const result = await sandbox.process.executeCommand(command, options.cwd, env, timeoutSec);
  return {
    exitCode: result.exitCode,
    stdout: result.result ?? result.artifacts?.stdout ?? "",
    stderr: "",
  };
}
