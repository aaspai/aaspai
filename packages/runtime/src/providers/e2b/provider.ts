import { randomUUID } from "node:crypto";
import path from "node:path";
import { classifyError, runtimeError } from "../../core/contracts/errors.js";
import type {
  RuntimeExecutionIdentity,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
} from "../../core/contracts/execution.js";
import type { RuntimeFilesystem } from "../../core/contracts/filesystem.js";
import type {
  RuntimeAcquireContext,
  RuntimeDestroyContext,
  RuntimeLease,
  RuntimeProbeResult,
  RuntimeProcessHandle,
  RuntimeProvider,
  RuntimeProviderContext,
  RuntimeReleaseContext,
  RuntimeResumeContext,
  RuntimeResumeResult,
  RuntimeStartExecutionContext,
  RuntimeValidationOutcome,
  RuntimeWorkspace,
  RuntimeWorkspaceContext,
} from "../../core/contracts/index.js";
import { buildLoginShellScript, shellQuote } from "../../core/shell/quote.js";
import { type E2bProviderConfig, e2bConfigSchema } from "./config.js";
import { e2bManifest } from "./manifest.js";

interface E2bClientSurface {
  create(input: {
    template?: string;
    timeoutMs?: number;
    labels?: Record<string, string>;
  }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string } | null>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  setTimeout(id: string, ms: number): Promise<void>;
  run(
    id: string,
    script: string,
    input: { cwd: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
}

/**
 * e2b V2 provider. Lease = e2b sandbox id; resume reconnects via
 * `Sandbox.connect`. Pause on hibernate (kill fallback), kill on
 * destroy. stdin is staged to a temp file to avoid races with fast
 * commands. The sandbox death clock is refreshed before each command.
 */
export function createE2bProvider(
  config: E2bProviderConfig,
  options: {
    credentials?: { apiKey?: string };
    clientFactory?: (creds: { apiKey: string }) => Promise<E2bClientSurface>;
  } = {},
): RuntimeProvider<E2bProviderConfig> {
  const getApiKey = (ctx: { credentials?: Record<string, string | undefined> }): string => {
    const apiKey =
      options.credentials?.apiKey?.trim() ||
      ctx.credentials?.apiKey?.trim() ||
      process.env.E2B_API_KEY?.trim() ||
      "";
    if (!apiKey) {
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "e2b requires an API key in config, credentials, or E2B_API_KEY",
      );
    }
    return apiKey;
  };

  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<E2bClientSurface> => {
    if (options.clientFactory) return await options.clientFactory({ apiKey: getApiKey(ctx) });
    const { createE2bClient } = await import("./client.js");
    return await createE2bClient({ apiKey: getApiKey(ctx) });
  };

  const resolveRemoteCwd = async (client: E2bClientSurface, sandboxId: string): Promise<string> => {
    try {
      const pwd = await client.run(sandboxId, "pwd", { cwd: "/", timeoutMs: 30_000 });
      const out = (pwd.stdout ?? "").trim();
      const base = out.length > 0 ? out : "/";
      const remoteCwd = path.posix.join(base, "aaspai-workspace");
      await client.run(sandboxId, `mkdir -p ${shellQuote(remoteCwd)}`, {
        cwd: "/",
        timeoutMs: 30_000,
      });
      return remoteCwd;
    } catch {
      return "/workspace";
    }
  };

  return {
    manifest: e2bManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<E2bProviderConfig>> {
      try {
        const parsed = e2bConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid e2b config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<E2bProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const sandbox = await client.create({
          template: config.template,
          timeoutMs: 60_000,
          labels: { "aaspai-purpose": "probe" },
        });
        try {
          await client.run(sandbox.id, "true", { cwd: "/", timeoutMs: 30_000 });
          return {
            ok: true,
            summary: `e2b sandbox ${sandbox.id} reachable`,
            metadata: { provider: "e2b", sandboxId: sandbox.id },
          };
        } finally {
          await client.kill(sandbox.id).catch(() => undefined);
        }
      } catch (error) {
        return { ok: false, summary: "e2b probe failed", error: classifyError(error).message };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<E2bProviderConfig>): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      const timeoutMs = config.timeoutMs ?? 3_600_000;
      let sandbox: { id: string };
      try {
        sandbox = await client.create({
          template: ctx.profile?.image ?? config.template,
          timeoutMs,
          labels: { "aaspai-attempt": randomUUID() },
        });
        await client.setTimeout(sandbox.id, timeoutMs);
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `e2b create failed: ${classifyError(error).message}`,
          error,
        );
      }
      try {
        const remoteCwd = await resolveRemoteCwd(client, sandbox.id);
        return {
          version: 1,
          provider: "e2b",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "e2b",
            backend: "e2b",
            remoteCwd,
            nativeState: "running",
            template: ctx.profile?.image ?? config.template,
          },
        };
      } catch (error) {
        await client.kill(sandbox.id).catch(() => undefined);
        throw error;
      }
    },

