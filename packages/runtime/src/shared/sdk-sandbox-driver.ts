import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxDriver, SandboxLease } from "./sandbox-client.js";

/**
 * Abstract base for SDK-backed `SandboxDriver` implementations.
 * Each cloud provider extends this with its own SDK calls:
 *   - e2b:    `Sandbox.create()` / `commands.run()` / `files.*` / `kill()`
 *   - daytona:`Daytona.create()` / `process.executeCommand()` / `fs.*` / `delete()`
 *   - modal:  `ModalClient().sandboxes.create()` / `exec()` / `open()` / `terminate()`
 *   - novita: `Sandbox.create()` / `commands.run()` / `kill()` / `betaPause()`
 *   - exe-dev: REST `POST https://exe.dev/exec` + SSH
 *   - cloudflare: REST `fetch` to a deployed Worker template
 *   - kubernetes: `k8sApi.createNamespacedPod()` / `connectGetNamespacedPodExec()` / `deleteNamespacedPod()`
 *
 * The base tracks active leases and provides the 6-method `SandboxClient`
 * surface that the rest of the runtime already speaks.
 */
export abstract class SdkSandboxDriver<TRawSandbox> implements SandboxDriver {
  protected readonly activeLeases = new Map<string, TRawSandbox>();
  protected readonly providerLabel: string;

  constructor(protected readonly providerKey: string) {
    this.providerLabel = `sandbox.${providerKey}`;
  }

  /**
   * Subclass: create a new sandbox. Returns the SDK object AND
   * the metadata to record on the lease (remoteCwd, shellCommand, etc.).
   */
  protected abstract createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: TRawSandbox; remoteCwd: string; metadata: Record<string, unknown> }>;

  /**
   * Subclass: reconnect to an existing sandbox by providerLeaseId.
   * Return null if the lease is gone.
   */
  protected abstract reconnect(providerLeaseId: string): Promise<TRawSandbox | null>;

  /**
   * Subclass: destroy the sandbox for good (always; regardless of reuseLease).
   */
  protected abstract destroySandbox(raw: TRawSandbox): Promise<void>;

  /**
   * Subclass: pause the sandbox (e2b/novita have a real pause primitive).
   * Default: fall back to destroy.
   */
  protected async pauseSandbox(_raw: TRawSandbox): Promise<void> {
    /* default: nothing — release should fall through to destroy */
  }

  /**
   * Subclass: the 6-method `SandboxClient` for this lease. The
   * `run` method here is the heart of the driver — it shells
   * out inside the sandbox and returns a `RunProcessResult`.
   */
  protected abstract buildClient(raw: TRawSandbox, lease: SandboxLease): SandboxClient;

  /** Build a stable lease id from the SDK's native id. */
  protected abstract leaseId(raw: TRawSandbox): string;

  // ───── public API ─────

  async acquire(remoteCwd: string, options?: { timeoutMs?: number }): Promise<SandboxLease> {
    const created = await this.createSandbox({
      remoteCwd,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const providerLeaseId = this.leaseId(created.raw);
    this.activeLeases.set(providerLeaseId, created.raw);
    return {
      providerLeaseId,
      remoteCwd: created.remoteCwd,
      metadata: { ...created.metadata, provider: this.providerKey },
    };
  }

  async resume(providerLeaseId: string): Promise<SandboxLease | null> {
    const raw = await this.reconnect(providerLeaseId);
    if (!raw) return null;
    this.activeLeases.set(providerLeaseId, raw);
    const remoteCwd = ((raw as { workingDir?: string }).workingDir ?? "/") as string;
    return {
      providerLeaseId,
      remoteCwd,
      metadata: { provider: this.providerKey, resumed: true },
    };
  }

  async release(lease: SandboxLease, options?: { reuseLease?: boolean }): Promise<void> {
    const raw = this.activeLeases.get(lease.providerLeaseId);
    if (!raw) return;
    this.activeLeases.delete(lease.providerLeaseId);
    if (options?.reuseLease) {
      try {
        await this.pauseSandbox(raw);
        return;
      } catch {
        // fall through to destroy
      }
    }
    await this.destroySandbox(raw).catch(() => undefined);
  }

  async destroy(providerLeaseId: string): Promise<void> {
    const raw = this.activeLeases.get(providerLeaseId);
    if (!raw) return;
    this.activeLeases.delete(providerLeaseId);
    await this.destroySandbox(raw).catch(() => undefined);
  }

  client(lease: SandboxLease): SandboxClient {
    const raw = this.activeLeases.get(lease.providerLeaseId);
    if (!raw) {
      throw new Error(`${this.providerLabel}: unknown lease ${lease.providerLeaseId}`);
    }
    return this.buildClient(raw, lease);
  }

  /** For tests: how many sandboxes are currently leased. */
  activeCount(): number {
    return this.activeLeases.size;
  }
}

/**
 * Convert a "result with stdout/stderr" shape to our `RunProcessResult`.
 * Used by every SDK-backed `run` implementation so they don't have
 * to repeat the boilerplate.
 */
export function toRunResult(input: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  signal?: string;
  timedOut?: boolean;
  pid?: number;
  startedAt: Date;
}): RunProcessResult {
  const finishedAt = new Date();
  return {
    exitCode: input.exitCode,
    ...(input.signal ? { signal: input.signal } : {}),
    timedOut: input.timedOut ?? false,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
  };
}

/**
 * Wrap a command + args as a single shell-escaped string.
 * Mirrors the paperclip `shellQuote` helper.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a login-shell script: source /etc/profile, ~/.profile,
 * ~/.bash_profile (or ~/.bashrc), and the nvm shims, then exec
 * the command. Mirrors paperclip's `buildLoginShellScript` so
 * `nvm`/npm-globals and user PATH prepends are honored.
 */
export function buildLoginShellScript(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stdinRedirect?: string;
}): string {
  const args = input.args ?? [];
  const env = input.env ?? {};
  const envArgs = Object.entries(env)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${shellQuote(v as string)}`);
  const commandParts = [shellQuote(input.command), ...args.map(shellQuote)].join(" ");
  const execLine = envArgs.length > 0
    ? `exec env ${envArgs.join(" ")} ${commandParts}`
    : `exec ${commandParts}`;
  const script = [
    "if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi",
    "if [ -f \"$HOME/.profile\" ]; then . \"$HOME/.profile\" >/dev/null 2>&1 || true; fi",
    "if [ -f \"$HOME/.bash_profile\" ]; then . \"$HOME/.bash_profile\" >/dev/null 2>&1 || true; elif [ -f \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\" >/dev/null 2>&1 || true; fi",
    "if [ -f \"$HOME/.zprofile\" ]; then . \"$HOME/.zprofile\" >/dev/null 2>&1 || true; fi",
    "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"",
    "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" >/dev/null 2>&1 || true",
    execLine,
  ].join(" && ");
  if (input.stdinRedirect) {
    return `${script} < ${shellQuote(input.stdinRedirect)}`;
  }
  return script;
}

/** Re-export SandboxClient for convenience. */
export type { SandboxClient };

/** Re-export RunProcessOptions for convenience. */
export type { RunProcessOptions };
