import { randomUUID } from "node:crypto";
import {
  classifyError,
  runtimeError,
  UnsupportedDispositionError,
} from "../../core/contracts/errors.js";
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
import { type ModalProviderConfig, modalConfigSchema } from "./config.js";
import { modalManifest } from "./manifest.js";

interface ModalClientSurface {
  create(input: { image: string; workdir: string; timeoutMs: number }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string } | null>;
  detach(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  exec(
    id: string,
    argv: string[],
    input: { timeoutMs?: number },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  fsWrite?(id: string, path: string, content: Uint8Array): Promise<void>;
  fsRead?(id: string, path: string): Promise<Uint8Array>;
}

/**
 * Modal V2 provider. Lease = Modal sandbox id; resume via
 * `sandboxes.fromId`. `retain`/release keeps the sandbox running via
 * detach; `destroy` terminates. Modal has no pause primitive, so
 * hibernate is unsupported and returns `UnsupportedDispositionError`.
 */
export function createModalProvider(
  config: ModalProviderConfig,
  options: {
    credentials?: { tokenId?: string; tokenSecret?: string };
    clientFactory?: (creds: {
      tokenId: string;
      tokenSecret: string;
    }) => Promise<ModalClientSurface>;
  } = {},
): RuntimeProvider<ModalProviderConfig> {
  const getCredentials = (ctx: {
    credentials?: Record<string, string | undefined>;
  }): { tokenId: string; tokenSecret: string } => {
    const tokenId =
      options.credentials?.tokenId?.trim() ||
      ctx.credentials?.tokenId?.trim() ||
      process.env.MODAL_TOKEN_ID?.trim() ||
      "";
    const tokenSecret =
      options.credentials?.tokenSecret?.trim() ||
      ctx.credentials?.tokenSecret?.trim() ||
      process.env.MODAL_TOKEN_SECRET?.trim() ||
      "";
    if (!tokenId || !tokenSecret) {
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET",
      );
    }
    return { tokenId, tokenSecret };
  };

  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<ModalClientSurface> => {
    const creds = getCredentials(ctx);
    if (options.clientFactory) return await options.clientFactory(creds);
    const { createModalClient } = await import("./client.js");
    return await createModalClient(creds, config);
  };

  return {
    manifest: modalManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<ModalProviderConfig>> {
      try {
        const parsed = modalConfigSchema.parse(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid modal config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<ModalProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const sandbox = await client.create({
          image: config.image,
          workdir: config.workdir,
          timeoutMs: 60_000,
        });
        try {
          await client.exec(sandbox.id, ["sh", "-lc", "true"], {});
          return {
            ok: true,
            summary: `modal sandbox ${sandbox.id} reachable`,
            metadata: { provider: "modal", sandboxId: sandbox.id },
          };
        } finally {
          await client.terminate(sandbox.id).catch(() => undefined);
        }
      } catch (error) {
        return { ok: false, summary: "modal probe failed", error: classifyError(error).message };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<ModalProviderConfig>): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      let sandbox: { id: string };
      try {
        sandbox = await client.create({
          image: ctx.profile?.image ?? config.image,
          workdir: config.workdir,
          timeoutMs: config.sandboxTimeoutMs,
        });
      } catch (error) {
        throw runtimeError(
          "PROVISION_FAILED",
          `modal create failed: ${classifyError(error).message}`,
          error,
        );
      }
      const remoteCwd = config.workdir;
      try {
        await client.exec(sandbox.id, ["sh", "-lc", `mkdir -p ${shellQuote(remoteCwd)}`], {});
        return {
          version: 1,
          provider: "modal",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "modal",
            backend: "modal",
            remoteCwd,
            nativeState: "running",
            image: ctx.profile?.image ?? config.image,
          },
        };
      } catch (error) {
        await client.terminate(sandbox.id).catch(() => undefined);
        throw error;
      }
    },

    async resumeLease(
      ctx: RuntimeResumeContext<ModalProviderConfig>,
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
          : config.workdir;
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "modal",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: new Date().toISOString(),
          metadata: {
            provider: "modal",
            backend: "modal",
            remoteCwd,
            nativeState: "running",
            resumed: true,
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<ModalProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor(ctx);
      if (ctx.lease.providerLeaseId) {
        await client.exec(
          ctx.lease.providerLeaseId,
          [
            "sh",
            "-lc",
            `mkdir -p ${shellQuote(ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? config.workdir)}`,
          ],
          {},
        );
      }
      const cwd = ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? config.workdir;
      return { cwd, metadata: { provider: "modal", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<ModalProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) throw runtimeError("EXECUTION_FAILED", "modal lease has no providerLeaseId");
      return createModalProcessHandle(
        client,
        leaseId,
        ctx.request,
        ctx.lease.metadata.remoteCwd ?? config.workdir,
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<ModalProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<ModalProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) return { disposition: "destroyed", warnings: ["no provider lease id"] };
      if (ctx.disposition === "retain") {
        await client.detach(leaseId).catch(() => undefined);
        return { disposition: "retained" };
      }
      if (ctx.disposition === "hibernate") {
        throw new UnsupportedDispositionError("hibernate", "modal");
      }
      await client.terminate(leaseId);
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<ModalProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      if (!ctx.providerLeaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      await client.terminate(ctx.providerLeaseId).catch(() => undefined);
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new ModalFilesystem({
        clientFor,
        leaseId: lease.providerLeaseId as string,
        credentials: ctx.credentials,
      });
    },
  };
}

function createModalProcessHandle(
  client: ModalClientSurface,
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
    provider: "modal",
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
      const script = buildLoginShellScript({
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? remoteCwd,
      });
      const out = await client.exec(leaseId, ["bash", "-lc", script], {
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
        stderrTail: encode(`modal execution failed: ${classifyError(error).message}\n`),
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
      await client.terminate(leaseId).catch(() => undefined);
    },
  };
}

class ModalFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<ModalClientSurface>;
      leaseId: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<ModalClientSurface> {
    return await this.ctx.clientFor({ credentials: this.ctx.credentials });
  }

  async mkdir(p: string): Promise<void> {
    const client = await this.client();
    await client.exec(this.ctx.leaseId, ["sh", "-lc", `mkdir -p ${shellQuote(p)}`], {});
  }

  async read(p: string): Promise<Uint8Array> {
    const client = await this.client();
    if (client.fsRead) return await client.fsRead(this.ctx.leaseId, p);
    const r = await client.exec(this.ctx.leaseId, ["cat", p], {});
    return new TextEncoder().encode(r.stdout);
  }

  async write(p: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    if (client.fsWrite) {
      await client.fsWrite(this.ctx.leaseId, p, content);
      return;
    }
    const text = new TextDecoder().decode(content);
    await client.exec(
      this.ctx.leaseId,
      [
        "sh",
        "-lc",
        `mkdir -p ${shellQuote(p.split("/").slice(0, -1).join("/") || ".")} && printf '%s' ${shellQuote(text)} > ${shellQuote(p)}`,
      ],
      {},
    );
  }

  async remove(p: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    await client.exec(
      this.ctx.leaseId,
      ["sh", "-lc", `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(p)}`],
      {},
    );
  }

  async list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const r = await client.exec(
      this.ctx.leaseId,
      ["sh", "-lc", `cd ${shellQuote(p)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`],
      {},
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

export function createModalProviderFromConfig(
  input: unknown,
): Promise<RuntimeProvider<ModalProviderConfig>> {
  try {
    const parsed = modalConfigSchema.parse(input ?? {});
    return Promise.resolve(createModalProvider(parsed));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid modal config",
      error,
    );
  }
}
