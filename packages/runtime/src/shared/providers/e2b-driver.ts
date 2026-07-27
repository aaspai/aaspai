import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CommandExitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
  type CommandResult,
} from "e2b";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import {
  SdkSandboxDriver,
  buildLoginShellScript,
  shellQuote,
  toRunResult,
} from "../sdk-sandbox-driver.js";

/**
 * Resolve the e2b API key from the execution target metadata or
 * the E2B_API_KEY env var. Throws a clear error if neither is set.
 */
function resolveApiKey(input: { configApiKey?: string | null }): string {
  const fromConfig = input.configApiKey?.trim() ?? "";
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.E2B_API_KEY?.trim() ?? "";
  if (fromEnv) return fromEnv;
  throw new Error("e2b sandbox requires an API key in config or E2B_API_KEY env var");
}

/**
 * Real e2b-backed `SandboxDriver`. Uses the official `e2b` SDK:
 *   - `Sandbox.create(template, options)` for `acquire`
 *   - `Sandbox.connect(sandboxId, options)` for `resume`
 *   - `sandbox.commands.run(...)` for `client.run`
 *   - `sandbox.files.write/read/list/remove` for the FS methods
 *   - `sandbox.pause()` for `release({ reuseLease: true })`
 *   - `sandbox.kill()` for `release()` / `destroy()`
 *
 * The providerLeaseId is the e2b sandbox id; resume reconnects
 * via `Sandbox.connect`.
 */
export class E2bSandboxDriver extends SdkSandboxDriver<Sandbox> {
  private readonly defaultTimeoutMs: number;
  private readonly defaultTemplate: string;
  private readonly configApiKey: string | null;

  constructor(options: { template?: string; timeoutMs?: number; apiKey?: string | null } = {}) {
    super("e2b");
    this.defaultTemplate = options.template ?? "base";
    this.defaultTimeoutMs = options.timeoutMs ?? 3_600_000;
    this.configApiKey = options.apiKey ?? null;
  }

  private getApiKey(): string {
    return resolveApiKey({ configApiKey: this.configApiKey });
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: Sandbox; remoteCwd: string; metadata: Record<string, unknown> }> {
    // Defer the API key check to here so the module loads cleanly
    // even when E2B_API_KEY is not set.
    const apiKey = this.getApiKey();
    const sandbox = await Sandbox.create(this.defaultTemplate, {
      apiKey,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      metadata: { paperclipProvider: "e2b", aaspaiProvider: "e2b" },
    });
    // Resolve the working directory inside the sandbox
    const pwdResult = await sandbox.commands.run("pwd");
    const pwdOut = pwdResult.stdout?.trim() ?? "";
    const remoteCwd = path.posix.join(pwdOut.length > 0 ? pwdOut : "/", "aaspai-workspace");
    await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`);
    return {
      raw: sandbox,
      remoteCwd,
      metadata: {
        template: this.defaultTemplate,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
        sandboxId: sandbox.sandboxId,
        sandboxDomain: sandbox.sandboxDomain,
        remoteCwd,
      },
    };
  }

  protected override async reconnect(providerLeaseId: string): Promise<Sandbox | null> {
    try {
      return await Sandbox.connect(providerLeaseId, {
        apiKey: this.getApiKey(),
        timeoutMs: this.defaultTimeoutMs,
      });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }
  }

  protected override async destroySandbox(raw: Sandbox): Promise<void> {
    await raw.kill();
  }

  protected override async pauseSandbox(raw: Sandbox): Promise<void> {
    await raw.pause();
  }

  protected override leaseId(raw: Sandbox): string {
    return raw.sandboxId;
  }

  protected override buildClient(raw: Sandbox, lease: SandboxLease): SandboxClient {
    const remoteCwd = lease.remoteCwd;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      // Refresh the sandbox death clock on every command. E2B's
      // `timeoutMs` is the absolute lifetime; without refresh, a
      // long run will be killed mid-command.
      try {
        await raw.setTimeout(this.defaultTimeoutMs);
      } catch {
        /* best effort */
      }

      // For stdin, stage to a temp file (avoids races with fast
      // commands; mirrors paperclip's pattern).
      let stagedStdinPath: string | null = null;
      if (options.stdin != null) {
        stagedStdinPath = `/tmp/aaspai-stdin-${randomUUID()}`;
        try {
          await raw.files.write(stagedStdinPath, options.stdin);
        } catch (err) {
          await raw.files.remove(stagedStdinPath).catch(() => undefined);
          throw err;
        }
      }

      const baseCommand = buildLoginShellScript({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(stagedStdinPath ? { stdinRedirect: stagedStdinPath } : {}),
      });
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

      try {
        const result = (await raw.commands.run(baseCommand, {
          cwd: remoteCwd,
          timeoutMs,
        })) as CommandResult;
        return toRunResult({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
        });
      } catch (error) {
        if (error instanceof CommandExitError) {
          return toRunResult({
            exitCode: error.exitCode,
            stdout: error.stdout,
            stderr: error.stderr,
            startedAt,
          });
        }
        if (error instanceof TimeoutError) {
          const errObj = error as unknown as { stdout?: string; stderr?: string; message?: string };
          return toRunResult({
            exitCode: null,
            stdout: errObj.stdout ?? "",
            stderr: errObj.stderr ?? (errObj.message ? `${errObj.message}\n` : ""),
            timedOut: true,
            signal: "SIGTERM",
            startedAt,
          });
        }
        throw error;
      } finally {
        if (stagedStdinPath) {
          await raw.files.remove(stagedStdinPath).catch(() => undefined);
        }
      }
    };

    return {
      async makeDir(remotePath, options) {
        await raw.commands.run(
          `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}`,
        );
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        await raw.files.write(remotePath, text);
      },
      async readFile(remotePath) {
        // e2b's files.read returns the bytes; we return as Buffer
        const r = (await raw.files.read(remotePath)) as ArrayBuffer | string | Buffer;
        if (typeof r === "string") return Buffer.from(r, "utf8");
        if (Buffer.isBuffer(r)) return r;
        return Buffer.from(new Uint8Array(r));
      },
      async listFiles(remotePath) {
        const r = await raw.commands.run(
          `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
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
        await raw.commands.run(
          `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(remotePath)}`,
        );
      },
      run: execCommand,
    };
  }
}
