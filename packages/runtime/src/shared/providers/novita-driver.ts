import { Sandbox } from "novita-sandbox";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import {
  SdkSandboxDriver,
  buildLoginShellScript,
  shellQuote,
  toRunResult,
} from "../sdk-sandbox-driver.js";

/**
 * Resolve the Novita API key.
 */
function resolveApiKey(input: { configApiKey?: string | null }): string {
  const fromConfig = input.configApiKey?.trim() ?? "";
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.NOVITA_API_KEY?.trim() ?? "";
  if (!fromEnv) {
    throw new Error("novita sandbox requires an API key in config or NOVITA_API_KEY env var");
  }
  return fromEnv;
}

/**
 * Real Novita-backed `SandboxDriver`. Uses `novita-sandbox` SDK:
 *   - `Sandbox.create(template, opts)` for `acquire`
 *   - `Sandbox.connect(sandboxId, opts)` for `resume`
 *   - `sandbox.commands.run(...)` for `client.run`
 *   - `sandbox.betaPause()` for `release({ reuseLease: true })`
 *   - `sandbox.kill()` for `release()` / `destroy()`
 */
export class NovitaSandboxDriver extends SdkSandboxDriver<Sandbox> {
  private readonly defaultTemplate: string;
  private readonly timeoutMs: number;
  private readonly configApiKey: string | null;

  constructor(options: { template?: string; timeoutMs?: number; apiKey?: string | null } = {}) {
    super("novita");
    this.defaultTemplate = options.template ?? "shellx-aliyun";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.configApiKey = options.apiKey ?? null;
  }

  private getOpts() {
    return {
      apiKey: resolveApiKey({ configApiKey: this.configApiKey }),
      timeoutMs: this.timeoutMs,
      requestTimeoutMs: 30_000,
    };
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: Sandbox; remoteCwd: string; metadata: Record<string, unknown> }> {
    // Defer the API key check via getOpts.
    const opts = this.getOpts();
    const sandbox = await Sandbox.create(this.defaultTemplate, opts);
    const remoteCwd = input.remoteCwd ?? "/home/user/aaspai-workspace";
    await sandbox.commands.run(`mkdir -p ${shellQuote(remoteCwd)}`);
    return {
      raw: sandbox,
      remoteCwd,
      metadata: {
        sandboxId: sandbox.sandboxId,
        template: this.defaultTemplate,
        remoteCwd,
      },
    };
  }

  protected override async reconnect(providerLeaseId: string): Promise<Sandbox | null> {
    try {
      return await Sandbox.connect(providerLeaseId, this.getOpts());
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "SandboxNotFoundError" || name === "NotFoundError") return null;
      throw error;
    }
  }

  protected override async destroySandbox(raw: Sandbox): Promise<void> {
    await raw.kill({ requestTimeoutMs: 30_000 });
  }

  protected override async pauseSandbox(raw: Sandbox): Promise<void> {
    // Novita's betaPause; fall back to kill on failure
    try {
      await (raw as unknown as { betaPause: (o: { requestTimeoutMs: number }) => Promise<void> })
        .betaPause({ requestTimeoutMs: 30_000 });
    } catch {
      await raw.kill({ requestTimeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  protected override leaseId(raw: Sandbox): string {
    return raw.sandboxId;
  }

  protected override buildClient(raw: Sandbox, lease: SandboxLease): SandboxClient {
    const remoteCwd = lease.remoteCwd;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      // Refresh timeout
      try {
        await raw.setTimeout(this.timeoutMs, { requestTimeoutMs: 30_000 });
      } catch {
        /* best effort */
      }
      const script = buildLoginShellScript({
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
      const result = await raw.commands.run(script, {
        cwd: remoteCwd,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
      });
      return toRunResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
      });
    };

    return {
      async makeDir(remotePath, options) {
        await raw.commands.run(
          `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}`,
        );
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        await (raw as unknown as {
          files: { write: (p: string, c: string) => Promise<unknown> };
        }).files.write(remotePath, text);
      },
      async readFile(remotePath) {
        const text = await (raw as unknown as {
          files: { read: (p: string) => Promise<string> };
        }).files.read(remotePath);
        return Buffer.from(text, "utf8");
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
