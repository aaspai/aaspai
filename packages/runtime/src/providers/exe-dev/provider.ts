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
import { shellQuote } from "../../core/shell/quote.js";
import { type ExeDevProviderConfig, exeDevConfigSchema } from "./config.js";
import { exeDevManifest } from "./manifest.js";

interface ExeDevClientSurface {
  create(input: {
    name: string;
    image: string;
    command: string;
  }): Promise<{ name: string; sshDest: string }>;
  get(name: string): Promise<{ name: string; sshDest: string } | null>;
  destroy(name: string): Promise<void>;
  runSsh(input: {
    sshDest: string;
    remoteCommand: string;
    timeoutMs?: number;
    identity?: string;
  }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  scp(input: {
    sshDest: string;
    localPath?: string;
    remotePath: string;
    direction: "to" | "from";
    identity?: string;
  }): Promise<Uint8Array | undefined>;
}

export function createExeDevProvider(
  config: ExeDevProviderConfig,
  options: {
    credentials?: { apiKey?: string; sshKey?: string };
    clientFactory?: (creds: { apiKey: string }) => Promise<ExeDevClientSurface>;
  } = {},
): RuntimeProvider<ExeDevProviderConfig> {
  const getApiKey = (ctx: { credentials?: Record<string, string | undefined> }): string => {
    const apiKey =
      options.credentials?.apiKey?.trim() ||
      ctx.credentials?.apiKey?.trim() ||
      process.env.EXE_API_KEY?.trim() ||
      "";
    if (!apiKey)
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "exe.dev requires an API key in config, credentials, or EXE_API_KEY",
      );
    return apiKey;
  };

  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<ExeDevClientSurface> => {
    if (options.clientFactory) return await options.clientFactory({ apiKey: getApiKey(ctx) });
    const { createExeDevClient } = await import("./client.js");
    return await createExeDevClient({ apiKey: getApiKey(ctx) });
  };

  return {
    manifest: exeDevManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<ExeDevProviderConfig>> {
      try {
        const parsed = exeDevConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid exe.dev config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<ExeDevProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const vm = await client.create({
          name: `aaspai-probe-${randomUUID().slice(0, 8)}`,
          image: config.image,
          command: config.command,
        });
        try {
          await client.runSsh({ sshDest: vm.sshDest, remoteCommand: "true", timeoutMs: 30_000 });
          return {
            ok: true,
            summary: `exe.dev VM ${vm.name} reachable`,
            metadata: { provider: "exe_dev", vm: vm.name },
          };
        } finally {
          await client.destroy(vm.name).catch(() => undefined);
        }
      } catch (error) {
        return { ok: false, summary: "exe.dev probe failed", error: classifyError(error).message };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<ExeDevProviderConfig>): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      let vm: { name: string; sshDest: string };
      try {
        vm = await client.create({
          name: `aaspai-${randomUUID().slice(0, 8)}`,
          image: ctx.profile?.image ?? config.image,
          command: config.command,
        });
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `exe.dev create failed: ${classifyError(error).message}`,
          error,
        );
      }
      const remoteCwd = "/workspace";
      return {
        version: 1,
        provider: "exe_dev",
        providerLeaseId: vm.name,
        reusable: true,
        createdAt: new Date().toISOString(),
        metadata: {
          provider: "exe_dev",
          backend: "exe_dev",
          remoteCwd,
          nativeState: "running",
          vmName: vm.name,
          sshDest: vm.sshDest,
        },
      };
    },