    async resumeLease(ctx: RuntimeResumeContext<E2bProviderConfig>): Promise<RuntimeResumeResult> {
      const client = await clientFor(ctx);
      const sandbox = await client.get(ctx.providerLeaseId).catch((error) => {
        if (/not found|notfound/i.test(classifyError(error).message)) return null;
        throw classifyError(error);
      });
      if (!sandbox) return { status: "expired", reason: "sandbox not found" };
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? ctx.leaseMetadata.remoteCwd
          : await resolveRemoteCwd(client, sandbox.id);
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "e2b",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "e2b",
            backend: "e2b",
            remoteCwd,
            nativeState: "running",
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<E2bProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor(ctx);
      if (ctx.lease.providerLeaseId) {
        await client.run(
          ctx.lease.providerLeaseId,
          `mkdir -p ${shellQuote(ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace")}`,
          {
            cwd: "/",
            timeoutMs: 30_000,
          },
        );
      }
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace";
      return { cwd, metadata: { provider: "e2b", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<E2bProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) throw runtimeError("EXECUTION_FAILED", "e2b lease has no providerLeaseId");
      return createE2bProcessHandle(
        client,
        leaseId,
        ctx.request,
        ctx.lease.metadata.remoteCwd ?? "/workspace",
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<E2bProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<E2bProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) return { disposition: "destroyed", warnings: ["no provider lease id"] };
      if (ctx.disposition === "retain") return { disposition: "retained" };
      if (ctx.disposition === "hibernate") {
        try {
          await client.pause(leaseId);
          return { disposition: "hibernated" };
        } catch (error) {
          await client.kill(leaseId).catch(() => undefined);
          return {
            disposition: "destroyed",
            fallbackUsed: true,
            warnings: [`pause failed, killed instead: ${classifyError(error).message}`],
          };
        }
      }
      await client.kill(leaseId);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<E2bProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      await client.kill(ctx.providerLeaseId).catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new E2bFilesystem({
        clientFor,
        leaseId: lease.providerLeaseId as string,
        credentials: ctx.credentials,
      });
    },
  };
}

function createE2bProcessHandle(
  client: E2bClientSurface,
  leaseId: string,
  request: RuntimeExecutionRequest,
  remoteCwd: string,
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): RuntimeProcessHandle {
  const executionId = `exec_${randomUUID()}`;
  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "e2b",
    providerLeaseId: leaseId,
    nativeProcessId: leaseId,
  };
  const startedAt = new Date();
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  const waiters: Array<() => void> = [];
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

  const run = async (): Promise<void> => {
    try {
      await client.setTimeout(leaseId, 3_600_000);
      let stdinPath: string | undefined;
      if (request.stdin !== undefined) {
        stdinPath = `/tmp/aaspai-stdin-${randomUUID()}`;
        if (client.fsWrite) {
          await client.fsWrite(
            leaseId,
            stdinPath,
            typeof request.stdin === "string"
              ? new TextEncoder().encode(request.stdin)
              : request.stdin,
          );
        }
      }
      const script = buildLoginShellScript({
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? remoteCwd,
        ...(stdinPath ? { stdinRedirect: stdinPath } : {}),
      });
      const out = await client.run(leaseId, script, {
        cwd: request.cwd ?? remoteCwd,
        timeoutMs: request.timeoutMs ?? 3_600_000,
      });
      const stdout = out.stdout ?? "";
      const stderr = out.stderr ?? "";
      if (stdout) await hooks.onStdout?.(encode(stdout));
      if (stderr) await hooks.onStderr?.(encode(stderr));
      const finishedAt = new Date();
      result = {
        status: out.timedOut ? "timed_out" : (out.exitCode ?? 0) === 0 ? "completed" : "failed",
        exitCode: out.timedOut ? null : out.exitCode,
        signal: out.timedOut ? "SIGTERM" : undefined,
        terminationReason: out.timedOut ? "timeout" : "exit",
        stdoutTail: encode(stdout.slice(-256 * 1024)),
        stderrTail: encode(stderr.slice(-256 * 1024)),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } catch (error) {
      const finishedAt = new Date();
      result = {
        status: "failed",
        exitCode: null,
        terminationReason: "provider_error",
        stdoutTail: new Uint8Array(),
        stderrTail: encode(`e2b execution failed: ${classifyError(error).message}\n`),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } finally {
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
      await client.kill(leaseId).catch(() => undefined);
    },
  };
}

class E2bFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<E2bClientSurface>;
      leaseId: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<E2bClientSurface> {
    return await this.ctx.clientFor({ credentials: this.ctx.credentials });
  }

  async mkdir(p: string): Promise<void> {
    const client = await this.client();
    await client.run(this.ctx.leaseId, `mkdir -p ${shellQuote(p)}`, {
      cwd: "/",
      timeoutMs: 30_000,
    });
  }

  async read(p: string): Promise<Uint8Array> {
    const client = await this.client();
    if (client.fsRead) return await client.fsRead(this.ctx.leaseId, p);
    const r = await client.run(this.ctx.leaseId, `cat ${shellQuote(p)}`, {
      cwd: "/",
      timeoutMs: 30_000,
    });
    return new TextEncoder().encode(r.stdout);
  }

  async write(p: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    if (client.fsWrite) {
      await client.fsWrite(this.ctx.leaseId, p, content);
      return;
    }
    await client.run(
      this.ctx.leaseId,
      `mkdir -p ${shellQuote(path.dirname(p))} && cat > ${shellQuote(p)}`,
      { cwd: "/", timeoutMs: 30_000 },
    );
  }

  async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    await client.run(
      this.ctx.leaseId,
      `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(p)}`,
      { cwd: "/", timeoutMs: 30_000 },
    );
  }

  async list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const r = await client.run(
      this.ctx.leaseId,
      `cd ${shellQuote(p)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
      {
        cwd: "/",
        timeoutMs: 30_000,
      },
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
  }
}

export function createE2bProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<E2bProviderConfig>> {
  try {
    const parsed = e2bConfigSchema.parse(input ?? {});
    return Promise.resolve(createE2bProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid e2b config",
      error,
    );
  }
}
