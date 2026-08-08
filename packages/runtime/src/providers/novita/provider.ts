import { randomUUID } from "node:crypto";
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
import { type NovitaProviderConfig, novitaConfigSchema } from "./config.js";
import { novitaManifest } from "./manifest.js";

interface NovitaClientSurface {
  create(input: { template?: string; timeoutMs?: number }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string } | null>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  setTimeout(id: string, ms: number): Promise<void>;
  run(
    id: string,
    script: string,
    input: { cwd: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
}

export function createNovitaProvider(
  config: NovitaProviderConfig,
  options: {
    credentials?: { apiKey?: string };
    clientFactory?: (creds: { apiKey: string }) => Promise<NovitaClientSurface>;
  } = {},
): RuntimeProvider<NovitaProviderConfig> {
  const getApiKey = (ctx: { credentials?: Record<string, string | undefined> }): string => {
    const apiKey =
      options.credentials?.apiKey?.trim() ||
      ctx.credentials?.apiKey?.trim() ||
      process.env.NOVITA_API_KEY?.trim() ||
      "";
    if (!apiKey)
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "novita requires an API key in config, credentials, or NOVITA_API_KEY",
      );
    return apiKey;
  };

  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<NovitaClientSurface> => {
    if (options.clientFactory) return await options.clientFactory({ apiKey: getApiKey(ctx) });
    const { createNovitaClient } = await import("./client.js");
    return await createNovitaClient({ apiKey: getApiKey(ctx) });
  };

  return {
    manifest: novitaManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<NovitaProviderConfig>> {
      try {
        const parsed = novitaConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid novita config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<NovitaProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const sandbox = await client.create({ template: config.template, timeoutMs: 60_000 });
        try {
          await client.run(sandbox.id, "true", { cwd: "/", timeoutMs: 30_000 });
          return {
            ok: true,
            summary: `novita sandbox ${sandbox.id} reachable`,
            metadata: { provider: "novita", sandboxId: sandbox.id },
          };
        } finally {
          await client.kill(sandbox.id).catch(() => undefined);
        }
      } catch (error) {
        return { ok: false, summary: "novita probe failed", error: classifyError(error).message };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<NovitaProviderConfig>): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      const remoteCwd = ctx.profile?.image ? ctx.profile.image : "/home/user/aaspai-workspace";
      let sandbox: { id: string };
      try {
        sandbox = await client.create({ template: config.template, timeoutMs: config.timeoutMs });
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `novita create failed: ${classifyError(error).message}`,
          error,
        );
      }
      try {
        await client.run(sandbox.id, `mkdir -p ${shellQuote(remoteCwd)}`, {
          cwd: "/",
          timeoutMs: 30_000,
        });
        return {
          version: 1,
          provider: "novita",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "novita",
            backend: "novita",
            remoteCwd,
            nativeState: "running",
            template: config.template,
          },
        };
      } catch (error) {
        await client.kill(sandbox.id).catch(() => undefined);
        throw error;
      }
    },

    async resumeLease(
      ctx: RuntimeResumeContext<NovitaProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      const client = await clientFor(ctx);
      const sandbox = await client.get(ctx.providerLeaseId).catch((error) => {
        if (/not found|notfound/i.test(classifyError(error).message)) return null;
        throw classifyError(error);
      });
      if (!sandbox) return { status: "expired", reason: "sandbox not found" };
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? ctx.leaseMetadata.remoteCwd
          : "/home/user/aaspai-workspace";
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "novita",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "novita",
            backend: "novita",
            remoteCwd,
            nativeState: "running",
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<NovitaProviderConfig>,
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
      return { cwd, metadata: { provider: "novita", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<NovitaProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) throw runtimeError("EXECUTION_FAILED", "novita lease has no providerLeaseId");
      return createNovitaProcessHandle(
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
      ctx: RuntimeStartExecutionContext<NovitaProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<NovitaProviderConfig>): Promise<{
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
      ctx: RuntimeDestroyContext<NovitaProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      await client.kill(ctx.providerLeaseId).catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new NovitaFilesystem({
        clientFor,
        leaseId: lease.providerLeaseId as string,
        credentials: ctx.credentials,
      });
    },
  };
}

function createNovitaProcessHandle(
  client: NovitaClientSurface,
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
    provider: "novita",
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
      await client.setTimeout(leaseId, config_timeout());
      const script = buildLoginShellScript({
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? remoteCwd,
      });
      const out = await client.run(leaseId, script, {
        cwd: request.cwd ?? remoteCwd,
        timeoutMs: request.timeoutMs ?? config_timeout(),
      });
      if (out.stdout) await hooks.onStdout?.(encode(out.stdout));
      if (out.stderr) await hooks.onStderr?.(encode(out.stderr));
      const finishedAt = new Date();
      result = {
        status: (out.exitCode ?? 0) === 0 ? "completed" : "failed",
        exitCode: out.exitCode,
        terminationReason: "exit",
        stdoutTail: encode(out.stdout.slice(-256 * 1024)),
        stderrTail: encode(out.stderr.slice(-256 * 1024)),
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
        stderrTail: encode(`novita execution failed: ${classifyError(error).message}\n`),
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

  function config_timeout(): number {
    return 300_000;
  }

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

class NovitaFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<NovitaClientSurface>;
      leaseId: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<NovitaClientSurface> {
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
    const text = new TextDecoder().decode(content);
    await client.run(
      this.ctx.leaseId,
      `mkdir -p ${shellQuote(p.split("/").slice(0, -1).join("/") || ".")} && printf '%s' ${shellQuote(text)} > ${shellQuote(p)}`,
      {
        cwd: "/",
        timeoutMs: 30_000,
      },
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

export function createNovitaProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<NovitaProviderConfig>> {
  try {
    const parsed = novitaConfigSchema.parse(input ?? {});
    return Promise.resolve(createNovitaProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid novita config",
      error,
    );
  }
}
