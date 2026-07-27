import { randomUUID } from "node:crypto";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { SandboxClient, SandboxLease } from "../sandbox-client.js";
import { SdkSandboxDriver, toRunResult } from "../sdk-sandbox-driver.js";

/**
 * Shape returned by the Cloudflare Worker template that exposes the
 * 6-method `SandboxClient` REST surface. The Worker lives at
 * `<bridgeUrl>/api/aaspai-sandbox/v1/...` and is deployed by the
 * bridge operator (typically via `wrangler deploy`).
 */
interface CloudflareBridgeConfig {
  /** Worker URL, e.g. "https://aaspai-sandbox-bridge.<account>.workers.dev" */
  bridgeUrl: string;
  /** Auth token for the Worker (sent as Bearer) */
  authToken?: string;
}

function resolveBridgeConfig(input: { bridgeUrl?: string | null; authToken?: string | null }): CloudflareBridgeConfig {
  const bridgeUrl = input.bridgeUrl?.trim() || process.env.AASPAI_CF_BRIDGE_URL?.trim() || "";
  const authToken = input.authToken?.trim() || process.env.AASPAI_CF_BRIDGE_TOKEN?.trim() || undefined;
  return { bridgeUrl, ...(authToken ? { authToken } : {}) };
}

class CloudflareBridgeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CloudflareBridgeError";
  }
}

/**
 * Real Cloudflare-backed `SandboxDriver`. The "sandbox" is a
 * Cloudflare Worker (the "bridge template") that exposes a REST
 * surface matching the 6-method `SandboxClient`. Each lease maps
 * to a Durable Object instance inside the Worker.
 *
 * - `POST /api/aaspai-sandbox/v1/acquire` → `acquire`
 * - `POST /api/aaspai-sandbox/v1/resume` → `resume`
 * - `POST /api/aaspai-sandbox/v1/release` → `release`
 * - `POST /api/aaspai-sandbox/v1/destroy` → `destroy`
 * - `POST /api/aaspai-sandbox/v1/fs/mkdir|write|read|list|remove` for the FS methods
 * - `POST /api/aaspai-sandbox/v1/run` for `client.run`
 */
export class CloudflareSandboxDriver extends SdkSandboxDriver<{ providerLeaseId: string }> {
  private readonly config: CloudflareBridgeConfig;

  constructor(options: { bridgeUrl?: string | null; authToken?: string | null } = {}) {
    super("cloudflare");
    this.config = resolveBridgeConfig({ bridgeUrl: options.bridgeUrl, authToken: options.authToken });
  }

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.config.bridgeUrl) {
      throw new Error(
        "cloudflare sandbox requires a bridgeUrl in config or AASPAI_CF_BRIDGE_URL env var (the deployed Cloudflare Worker URL)",
      );
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.authToken) headers.Authorization = `Bearer ${this.config.authToken}`;
    const res = await fetch(`${this.config.bridgeUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || res.status === 409) {
        throw new CloudflareBridgeError(res.status, text || `cloudflare bridge ${res.status}`);
      }
      throw new Error(`cloudflare bridge ${res.status}: ${text}`);
    }
    return await res.json();
  }

  protected override async createSandbox(input: {
    remoteCwd: string;
    timeoutMs?: number;
  }): Promise<{ raw: { providerLeaseId: string }; remoteCwd: string; metadata: Record<string, unknown> }> {
    const data = (await this.call("/api/aaspai-sandbox/v1/acquire", {
      remoteCwd: input.remoteCwd,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    })) as { providerLeaseId: string; remoteCwd: string };
    return {
      raw: { providerLeaseId: data.providerLeaseId },
      remoteCwd: data.remoteCwd,
      metadata: { providerLeaseId: data.providerLeaseId, remoteCwd: data.remoteCwd },
    };
  }

  protected override async reconnect(providerLeaseId: string): Promise<{ providerLeaseId: string } | null> {
    try {
      const data = (await this.call("/api/aaspai-sandbox/v1/resume", {
        providerLeaseId,
      })) as { providerLeaseId: string };
      return { providerLeaseId: data.providerLeaseId };
    } catch (error) {
      if (error instanceof CloudflareBridgeError && (error.status === 404 || error.status === 409)) {
        return null;
      }
      throw error;
    }
  }

  protected override async destroySandbox(raw: { providerLeaseId: string }): Promise<void> {
    await this.call("/api/aaspai-sandbox/v1/destroy", { providerLeaseId: raw.providerLeaseId }).catch(
      () => undefined,
    );
  }

  protected override leaseId(raw: { providerLeaseId: string }): string {
    return raw.providerLeaseId;
  }

  protected override buildClient(
    raw: { providerLeaseId: string },
    lease: SandboxLease,
  ): SandboxClient {
    const leaseId = raw.providerLeaseId;
    const execCommand = async (options: RunProcessOptions): Promise<RunProcessResult> => {
      const startedAt = new Date();
      const data = (await this.call("/api/aaspai-sandbox/v1/run", {
        providerLeaseId: leaseId,
        command: options.command,
        args: options.args ?? [],
        env: options.env ?? {},
        cwd: options.cwd ?? lease.remoteCwd,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      })) as { exitCode: number | null; stdout: string; stderr: string; signal?: string; timedOut?: boolean };
      return toRunResult({
        exitCode: data.exitCode,
        stdout: data.stdout,
        stderr: data.stderr,
        signal: data.signal,
        timedOut: data.timedOut,
        startedAt,
      });
    };

    const fsCall = async (op: string, payload: Record<string, unknown>): Promise<unknown> => {
      return await this.call(`/api/aaspai-sandbox/v1/fs/${op}`, { providerLeaseId: leaseId, ...payload });
    };

    return {
      async makeDir(remotePath, options) {
        await fsCall("mkdir", { path: remotePath, recursive: options?.recursive ?? true });
      },
      async writeFile(remotePath, content) {
        const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
        await fsCall("write", { path: remotePath, content: text });
      },
      async readFile(remotePath) {
        const data = (await fsCall("read", { path: remotePath })) as { content: string };
        return Buffer.from(data.content, "utf8");
      },
      async listFiles(remotePath) {
        const data = (await fsCall("list", { path: remotePath })) as {
          entries: { name: string; size: number; isDir: boolean }[];
        };
        return data.entries;
      },
      async remove(remotePath, options) {
        await fsCall("remove", { path: remotePath, recursive: options?.recursive ?? true });
      },
      run: execCommand,
    };
  }
}

void randomUUID;
