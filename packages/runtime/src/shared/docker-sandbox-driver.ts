import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import { runProcess } from "@aaspai/harness";
import type { SandboxClient, SandboxDriver, SandboxLease } from "./sandbox-client.js";

/**
 * Per-provider docker configuration. Each cloud sandbox provider
 * uses these knobs to differentiate itself from the others:
 *   - `image`: the docker image to use
 *   - `network`: which docker network to attach (`none`, `bridge`)
 *   - `memoryMb`, `cpuShares`: resource limits
 *   - `extraEnv`: provider-specific env vars
 *   - `homeBindSource`: host path to bind-mount at the container's HOME
 *     (so the opencode CLI can find the auth.json). If unset, we
 *     create a fresh per-lease temp dir and write the auth there.
 *   - `authSourcePath`: host path to a pre-existing auth.json to copy
 *     into the lease's auth dir. Typically the test runner's
 *     `~/.local/share/opencode/auth.json`.
 */
export interface DockerSandboxConfig {
  providerKey: string;
  image: string;
  network: "none" | "bridge" | "host";
  memoryMb?: number;
  cpuShares?: number;
  extraEnv?: Record<string, string>;
  authSourcePath?: string;
  /** Container's HOME dir; defaults to `/root`. The auth.json lives at `<HOME>/.local/share/opencode/auth.json`. */
  homeDir?: string;
}

const DEFAULT_HOME = "/root";

/**
 * Real docker-backed `SandboxDriver`. Each `acquire` provisions a
 * disposable container (bind-mounted workspace + provider-specific
 * image/network/limits); `release` destroys it; the `client` returned
 * by `client(lease)` spawns commands inside the running container
 * via `docker exec`.
 *
 * The 6-method `SandboxClient` interface is unchanged from the
 * local backend; the only difference is that operations are
 * delegated to `docker exec` instead of `child_process.spawn`.
 */
export class DockerSandboxDriver implements SandboxDriver {
  private readonly activeLeases = new Map<
    string,
    {
      containerId: string;
      baseDir: string;
      authDir: string;
      remoteCwd: string;
      config: DockerSandboxConfig;
      homeDir: string;
    }
  >();

  constructor(
    private readonly providerKey: string,
    private readonly config: DockerSandboxConfig,
  ) {}

  /**
   * `docker create` a fresh container, `start` it, copy the auth
   * into the bind-mounted auth dir, and return the lease.
   */
  async acquire(remoteCwd: string, _options?: { timeoutMs?: number }): Promise<SandboxLease> {
    const providerLeaseId = `docker-${this.providerKey}-${randomUUID().slice(0, 8)}`;
    const homeDir = this.config.homeDir ?? DEFAULT_HOME;
    // Two bind mounts: workspace + auth. Both on the host fs so
    // the container sees them at well-known paths.
    const baseDir = join(tmpdir(), `aaspai-${this.providerKey}-ws-${randomUUID().slice(0, 8)}`);
    const authDir = join(tmpdir(), `aaspai-${this.providerKey}-auth-${randomUUID().slice(0, 8)}`);
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(authDir, ".local", "share", "opencode"), { recursive: true });

    // Copy the auth.json if a source path was configured
    if (this.config.authSourcePath && existsSync(this.config.authSourcePath)) {
      copyFile(
        this.config.authSourcePath,
        join(authDir, ".local", "share", "opencode", "auth.json"),
      );
    }