    async resumeLease(
      ctx: RuntimeResumeContext<ExeDevProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      const client = await clientFor(ctx);
      const vm = await client.get(ctx.providerLeaseId);
      if (!vm) return { status: "expired", reason: "VM not found" };
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? ctx.leaseMetadata.remoteCwd
          : "/workspace";
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "exe_dev",
          providerLeaseId: vm.name,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "exe_dev",
            backend: "exe_dev",
            remoteCwd,
            nativeState: "running",
            vmName: vm.name,
            sshDest: vm.sshDest,
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<ExeDevProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor(ctx);
      if (ctx.lease.providerLeaseId && ctx.lease.metadata.sshDest) {
        await client.runSsh({
          sshDest: String(ctx.lease.metadata.sshDest),
          remoteCommand: `mkdir -p ${shellQuote(ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace")}`,
          timeoutMs: 30_000,
        });
      }
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace";
      return { cwd, metadata: { provider: "exe_dev", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<ExeDevProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const sshDest = String(ctx.lease.metadata.sshDest ?? "");
      if (!sshDest) throw runtimeError("EXECUTION_FAILED", "exe.dev lease has no ssh destination");
      return createExeDevProcessHandle(
        client,
        sshDest,
        ctx.request,
        ctx.lease.metadata.remoteCwd ?? "/workspace",
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<ExeDevProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<ExeDevProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor(ctx);
      if (!ctx.lease.providerLeaseId)
        return { disposition: "destroyed", warnings: ["no provider lease id"] };
      if (ctx.disposition === "retain") return { disposition: "retained" };
      await client.destroy(ctx.lease.providerLeaseId).catch(() => undefined);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<ExeDevProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      await client.destroy(ctx.providerLeaseId).catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new ExeDevFilesystem({
        clientFor,
        sshDest: String(lease.metadata.sshDest ?? ""),
        credentials: ctx.credentials,
      });
    },
  };
}

function createExeDevProcessHandle(
  client: ExeDevClientSurface,
  sshDest: string,
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
    provider: "exe_dev",
    providerLeaseId: sshDest,
    nativeProcessId: sshDest,
  };
  const startedAt = new Date();
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  const waiters: Array<() => void> = [];
  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

  const run = async (): Promise<void> => {
    try {
      const cmd = [request.command, ...(request.args ?? [])].map(shellQuote).join(" ");
      const wrapped = `cd ${shellQuote(request.cwd ?? remoteCwd)} && ${cmd}`;
      const out = await client.runSsh({
        sshDest,
        remoteCommand: wrapped,
        timeoutMs: request.timeoutMs,
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
        stderrTail: encode(`exe.dev execution failed: ${classifyError(error).message}\n`),
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
      await client
        .runSsh({
          sshDest,
          remoteCommand: "pkill -TERM -f 'sh -lc' 2>/dev/null || true",
          timeoutMs: 15_000,
        })
        .catch(() => undefined);
    },
  };
}

class ExeDevFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<ExeDevClientSurface>;
      sshDest: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<ExeDevClientSurface> {
    return await this.ctx.clientFor({ credentials: this.ctx.credentials });
  }

  async mkdir(p: string): Promise<void> {
    const client = await this.client();
    await client.runSsh({
      sshDest: this.ctx.sshDest,
      remoteCommand: `mkdir -p ${shellQuote(p)}`,
      timeoutMs: 30_000,
    });
  }

  async read(p: string): Promise<Uint8Array> {
    const client = await this.client();
    const r = await client.scp({ sshDest: this.ctx.sshDest, remotePath: p, direction: "from" });
    return r ?? new Uint8Array();
  }

  async write(p: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    await client.runSsh({
      sshDest: this.ctx.sshDest,
      remoteCommand: `mkdir -p ${shellQuote(p.split("/").slice(0, -1).join("/") || ".")}`,
      timeoutMs: 30_000,
    });
    const r = await client.scp({ sshDest: this.ctx.sshDest, remotePath: p, direction: "to" });
    void r;
    // scp "to" is contentless in this surface; fall back to shell printf when
    // the client surface does not support content upload.
    await client.runSsh({
      sshDest: this.ctx.sshDest,
      remoteCommand: `printf '%s' ${shellQuote(new TextDecoder().decode(content))} > ${shellQuote(p)}`,
      timeoutMs: 30_000,
    });
  }

  async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    await client.runSsh({
      sshDest: this.ctx.sshDest,
      remoteCommand: `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(p)}`,
      timeoutMs: 30_000,
    });
  }

  async list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const r = await client.runSsh({
      sshDest: this.ctx.sshDest,
      remoteCommand: `cd ${shellQuote(p)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
      timeoutMs: 30_000,
    });
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

export function createExeDevProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<ExeDevProviderConfig>> {
  try {
    const parsed = exeDevConfigSchema.parse(input ?? {});
    return Promise.resolve(createExeDevProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid exe.dev config",
      error,
    );
  }
}
