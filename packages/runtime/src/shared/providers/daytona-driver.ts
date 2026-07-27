import path from "node:path";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { CreateSandboxFromImageParams, Sandbox } from "@daytonaio/sdk";
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
 *   - `sandbox.process.executeCommand(...)` for `client.run`
 *   - `sandbox.fs.upload/download/list/remove` for the FS methods
 *   - `sandbox.delete()` for `release()` / `destroy()`
 *   - `sandbox.stop()` for `release({ reuseLease: true })`
 */
export class DaytonaSandboxDriver extends SdkSandboxDriver<Sandbox> {
  private daytonaClient: Daytona;
  private readonly defaultImage: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultCpu: number | undefined;
  private readonly defaultMemory: number | undefined;

  constructor(
    options: {
      apiKey?: string | null;
      apiUrl?: string | null;
      image?: string;
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
  }): Promise<{ raw: Sandbox; remoteCwd: string; metadata: Record<string, unknown> }> {
    // Defer the API key check via getCredentials (throws "API key required").
    // getClient() rebuilds the client so it always sees the current
    // process.env (handles the case where DAYTONA_API_KEY is set
    // after the driver module was imported).
    this.getCredentials();
    const client = this.getClient();
    const params: CreateSandboxFromImageParams = {
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
    const sandbox = await client.create(params, {
      // Daytona SDK expects seconds, not ms
      timeout: Math.ceil((input.timeoutMs ?? this.defaultTimeoutMs) / 1000),
    });

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
    await sandbox.process.executeCommand(`mkdir -p ${shellQuote(remoteCwd)}`, "/", DEFAULT_ENV, 30);

    return {
      raw: sandbox,
      remoteCwd,
      metadata: {
        sandboxId: sandbox.id,
        remoteCwd,
        state: sandbox.state,
        image: this.defaultImage,
      },
    };
  }

  /**
   * Bootstrap: install opencode if missing, upload host's auth.json.
   * Idempotent — skips work that's already done.
   */
  private async bootstrapSandbox(sandbox: Sandbox): Promise<void> {
    // 1. Check + install opencode
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
        "npm install -g opencode-ai 2>&1; echo EXIT=$?; which opencode; opencode --version 2>&1 || echo OPENCODE_MISSING",
        "/",
        DEFAULT_ENV,
        240,
      );
      console.log("[daytona] bootstrap: install result:", install.result);
    }
    // 2. Upload host's auth.json if available
    if (process.env.AASPAI_HOST_AUTH_PATH) {
      try {
        const { readFileSync } = await import("node:fs");
        const auth = readFileSync(process.env.AASPAI_HOST_AUTH_PATH, "utf8");
        await sandbox.fs.uploadFile(
          Buffer.from(auth, "utf8"),
          "/root/.local/share/opencode/auth.json",
        );
      } catch {
        /* best effort */
      }
    }
  }

  protected override async reconnect(providerLeaseId: string): Promise<Sandbox | null> {
    try {
      const client = this.getClient();
      return await client.get(providerLeaseId);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  }

  protected override async destroySandbox(raw: Sandbox): Promise<void> {
    await raw.delete(Math.ceil(this.defaultTimeoutMs / 1000));
  }

  protected override async pauseSandbox(raw: Sandbox): Promise<void> {
    // Daytona's stop happens via `setStopInterval` or via `stop()`.
    // In the v0.171 SDK we use the autoStop interval as the pause primitive.
    raw.setAutostopInterval(15);
  }

  protected override leaseId(raw: Sandbox): string {
    return raw.id;
  }

  protected override buildClient(raw: Sandbox, lease: SandboxLease): SandboxClient {
    const remoteCwd = lease.remoteCwd;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      // Daytona's executeCommand runs the command in a subshell, so we
      // don't need the login-profile wrapper that buildLoginShellScript
      // adds (and that wrapper's long `if/fi && if/fi && ...` chain
      // confuses bash when joined as a single line). Just inline PATH
      // and exec the command directly.
      const cmdParts = [options.command, ...(options.args ?? [])];
      const quotedParts = cmdParts.map(shellQuote);
      const envInline = Object.entries(options.env ?? {})
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      const script =
        envInline.length > 0 ? `env ${envInline} ${quotedParts.join(" ")}` : quotedParts.join(" ");
      const result = await sandboxExec(raw, script, {
        cwd: remoteCwd,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
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
        await sandboxExec(
          raw,
          `mkdir ${options?.recursive === false ? "" : "-p"} ${shellQuote(remotePath)}`,
          { cwd: remoteCwd },
        );
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        await raw.fs.uploadFile(Buffer.from(text, "utf8"), remotePath);
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