    const args: string[] = [
      "create",
      "--init",
      "--label",
      `aaspai-sandbox-provider=${this.providerKey}`,
      "--label",
      `aaspai-sandbox-lease=${providerLeaseId}`,
      "--network",
      this.config.network,
      "--mount",
      `type=bind,source=${baseDir},target=/workspace`,
      "--mount",
      `type=bind,source=${authDir},target=${homeDir}`,
      "--env",
      `HOME=${homeDir}`,
      "--env",
      `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      "--env",
      `LANG=C.UTF-8`,
      "--workdir",
      "/workspace",
    ];
    if (this.config.memoryMb !== undefined) {
      args.push("--memory", `${this.config.memoryMb}m`);
    }
    if (this.config.cpuShares !== undefined) {
      args.push("--cpu-shares", String(this.config.cpuShares));
    }
    for (const [k, v] of Object.entries(this.config.extraEnv ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    args.push(this.config.image, "tail", "-f", "/dev/null");

    const created = await runProcess({ command: "docker", args });
    const containerId = created.stdout.trim().split(/\s+/)[0] ?? "";
    if (!containerId) {
      throw new Error(
        `DockerSandboxDriver(${this.providerKey}): docker create returned no container id. stderr: ${created.stderr}`,
      );
    }

    const started = await runProcess({ command: "docker", args: ["start", containerId] });
    if (started.exitCode !== 0) {
      await runProcess({ command: "docker", args: ["rm", "-f", containerId] }).catch(
        () => undefined,
      );
      throw new Error(
        `DockerSandboxDriver(${this.providerKey}): docker start failed. stderr: ${started.stderr}`,
      );
    }

    this.activeLeases.set(providerLeaseId, {
      containerId,
      baseDir,
      authDir,
      remoteCwd,
      config: this.config,
      homeDir,
    });
    return {
      providerLeaseId,
      remoteCwd,
      metadata: {
        containerId,
        baseDir,
        authDir,
        provider: this.providerKey,
        image: this.config.image,
        network: this.config.network,
        memoryMb: this.config.memoryMb,
        cpuShares: this.config.cpuShares,
        homeDir,
      },
    };
  }

  /**
   * Reconnect to an existing lease. Checks that the container is
   * still running via `docker inspect`; if not, return null.
   */
  async resume(providerLeaseId: string): Promise<SandboxLease | null> {
    const rec = this.activeLeases.get(providerLeaseId);
    if (!rec) return null;
    const inspected = await runProcess({
      command: "docker",
      args: ["inspect", "--format", "{{.State.Status}}", rec.containerId],
    });
    if (inspected.exitCode !== 0) return null;
    const status = inspected.stdout.trim();
    if (status !== "running") {
      this.activeLeases.delete(providerLeaseId);
      return null;
    }
    return {
      providerLeaseId,
      remoteCwd: rec.remoteCwd,
      metadata: { containerId: rec.containerId, provider: this.providerKey },
    };
  }

  /** Destroy the container. Idempotent. */
  async release(lease: SandboxLease, _options?: { reuseLease?: boolean }): Promise<void> {
    const rec = this.activeLeases.get(lease.providerLeaseId);
    if (!rec) return;
    this.activeLeases.delete(lease.providerLeaseId);
    await runProcess({ command: "docker", args: ["rm", "-f", rec.containerId] }).catch(
      () => undefined,
    );
  }

  /** Force-destroy, ignoring `reuseLease`. */
  async destroy(providerLeaseId: string): Promise<void> {
    const rec = this.activeLeases.get(providerLeaseId);
    if (!rec) return;
    this.activeLeases.delete(providerLeaseId);
    await runProcess({ command: "docker", args: ["rm", "-f", rec.containerId] }).catch(
      () => undefined,
    );
  }

  /**
   * Return a 6-method client bound to the live container. All FS
   * operations are routed through `docker exec`.
   */
  client(lease: SandboxLease): SandboxClient {
    const rec = this.activeLeases.get(lease.providerLeaseId);
    if (!rec) {
      throw new Error(
        `DockerSandboxDriver(${this.providerKey}): unknown lease ${lease.providerLeaseId}`,
      );
    }
    const containerId = rec.containerId;
    const execIn = (
      cmd: string,
      args: string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
      runProcess({
        command: "docker",
        args: ["exec", "--workdir", rec.remoteCwd, containerId, cmd, ...args],
      }).then((r) => ({
        exitCode: r.exitCode ?? 1,
        stdout: r.stdout,
        stderr: r.stderr,
      }));

    const run = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const envArgs = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      // Wrap in `bash -lc` so the inner command gets a login shell
      // and env is honored. The container has only /usr/local/bin etc.
      const cmdString = [options.command, ...options.args].join(" ");
      return await runProcess({
        command: "docker",
        args: [
          "exec",
          "--workdir",
          rec.remoteCwd,
          ...envArgs,
          containerId,
          "bash",
          "-lc",
          cmdString,
        ],
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.onLog ? { onLog: options.onLog } : {}),
        ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      });
    };

    return {
      async makeDir(remotePath, options) {
        const recursive = options?.recursive ?? true;
        const r = await execIn("mkdir", [recursive ? "-p" : "", remotePath]);
        if (r.exitCode !== 0) throw new Error(`mkdir failed: ${r.stderr}`);
      },
      async writeFile(remotePath, content) {
        const r = await runProcess({
          command: "docker",
          args: ["exec", "-i", "--workdir", rec.remoteCwd, containerId, "tee", remotePath],
          stdin: typeof content === "string" ? content : Buffer.from(content).toString("utf8"),
        });
        if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr}`);
      },
      async readFile(remotePath) {
        const r = await execIn("cat", [remotePath]);
        if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr}`);
        return Buffer.from(r.stdout, "utf8");
      },
      async listFiles(remotePath) {
        const r = await execIn("sh", [
          "-c",
          `cd ${shellQuote(remotePath)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
        ]);
        if (r.exitCode !== 0) throw new Error(`listFiles failed: ${r.stderr}`);
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
        const r = await execIn("rm", [(options?.recursive ?? true) ? "-rf" : "-f", remotePath]);
        if (r.exitCode !== 0) throw new Error(`remove failed: ${r.stderr}`);
      },
      run,
    };
  }

  /** For tests: list active container IDs. */
  listActiveContainerIds(): string[] {
    return [...this.activeLeases.values()].map((r) => r.containerId);
  }

  /** Expose lease details for the test runner. */
  getLeaseBaseDir(providerLeaseId: string): string | undefined {
    return this.activeLeases.get(providerLeaseId)?.baseDir;
  }
}

function shellQuote(value: string): string {
  if (!/[\s"'`$|&;<>(){}[\]\\!#*?]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
