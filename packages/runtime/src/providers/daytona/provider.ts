import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { classifyError, runtimeError } from "../../core/contracts/errors.js";
import type {
  RuntimeExecutionIdentity,
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeSignal,
} from "../../core/contracts/execution.js";
import type { RuntimeFilesystem } from "../../core/contracts/filesystem.js";
import type {
  RuntimeAcquireContext,
  RuntimeClock,
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
import { assertSafeEnvKey, assertSafeRemotePath } from "../../core/filesystem/safe-path.js";
import { BoundedByteBuffer } from "../../core/process/bounded-buffer.js";
import { sanitizeLeaseMetadata } from "../../core/security/lease-metadata.js";
import { shellQuote } from "../../core/shell/quote.js";
import type { DaytonaClientSurface } from "./client-surface.js";
import { type DaytonaProviderConfig, normalizeDaytonaConfig } from "./config.js";
import { daytonaManifest } from "./manifest.js";

const DEFAULT_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
} as const;
const SENTINEL_FILE = ".aaspai/runtime-binding.json";
const SENTINEL_VERSION = 1;

/**
 * Daytona V2 provider. Stateless lease lifecycle: acquire/release/destroy
 * all resolve the sandbox by `providerLeaseId` (the Daytona sandbox id),
 * so it works after a worker restart with only persisted lease metadata.
 * Hibernate stops the sandbox; release with `destroy` deletes it;
 * destroyById removes by id even when this process did not acquire it.
 */
export function createDaytonaProvider(
  rawConfig: DaytonaProviderConfig,
  options: {
    credentials?: { apiKey?: string; apiUrl?: string };
    clock?: RuntimeClock;
    clientFactory?: (creds: { apiKey: string; apiUrl?: string }) => Promise<DaytonaClientSurface>;
  } = {},
): RuntimeProvider<DaytonaProviderConfig> {
  const config = normalizeDaytonaConfig(rawConfig ?? {});
  const now = () => (options.clock ?? { now: () => new Date() }).now().toISOString();
  const getCredentials = (ctx: {
    credentials?: Record<string, string | undefined>;
  }): { apiKey: string; apiUrl?: string } => {
    const apiKey =
      options.credentials?.apiKey?.trim() ||
      ctx.credentials?.apiKey?.trim() ||
      process.env.DAYTONA_API_KEY?.trim() ||
      "";
    if (!apiKey) {
      throw runtimeError(
        "CREDENTIALS_MISSING",
        "daytona requires an API key in config, credentials, or DAYTONA_API_KEY",
      );
    }
    const apiUrl =
      options.credentials?.apiUrl?.trim() ||
      config.apiUrl?.trim() ||
      process.env.DAYTONA_API_URL?.trim() ||
      undefined;
    return { apiKey, apiUrl };
  };

  const clientFor = async (ctx: {
    credentials?: Record<string, string | undefined>;
  }): Promise<DaytonaClientSurface> => {
    if (options.clientFactory) {
      return await options.clientFactory(getCredentials(ctx));
    }
    const { createDaytonaClient } = await import("./client.js");
    return await createDaytonaClient(getCredentials(ctx));
  };

  return {
    manifest: daytonaManifest,

    async validateConfig(input: unknown): Promise<RuntimeValidationOutcome<DaytonaProviderConfig>> {
      try {
        const parsed = normalizeDaytonaConfig(input ?? {});
        return { ok: true, normalizedConfig: parsed };
      } catch (error) {
        return {
          ok: false,
          errors: error instanceof Error ? [error.message] : ["invalid daytona config"],
        };
      }
    },

    async probe(ctx: RuntimeAcquireContext<DaytonaProviderConfig>): Promise<RuntimeProbeResult> {
      try {
        const client = await clientFor(ctx);
        const lease = await client.create({
          image: config.snapshot ? undefined : (config.image ?? "node:22-bookworm-slim"),
          snapshot: config.snapshot,
          timeoutMs: config.timeoutMs,
          reusable: false,
          labels: { "aaspai-purpose": "probe", "aaspai-probe": randomUUID() },
        });
        try {
          await client.execute(lease.id, {
            command: "pwd",
            args: [],
            cwd: "/",
            env: DEFAULT_ENV,
            timeoutMs: 30_000,
          });
          return {
            ok: true,
            summary: `daytona sandbox ${lease.id} reachable`,
            metadata: { provider: "daytona", sandboxId: lease.id },
          };
        } finally {
          await client.delete(lease.id);
          await verifyDeleted(client, lease.id);
        }
      } catch (error) {
        return { ok: false, summary: "daytona probe failed", error: classifyError(error).message };
      }
    },

    async acquireLease(ctx: RuntimeAcquireContext<DaytonaProviderConfig>): Promise<RuntimeLease> {
      const client = await clientFor(ctx);
      const timeoutMs = ctx.config?.timeoutMs ?? config.timeoutMs ?? 300_000;
      const acquisitionId = randomUUID();
      const acquisitionLabels = { ...(ctx.labels ?? {}), "aaspai-acquisition": acquisitionId };
      let sandbox: { id: string; state?: string };
      const requestedImage = ctx.profile?.image ?? config.image;
      const requestedSnapshot = requestedImage ? undefined : config.snapshot;
      try {
        sandbox = await client.create({
          image: requestedImage ?? (requestedSnapshot ? undefined : "node:22-bookworm-slim"),
          snapshot: requestedSnapshot,
          timeoutMs,
          resources: ctx.profile?.resources ?? config.resources,
          target: config.target,
          reusable: true,
          autoStopMinutes: config.autoStopMinutes,
          autoArchiveMinutes: config.autoArchiveMinutes,
          autoDeleteMinutes: config.autoDeleteMinutes,
          labels: acquisitionLabels,
        });
      } catch (error) {
        const candidates = client.findByLabels
          ? await client.findByLabels(acquisitionLabels).catch(() => [])
          : undefined;
        const candidate = candidates?.length === 1 ? candidates[0] : undefined;
        if (candidate) {
          sandbox = candidate;
        } else {
          throw classifyError(error).code === "PROVISION_FAILED"
            ? error
            : runtimeError(
                "PROVISION_FAILED",
                `daytona create failed${candidates && candidates.length > 1 ? " with multiple reconciliation candidates" : ""}: ${classifyError(error).message}`,
                error,
                {
                  provider: "daytona",
                  operation: "acquireLease",
                  details: {
                    acquisitionId,
                    reconciliationCandidates: candidates?.map((candidate) => candidate.id) ?? [],
                  },
                },
              );
        }
      }
      try {
        const remoteCwd = await resolveRemoteCwd(client, sandbox.id);
        await client.execute(sandbox.id, {
          command: `mkdir -p ${shellQuote(remoteCwd)}`,
          args: [],
          cwd: "/",
          env: DEFAULT_ENV,
          timeoutMs: 30_000,
        });
        const sentinelNonce = randomUUID();
        await writeSentinel(client, sandbox.id, remoteCwd, {
          bindingVersion: SENTINEL_VERSION,
          provider: "daytona",
          nonce: sentinelNonce,
        });
        const sanitized = sanitizeLeaseMetadata({
          provider: "daytona",
          backend: "daytona",
          remoteCwd,
          nativeState: sandbox.state ?? "started",
          image: requestedImage,
          ...(requestedSnapshot ? { snapshot: requestedSnapshot } : {}),
          sentinelNonce,
          sentinelPath: `${remoteCwd}/${SENTINEL_FILE}`,
          acquisitionId,
        });
        return {
          version: 1,
          provider: "daytona",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: now(),
          metadata: sanitized.metadata as RuntimeLease["metadata"],
        };
      } catch (error) {
        try {
          await client.delete(sandbox.id);
          await verifyDeleted(client, sandbox.id);
        } catch (cleanupError) {
          throw runtimeError(
            "PROVISION_FAILED",
            `daytona setup failed and cleanup could not be verified: ${classifyError(cleanupError).message}`,
            error,
            { provider: "daytona", operation: "acquireLease", details: { sandboxId: sandbox.id } },
          );
        }
        throw error;
      }
    },

    async resumeLease(
      ctx: RuntimeResumeContext<DaytonaProviderConfig>,
    ): Promise<RuntimeResumeResult> {
      const client = await clientFor(ctx);
      const sandbox = await client.get(ctx.providerLeaseId).catch((error) => {
        if (isNotFound(error)) return null;
        throw classifyError(error);
      });
      if (!sandbox) return { status: "expired", reason: "sandbox not found" };
      if (sandbox.state !== "started") {
        await client.start(sandbox.id).catch((error) => {
          throw classifyError(error);
        });
      }
      const remoteCwd =
        typeof ctx.leaseMetadata?.remoteCwd === "string"
          ? safeRemoteCwd(ctx.leaseMetadata.remoteCwd)
          : await resolveRemoteCwd(client, sandbox.id);
      const expectedNonce =
        typeof ctx.leaseMetadata?.sentinelNonce === "string"
          ? ctx.leaseMetadata.sentinelNonce
          : undefined;
      if (expectedNonce) {
        const sentinel = await readSentinel(client, sandbox.id, remoteCwd);
        if (!sentinel || sentinel.nonce !== expectedNonce || sentinel.provider !== "daytona") {
          return { status: "expired", reason: "workspace sentinel mismatch" };
        }
      }
      return {
        status: "resumed",
        lease: {
          version: 1,
          provider: "daytona",
          providerLeaseId: sandbox.id,
          reusable: true,
          createdAt: now(),
          metadata: {
            provider: "daytona",
            backend: "daytona",
            remoteCwd,
            nativeState: "started",
            resumed: true,
            ...(expectedNonce ? { sentinelNonce: expectedNonce } : {}),
          },
        },
      };
    },

    async realizeWorkspace(
      ctx: RuntimeWorkspaceContext<DaytonaProviderConfig>,
    ): Promise<RuntimeWorkspace> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      const cwd = safeRemoteCwd(ctx.remotePath ?? ctx.lease.metadata.remoteCwd ?? "/workspace");
      if (leaseId) {
        await client.execute(leaseId, {
          command: `mkdir -p ${shellQuote(cwd)}`,
          args: [],
          cwd: "/",
          env: DEFAULT_ENV,
          timeoutMs: 30_000,
        });
      }
      return { cwd, metadata: { provider: "daytona", cwd } };
    },

    async startExecution(
      ctx: RuntimeStartExecutionContext<DaytonaProviderConfig>,
    ): Promise<RuntimeProcessHandle> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) throw runtimeError("EXECUTION_FAILED", "daytona lease has no providerLeaseId");
      for (const key of Object.keys(ctx.request.env ?? {})) assertSafeEnvKey(key);
      return createDaytonaProcessHandle(
        client,
        leaseId,
        ctx.request,
        safeRemoteCwd(ctx.lease.metadata.remoteCwd ?? "/workspace"),
        {
          onStdout: ctx.onStdout,
          onStderr: ctx.onStderr,
        },
      );
    },

    async execute(
      ctx: RuntimeStartExecutionContext<DaytonaProviderConfig>,
    ): Promise<RuntimeExecutionResult> {
      const handle = await this.startExecution(ctx);
      return await handle.wait();
    },

    async releaseLease(ctx: RuntimeReleaseContext<DaytonaProviderConfig>): Promise<{
      disposition: "retained" | "hibernated" | "destroyed";
      fallbackUsed?: boolean;
      warnings?: string[];
    }> {
      const client = await clientFor(ctx);
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) return { disposition: "destroyed", warnings: ["no provider lease id"] };
      const disposition = ctx.disposition;
      if (disposition === "retain") {
        return { disposition: "retained" };
      }
      if (disposition === "hibernate") {
        try {
          await client.stop(leaseId);
          const current = await client.get(leaseId);
          if (current && current.state === "started")
            throw new Error("daytona stop did not halt sandbox");
          return { disposition: "hibernated" };
        } catch (error) {
          try {
            await client.delete(leaseId);
            await verifyDeleted(client, leaseId);
          } catch (cleanupError) {
            throw runtimeError(
              "RELEASE_FAILED",
              `daytona stop failed and deletion could not be verified for lease ${leaseId}`,
              cleanupError,
              {
                provider: "daytona",
                operation: "releaseLease",
                details: { leaseId },
              },
            );
          }
          return {
            disposition: "destroyed",
            fallbackUsed: true,
            warnings: [`stop failed, deleted instead: ${classifyError(error).message}`],
          };
        }
      }
      try {
        await client.delete(leaseId);
        await verifyDeleted(client, leaseId);
      } catch (error) {
        throw runtimeError(
          "RELEASE_FAILED",
          `daytona release could not be verified for lease ${leaseId}`,
          error,
          { provider: "daytona", operation: "releaseLease", details: { leaseId } },
        );
      }
      return { disposition: "destroyed" };
    },

    async destroyLease(
      ctx: RuntimeDestroyContext<DaytonaProviderConfig>,
    ): Promise<{ destroyed: boolean; warnings?: string[] }> {
      const client = await clientFor(ctx);
      const leaseId = ctx.providerLeaseId;
      if (!leaseId) return { destroyed: false, warnings: ["no provider lease id"] };
      try {
        await client.delete(leaseId).catch((error) => {
          if (isNotFound(error)) return;
          throw classifyError(error);
        });
        await verifyDeleted(client, leaseId);
      } catch (error) {
        throw runtimeError(
          "DESTROY_FAILED",
          `daytona deletion could not be verified for lease ${leaseId}`,
          error,
          { provider: "daytona", operation: "destroyLease", details: { leaseId } },
        );
      }
      return { destroyed: true };
    },

    filesystem(lease: RuntimeLease, ctx: RuntimeProviderContext): RuntimeFilesystem {
      return new DaytonaFilesystem({
        clientFor,
        leaseId: lease.providerLeaseId as string,
        remoteCwd: safeRemoteCwd(lease.metadata.remoteCwd ?? "/workspace"),
        credentials: ctx.credentials,
      });
    },
    async exposeEndpoint(ctx) {
      const client = await clientFor(ctx);
      if (!client.preview) {
        throw runtimeError("PROVIDER_UNAVAILABLE", "daytona preview endpoints are unavailable");
      }
      const preview = client.preview;
      const leaseId = ctx.lease.providerLeaseId;
      if (!leaseId) throw runtimeError("LEASE_NOT_FOUND", "daytona endpoint requires a lease");
      // OpenCode sessions and SSE streams can outlive the default one-minute
      // preview. Keep the signed handle alive for ten minutes; callers still
      // receive expiresAt and can refresh it explicitly.
      let current = await preview(leaseId, ctx.port, 600);
      return {
        get url() {
          return current.url;
        },
        get headers() {
          return current.token ? { "x-daytona-preview-token": current.token } : undefined;
        },
        get expiresAt() {
          return current.expiresAt;
        },
        async refresh() {
          current = await preview(leaseId, ctx.port, 600);
          return this;
        },
        async close() {
          if (current.token && client.expirePreview) {
            await client.expirePreview(leaseId, ctx.port, current.token);
          }
        },
      };
    },
  };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return (
    name === "DaytonaNotFoundError" ||
    /not found|notfound/i.test(String((error as Error)?.message ?? error))
  );
}

function safeRemoteCwd(value: string): string {
  const normalized = assertSafeRemotePath(value, undefined, { allowAbsolute: true });
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

async function verifyDeleted(client: DaytonaClientSurface, leaseId: string): Promise<void> {
  let found: { id: string; state?: string } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    found = await client.get(leaseId).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!found) return;
    await delay(500);
  }
  throw runtimeError(
    "DESTROY_FAILED",
    `daytona sandbox ${leaseId} still exists after deletion verification (state=${found?.state ?? "unknown"})`,
  );
}

interface WorkspaceSentinel {
  bindingVersion: number;
  provider: string;
  nonce: string;
}

async function writeSentinel(
  client: DaytonaClientSurface,
  leaseId: string,
  remoteCwd: string,
  sentinel: WorkspaceSentinel,
): Promise<void> {
  const target = `${remoteCwd}/${SENTINEL_FILE}`;
  const content = new TextEncoder().encode(`${JSON.stringify(sentinel)}\n`);
  if (client.fsWrite) {
    await client.fsWrite(leaseId, target, content);
    return;
  }
  const result = await client.execute(leaseId, {
    command: "sh",
    args: [
      "-lc",
      `mkdir -p ${shellQuote(`${remoteCwd}/.aaspai`)} && printf '%s' ${shellQuote(new TextDecoder().decode(content))} > ${shellQuote(target)}`,
    ],
    cwd: "/",
    env: DEFAULT_ENV,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0)
    throw runtimeError("WORKSPACE_FAILED", result.stderr || "failed to write workspace sentinel");
}

async function readSentinel(
  client: DaytonaClientSurface,
  leaseId: string,
  remoteCwd: string,
): Promise<WorkspaceSentinel | null> {
  const target = `${remoteCwd}/${SENTINEL_FILE}`;
  try {
    const content = client.fsRead
      ? await client.fsRead(leaseId, target)
      : new TextEncoder().encode(
          (
            await client.execute(leaseId, {
              command: "cat",
              args: [target],
              cwd: "/",
              env: DEFAULT_ENV,
              timeoutMs: 30_000,
            })
          ).stdout,
        );
    const parsed = JSON.parse(new TextDecoder().decode(content)) as Partial<WorkspaceSentinel>;
    if (
      parsed.bindingVersion !== SENTINEL_VERSION ||
      typeof parsed.provider !== "string" ||
      typeof parsed.nonce !== "string"
    )
      return null;
    return parsed as WorkspaceSentinel;
  } catch {
    return null;
  }
}

async function resolveRemoteCwd(client: DaytonaClientSurface, sandboxId: string): Promise<string> {
  try {
    const pwd = await client.execute(sandboxId, {
      command: "pwd",
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
    const out = (pwd.stdout ?? "").trim();
    return path.posix.join(out.length > 0 ? out : "/", "aaspai-workspace");
  } catch {
    return "/workspace";
  }
}

function createDaytonaProcessHandle(
  client: DaytonaClientSurface,
  leaseId: string,
  request: RuntimeExecutionRequest,
  remoteCwd: string,
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): RuntimeProcessHandle {
  if (client.processSession) {
    return createDaytonaSessionProcessHandle(client, leaseId, request, remoteCwd, hooks);
  }
  const executionId = `exec_${randomUUID()}`;
  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "daytona",
    providerLeaseId: leaseId,
    nativeProcessId: leaseId,
  };
  const startedAt = new Date();
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  const waiters: Array<() => void> = [];
  let stopReason: "timeout" | "cancelled" | undefined;
  let pid: string | undefined;
  let forceKillHandle: NodeJS.Timeout | undefined;
  let abortResolve: (() => void) | undefined;
  let stdinClosed = false;
  const pendingInput: Uint8Array[] = [];
  let appendInput: ((data: Uint8Array) => Promise<void>) | undefined;

  const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

  const run = async (): Promise<void> => {
    const stdoutBuffer = new BoundedByteBuffer({ maxBytes: 1024 * 1024, mode: "tail" });
    const stderrBuffer = new BoundedByteBuffer({ maxBytes: 1024 * 1024, mode: "tail" });
    let exitCode: number | null = null;
    const sessionId = `aaspai-${randomUUID()}`;
    const runDir = `/tmp/${sessionId}`;
    const executionCwd = safeRemoteCwd(request.cwd ?? remoteCwd);
    const stdoutPath = `${runDir}/stdout`;
    const stderrPath = `${runDir}/stderr`;
    const exitPath = `${runDir}/exit`;
    const pidPath = `${runDir}/pid`;
    const cmdParts = [request.command, ...(request.args ?? [])];
    const quotedParts = cmdParts.map(shellQuote);
    const envInline = Object.entries(request.env ?? {})
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const commandLine = request.shell
      ? [request.command, ...request.args.map(shellQuote)].join(" ")
      : quotedParts.join(" ");
    const invocation = envInline.length > 0 ? `env ${envInline} ${commandLine}` : commandLine;
    // Always materialize a stdin file so callers can attach live input before
    // the remote launch has completed. Providers with a native process
    // session can replace this file bridge with their session input API.
    const stdinPath = `${runDir}/stdin`;
    const command = `cd ${shellQuote(executionCwd)} && ${invocation}${stdinPath ? ` < ${shellQuote(stdinPath)}` : ""}`;

    const timeoutMs = request.timeoutMs ?? 300_000;
    const stopped = new Promise<void>((resolve) => {
      abortResolve = resolve;
    });
    const timeoutHandle = setTimeout(() => {
      requestStop("timeout");
    }, timeoutMs);
    timeoutHandle.unref();

    try {
      const prepared = await client.execute(leaseId, {
        command: `mkdir -p ${shellQuote(runDir)}`,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      });
      if (prepared.exitCode !== 0)
        throw new Error(
          prepared.stderr ||
            `failed to prepare process session (exitCode=${String(prepared.exitCode)}, stdout=${String(prepared.stdout ?? "")})`,
        );
      await writeRemoteInput(client, leaseId, stdinPath, new Uint8Array(), false);
      if (stdinPath && request.stdin !== undefined) {
        const content =
          typeof request.stdin === "string"
            ? new TextEncoder().encode(request.stdin)
            : request.stdin;
        await writeRemoteInput(client, leaseId, stdinPath, content, false);
      }
      if (stopReason) throw new Error("daytona execution stopped before launch");
      const childScript = `${command}; code=$?; printf '%s' "$code" > ${shellQuote(exitPath)}`;
      const launch = [
        `setsid sh -lc ${shellQuote(childScript)}`,
        `> ${shellQuote(stdoutPath)}`,
        `2> ${shellQuote(stderrPath)}`,
        "< /dev/null",
        `& echo $! > ${shellQuote(pidPath)}`,
      ].join(" ");
      const launched = await client.execute(leaseId, {
        command: launch,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      });
      if (launched.exitCode !== 0)
        throw new Error(launched.stderr || "daytona failed to launch command");

      appendInput = async (content) => {
        if (stdinClosed) return;
        await writeRemoteInput(client, leaseId, stdinPath ?? `${runDir}/stdin`, content, true);
      };
      for (const content of pendingInput.splice(0)) await appendInput(content);

      const pidResult = await client.execute(leaseId, {
        command: `cat ${shellQuote(pidPath)} 2>/dev/null || true`,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      });
      pid = (pidResult.stdout ?? "").trim();
      if (/^\d+$/.test(pid)) {
        identity.nativeProcessId = pid;
        identity.pid = Number(pid);
        identity.processGroupId = Number(pid);
      }

      let stdoutOffset = 0;
      let stderrOffset = 0;
      const drain = async (): Promise<void> => {
        if (client.fsRead) {
          const outBuf = await client.fsRead(leaseId, stdoutPath).catch(() => new Uint8Array());
          if (outBuf.byteLength > stdoutOffset) {
            const chunk = outBuf.subarray(stdoutOffset);
            stdoutBuffer.append(chunk);
            await hooks.onStdout?.(chunk);
          }
          stdoutOffset = outBuf.byteLength;
          const errBuf = await client.fsRead(leaseId, stderrPath).catch(() => new Uint8Array());
          if (errBuf.byteLength > stderrOffset) {
            const chunk = errBuf.subarray(stderrOffset);
            stderrBuffer.append(chunk);
            await hooks.onStderr?.(chunk);
          }
          stderrOffset = errBuf.byteLength;
        }
      };

      while (!stopReason) {
        await drain();
        const status = await client.execute(leaseId, {
          command: `test -f ${shellQuote(exitPath)} && cat ${shellQuote(exitPath)} || true`,
          args: [],
          cwd: "/",
          env: DEFAULT_ENV,
          timeoutMs: 30_000,
        });
        const value = (status.stdout ?? "").trim();
        if (/^\d+$/.test(value)) {
          exitCode = Number(value);
          break;
        }
        await Promise.race([delay(250), stopped]);
      }

      if (stopReason) {
        await terminateRemote("TERM");
        const deadline = Date.now() + (request.graceMs ?? 5_000);
        while (Date.now() < deadline) {
          const status = await client.execute(leaseId, {
            command: `test -f ${shellQuote(exitPath)} && cat ${shellQuote(exitPath)} || true`,
            args: [],
            cwd: "/",
            env: DEFAULT_ENV,
            timeoutMs: 30_000,
          });
          if (/^\d+$/.test((status.stdout ?? "").trim())) {
            exitCode = Number((status.stdout ?? "").trim());
            break;
          }
          await delay(100);
        }
        if (exitCode === null) {
          await terminateRemote("KILL");
        }
      }
      await drain();
      const finishedAt = new Date();
      result = {
        status:
          stopReason === "cancelled"
            ? "cancelled"
            : stopReason === "timeout"
              ? "timed_out"
              : (exitCode ?? 0) === 0
                ? "completed"
                : "failed",
        exitCode: stopReason ? null : exitCode,
        signal: stopReason ? (stopReason === "cancelled" ? "SIGTERM" : "SIGTERM") : undefined,
        terminationReason:
          stopReason === "cancelled"
            ? "cancelled"
            : stopReason === "timeout"
              ? "timeout"
              : (exitCode ?? 0) === 0
                ? "exit"
                : "exit",
        stdoutTail: stdoutBuffer.toUint8Array(),
        stderrTail: stderrBuffer.toUint8Array(),
        stdoutBytes: stdoutBuffer.totalBytes,
        stderrBytes: stderrBuffer.totalBytes,
        stdoutSha256: stdoutBuffer.sha256,
        stderrSha256: stderrBuffer.sha256,
        stdoutTruncated: stdoutBuffer.isTruncated,
        stderrTruncated: stderrBuffer.isTruncated,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } catch (error) {
      const message = classifyError(error).message;
      stderrBuffer.append(encode(`${message}\n`));
      const finishedAt = new Date();
      result = {
        status:
          stopReason === "cancelled"
            ? "cancelled"
            : stopReason === "timeout"
              ? "timed_out"
              : "failed",
        exitCode: null,
        terminationReason: stopReason ?? "provider_error",
        stdoutTail: stdoutBuffer.toUint8Array(),
        stderrTail: stderrBuffer.toUint8Array(),
        stdoutBytes: stdoutBuffer.totalBytes,
        stderrBytes: stderrBuffer.totalBytes,
        stdoutSha256: stdoutBuffer.sha256,
        stderrSha256: stderrBuffer.sha256,
        stdoutTruncated: stdoutBuffer.isTruncated,
        stderrTruncated: stderrBuffer.isTruncated,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } finally {
      clearTimeout(timeoutHandle);
      await client
        .execute(leaseId, {
          command: `rm -rf -- ${shellQuote(runDir)}`,
          args: [],
          cwd: "/",
          env: DEFAULT_ENV,
          timeoutMs: 30_000,
        })
        .catch(() => undefined);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      appendInput = undefined;
      settled = true;
      for (const w of waiters) w();
    }
  };

  async function terminateRemote(
    signal: "TERM" | "KILL" | "INT" | "QUIT" | "HUP" | "STOP" | "CONT",
  ): Promise<void> {
    if (!pid || !/^\d+$/.test(pid)) return;
    await client
      .execute(leaseId, {
        command: `kill -${signal} -- -${pid} 2>/dev/null || kill -${signal} ${pid} 2>/dev/null || true`,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      })
      .catch(() => undefined);
  }

  function requestStop(reason: "timeout" | "cancelled"): void {
    if (stopReason || settled || result) return;
    stopReason = reason;
    void terminateRemote("TERM");
    forceKillHandle = setTimeout(() => void terminateRemote("KILL"), request.graceMs ?? 5_000);
    forceKillHandle.unref();
    abortResolve?.();
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
      requestStop("cancelled");
      await runPromise;
    },
    async signal(signal: RuntimeSignal) {
      const remoteSignal = signal.startsWith("SIG") ? signal.slice(3) : signal;
      await terminateRemote(
        remoteSignal as "TERM" | "KILL" | "INT" | "QUIT" | "HUP" | "STOP" | "CONT",
      );
    },
    async writeStdin(data) {
      if (stdinClosed || settled) return;
      const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (appendInput) await appendInput(content);
      else pendingInput.push(content.slice());
    },
    async closeStdin() {
      stdinClosed = true;
    },
  };
}

/**
 * Native Daytona process-session implementation. The SDK session API gives
 * the provider a durable command id, separated logs, and a real input
 * channel. The file bridge above remains the deterministic fallback for
 * older/fake client surfaces used by migration callers.
 */
function createDaytonaSessionProcessHandle(
  client: DaytonaClientSurface,
  leaseId: string,
  request: RuntimeExecutionRequest,
  remoteCwd: string,
  hooks: {
    onStdout?: (chunk: Uint8Array) => Promise<void> | void;
    onStderr?: (chunk: Uint8Array) => Promise<void> | void;
  },
): RuntimeProcessHandle {
  const processSession = client.processSession;
  if (!processSession) throw new Error("daytona process sessions are unavailable");
  const executionId = `exec_${randomUUID()}`;
  const sessionId = `aaspai-${randomUUID()}`;
  const identity: RuntimeExecutionIdentity = {
    executionId,
    provider: "daytona",
    providerLeaseId: leaseId,
    nativeProcessId: leaseId,
  };
  let settled = false;
  let result: RuntimeExecutionResult | undefined;
  let commandId: string | undefined;
  let pid: string | undefined;
  let stopReason: "timeout" | "cancelled" | undefined;
  let stdinClosed = false;
  const pendingInput: Uint8Array[] = [];
  let forceKillHandle: NodeJS.Timeout | undefined;
  let abortResolve: (() => void) | undefined;
  const waiters: Array<() => void> = [];

  const run = async (): Promise<void> => {
    const stdoutBuffer = new BoundedByteBuffer({ maxBytes: 1024 * 1024, mode: "tail" });
    const stderrBuffer = new BoundedByteBuffer({ maxBytes: 1024 * 1024, mode: "tail" });
    const startedAt = new Date();
    const runDir = `/tmp/${sessionId}`;
    const pidPath = `${runDir}/pid`;
    const executionCwd = safeRemoteCwd(request.cwd ?? remoteCwd);
    const commandLine = request.shell
      ? [request.command, ...(request.args ?? []).map(shellQuote)].join(" ")
      : [request.command, ...(request.args ?? [])].map(shellQuote).join(" ");
    const envInline = Object.entries(request.env ?? {})
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const invocation = envInline.length > 0 ? `env ${envInline} ${commandLine}` : commandLine;
    const stopped = new Promise<void>((resolve) => {
      abortResolve = resolve;
    });
    const timeoutHandle = setTimeout(() => requestStop("timeout"), request.timeoutMs ?? 300_000);
    timeoutHandle.unref();
    let previousStdout = "";
    let previousStderr = "";
    let exitCode: number | null = null;

    const appendLogs = async (): Promise<void> => {
      const logs = await processSession.getLogs(leaseId, sessionId, commandId as string);
      const stdout = logs.stdout ?? "";
      const stderr = logs.stderr ?? "";
      const stdoutDelta = stdout.startsWith(previousStdout)
        ? stdout.slice(previousStdout.length)
        : stdout;
      const stderrDelta = stderr.startsWith(previousStderr)
        ? stderr.slice(previousStderr.length)
        : stderr;
      previousStdout = stdout;
      previousStderr = stderr;
      if (stdoutDelta.length > 0) {
        const bytes = new TextEncoder().encode(stdoutDelta);
        stdoutBuffer.append(bytes);
        try {
          await hooks.onStdout?.(bytes);
        } catch {
          // Output observers cannot take ownership of process failure.
        }
      }
      if (stderrDelta.length > 0) {
        const bytes = new TextEncoder().encode(stderrDelta);
        stderrBuffer.append(bytes);
        try {
          await hooks.onStderr?.(bytes);
        } catch {
          // Output observers cannot take ownership of process failure.
        }
      }
    };

    try {
      const prepared = await client.execute(leaseId, {
        command: `mkdir -p ${shellQuote(runDir)}`,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      });
      if (prepared.exitCode !== 0)
        throw new Error(
          prepared.stderr ||
            `failed to prepare process session (exitCode=${String(prepared.exitCode)}, stdout=${String(prepared.stdout ?? "")})`,
        );
      if (stopReason) throw new Error("daytona execution stopped before launch");
      await processSession.create(leaseId, sessionId);
      const launched = await processSession.execute(leaseId, sessionId, {
        // Some Daytona daemon versions leave getSessionCommand().exitCode
        // unset for completed async commands. The wrapper writes an explicit
        // exit marker so completion remains durable and provider-neutral.
        command: `cd ${shellQuote(executionCwd)} && echo $$ > ${shellQuote(pidPath)}; ${invocation}; code=$?; printf '%s' "$code" > ${shellQuote(`${runDir}/exit`)}`,
        runAsync: true,
        suppressInputEcho: true,
      });
      commandId = launched.commandId;
      identity.nativeProcessId = commandId;
      previousStdout = launched.stdout ?? "";
      previousStderr = launched.stderr ?? "";
      if (previousStdout) {
        const bytes = new TextEncoder().encode(previousStdout);
        stdoutBuffer.append(bytes);
        try {
          await hooks.onStdout?.(bytes);
        } catch {
          // Output observers cannot take ownership of process failure.
        }
      }
      if (previousStderr) {
        const bytes = new TextEncoder().encode(previousStderr);
        stderrBuffer.append(bytes);
        try {
          await hooks.onStderr?.(bytes);
        } catch {
          // Output observers cannot take ownership of process failure.
        }
      }
      pid = await readRemotePid(client, leaseId, pidPath);
      if (pid) {
        identity.pid = Number(pid);
        identity.processGroupId = Number(pid);
      }
      if (request.stdin !== undefined) {
        const initial =
          typeof request.stdin === "string"
            ? new TextEncoder().encode(request.stdin)
            : request.stdin;
        await sendNativeInput(initial);
        stdinClosed = true;
        await processSession
          .sendInput(leaseId, sessionId, commandId, "\u0004")
          .catch(() => undefined);
      }
      for (const input of pendingInput.splice(0)) await sendNativeInput(input);
      while (!stopReason) {
        await appendLogs().catch(() => undefined);
        const status = await processSession.getCommand(leaseId, sessionId, commandId);
        if (typeof status.exitCode === "number") {
          exitCode = status.exitCode;
          break;
        }
        const marker = await readRemoteExitCode(client, leaseId, `${runDir}/exit`);
        if (marker !== undefined) {
          exitCode = marker;
          break;
        }
        await Promise.race([delay(100), stopped]);
      }
      if (stopReason) {
        await terminateRemote("TERM");
        const deadline = Date.now() + (request.graceMs ?? 5_000);
        while (Date.now() < deadline) {
          const status = await processSession.getCommand(leaseId, sessionId, commandId);
          if (typeof status.exitCode === "number") {
            exitCode = status.exitCode;
            break;
          }
          const marker = await readRemoteExitCode(client, leaseId, `${runDir}/exit`);
          if (marker !== undefined) {
            exitCode = marker;
            break;
          }
          await delay(100);
        }
        if (exitCode === null) {
          await terminateRemote("KILL");
          const killDeadline = Date.now() + Math.max(1_000, request.graceMs ?? 5_000);
          while (Date.now() < killDeadline) {
            const status = await processSession
              .getCommand(leaseId, sessionId, commandId)
              .catch((): { exitCode?: number } => ({}));
            if (typeof status.exitCode === "number") {
              exitCode = status.exitCode;
              break;
            }
            const marker = await readRemoteExitCode(client, leaseId, `${runDir}/exit`);
            if (marker !== undefined) {
              exitCode = marker;
              break;
            }
            await delay(100);
          }
        }
      }
      await appendLogs().catch(() => undefined);
      const finishedAt = new Date();
      result = {
        status:
          stopReason === "cancelled"
            ? "cancelled"
            : stopReason === "timeout"
              ? "timed_out"
              : exitCode === 0
                ? "completed"
                : "failed",
        exitCode: stopReason ? null : exitCode,
        signal: stopReason ? "SIGTERM" : undefined,
        terminationReason:
          stopReason === "cancelled" ? "cancelled" : stopReason === "timeout" ? "timeout" : "exit",
        stdoutTail: stdoutBuffer.toUint8Array(),
        stderrTail: stderrBuffer.toUint8Array(),
        stdoutBytes: stdoutBuffer.totalBytes,
        stderrBytes: stderrBuffer.totalBytes,
        stdoutSha256: stdoutBuffer.sha256,
        stderrSha256: stderrBuffer.sha256,
        stdoutTruncated: stdoutBuffer.isTruncated,
        stderrTruncated: stderrBuffer.isTruncated,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } catch (error) {
      const message = classifyError(error).message;
      stderrBuffer.append(new TextEncoder().encode(`${message}\n`));
      const finishedAt = new Date();
      result = {
        status:
          stopReason === "cancelled"
            ? "cancelled"
            : stopReason === "timeout"
              ? "timed_out"
              : "failed",
        exitCode: null,
        signal: stopReason ? "SIGTERM" : undefined,
        terminationReason: stopReason ?? "provider_error",
        stderrTail: stderrBuffer.toUint8Array(),
        stdoutTail: stdoutBuffer.toUint8Array(),
        stdoutBytes: stdoutBuffer.totalBytes,
        stderrBytes: stderrBuffer.totalBytes,
        stdoutSha256: stdoutBuffer.sha256,
        stderrSha256: stderrBuffer.sha256,
        stdoutTruncated: stdoutBuffer.isTruncated,
        stderrTruncated: stderrBuffer.isTruncated,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        identity,
      };
    } finally {
      clearTimeout(timeoutHandle);
      await processSession.delete(leaseId, sessionId).catch(() => undefined);
      await client
        .execute(leaseId, {
          command: `rm -rf -- ${shellQuote(runDir)}`,
          args: [],
          cwd: "/",
          env: DEFAULT_ENV,
          timeoutMs: 30_000,
        })
        .catch(() => undefined);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      settled = true;
      for (const waiter of waiters) waiter();
    }
  };

  async function sendNativeInput(data: Uint8Array): Promise<void> {
    if (!commandId || stdinClosed) return;
    await processSession?.sendInput(leaseId, sessionId, commandId, new TextDecoder().decode(data));
  }
  async function terminateRemote(
    signal: "TERM" | "KILL" | "INT" | "QUIT" | "HUP" | "STOP" | "CONT",
  ): Promise<void> {
    if (!pid || !/^\d+$/.test(pid)) return;
    await client
      .execute(leaseId, {
        command: `kill -${signal} -- -${pid} 2>/dev/null || kill -${signal} ${pid} 2>/dev/null || true`,
        args: [],
        cwd: "/",
        env: DEFAULT_ENV,
        timeoutMs: 30_000,
      })
      .catch(() => undefined);
  }

  function requestStop(reason: "timeout" | "cancelled"): void {
    if (stopReason || settled) return;
    stopReason = reason;
    void terminateRemote("TERM");
    forceKillHandle = setTimeout(() => void terminateRemote("KILL"), request.graceMs ?? 5_000);
    forceKillHandle.unref();
    abortResolve?.();
  }

  const sessionPromise = run();

  return {
    executionId,
    identity,
    async wait() {
      if (settled && result) return result;
      await sessionPromise;
      return result as RuntimeExecutionResult;
    },
    async cancel() {
      requestStop("cancelled");
      await sessionPromise;
    },
    async signal(signal: RuntimeSignal) {
      const remoteSignal = signal.startsWith("SIG") ? signal.slice(3) : signal;
      await terminateRemote(
        remoteSignal as "TERM" | "KILL" | "INT" | "QUIT" | "HUP" | "STOP" | "CONT",
      );
    },
    async writeStdin(data) {
      if (stdinClosed || settled) return;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (commandId) {
        await processSession.sendInput(
          leaseId,
          sessionId,
          commandId,
          new TextDecoder().decode(bytes),
        );
      } else {
        pendingInput.push(bytes.slice());
      }
    },
    async closeStdin() {
      stdinClosed = true;
      if (commandId)
        await processSession
          .sendInput(leaseId, sessionId, commandId, "\u0004")
          .catch(() => undefined);
    },
  };
}

async function readRemotePid(
  client: DaytonaClientSurface,
  leaseId: string,
  pidPath: string,
): Promise<string | undefined> {
  const response = await client
    .execute(leaseId, {
      command: `cat ${shellQuote(pidPath)} 2>/dev/null || true`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    })
    .catch(() => undefined);
  const pid = response?.stdout?.trim();
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

async function readRemoteExitCode(
  client: DaytonaClientSurface,
  leaseId: string,
  exitPath: string,
): Promise<number | undefined> {
  const response = await client
    .execute(leaseId, {
      command: `cat ${shellQuote(exitPath)} 2>/dev/null || true`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    })
    .catch(() => undefined);
  const value = response?.stdout?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

async function writeRemoteInput(
  client: DaytonaClientSurface,
  leaseId: string,
  remotePath: string,
  content: Uint8Array,
  append: boolean,
): Promise<void> {
  if (!append && client.fsWrite) {
    await client.fsWrite(leaseId, remotePath, content);
    return;
  }
  if (append && client.fsAppend) {
    await client.fsAppend(leaseId, remotePath, content);
    return;
  }
  const encoded = Buffer.from(content).toString("base64");
  const operator = append ? ">>" : ">";
  const result = await client.execute(leaseId, {
    command: "sh",
    args: [
      "-lc",
      `printf '%s' ${shellQuote(encoded)} | base64 -d ${operator} ${shellQuote(remotePath)}`,
    ],
    cwd: "/",
    env: DEFAULT_ENV,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || "failed to write remote stdin");
}

class DaytonaFilesystem implements RuntimeFilesystem {
  constructor(
    private readonly ctx: {
      clientFor: (c: {
        credentials?: Record<string, string | undefined>;
      }) => Promise<DaytonaClientSurface>;
      leaseId: string;
      remoteCwd: string;
      credentials?: Record<string, string | undefined>;
    },
  ) {}

  private async client(): Promise<DaytonaClientSurface> {
    return await this.ctx.clientFor({ credentials: this.ctx.credentials });
  }

  private target(path: string): string {
    // Daytona's native filesystem API uses absolute sandbox paths. Keep that
    // convention for compatibility while still rejecting traversal segments;
    // relative paths remain rooted under the realized workspace.
    if (path.startsWith("/")) {
      return assertSafeRemotePath(path, undefined, { allowAbsolute: true });
    }
    if (path === ".") return this.ctx.remoteCwd;
    return assertSafeRemotePath(path, this.ctx.remoteCwd);
  }

  async mkdir(path: string): Promise<void> {
    const client = await this.client();
    const target = this.target(path);
    await client.execute(this.ctx.leaseId, {
      command: `mkdir -p ${shellQuote(target)}`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
  }

  async read(path: string): Promise<Uint8Array> {
    const client = await this.client();
    const target = this.target(path);
    if (client.fsRead) return await client.fsRead(this.ctx.leaseId, target);
    const r = await client.execute(this.ctx.leaseId, {
      command: `base64 -w0 ${shellQuote(target)} 2>/dev/null || base64 ${shellQuote(target)}`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0)
      throw runtimeError("FILESYSTEM_FAILED", r.stderr || "daytona read failed");
    return new Uint8Array(Buffer.from(r.stdout.trim(), "base64"));
  }

  async write(target: string, content: Uint8Array): Promise<void> {
    const client = await this.client();
    const safeTarget = this.target(target);
    if (client.fsWrite) {
      await client.fsWrite(this.ctx.leaseId, safeTarget, content);
      return;
    }
    await client.execute(this.ctx.leaseId, {
      command: `mkdir -p ${shellQuote(path.posix.dirname(safeTarget))}`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
    const encoded = Buffer.from(content).toString("base64");
    const result = await client.execute(this.ctx.leaseId, {
      command: "sh",
      args: ["-lc", `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(safeTarget)}`],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw runtimeError("FILESYSTEM_FAILED", result.stderr || "daytona write failed");
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const client = await this.client();
    const target = this.target(path);
    if (target === "/" || target === this.ctx.remoteCwd) {
      throw new Error("removing the Daytona workspace root is not allowed");
    }
    await client.execute(this.ctx.leaseId, {
      command: `rm ${options?.recursive === false ? "-f" : "-rf"} ${shellQuote(target)}`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
      timeoutMs: 30_000,
    });
  }

  async list(path: string): Promise<{ name: string; size: number; isDir: boolean }[]> {
    const client = await this.client();
    const target = this.target(path);
    const r = await client.execute(this.ctx.leaseId, {
      command: `cd ${shellQuote(target)} && find . -mindepth 1 -maxdepth 1 -printf '%f|%s|%y\\n'`,
      args: [],
      cwd: "/",
      env: DEFAULT_ENV,
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

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.write(remotePath, new Uint8Array(await readFile(localPath)));
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await writeFile(localPath, await this.read(remotePath));
  }
}

export function createDaytonaProviderFromConfig(
  input: unknown,
  options: { credentials?: { apiKey?: string; apiUrl?: string }; clock?: RuntimeClock } = {},
): Promise<RuntimeProvider<DaytonaProviderConfig>> {
  try {
    const parsed = normalizeDaytonaConfig(input ?? {});
    return Promise.resolve(createDaytonaProvider(parsed, options));
  } catch (error) {
    throw runtimeError(
      "CONFIG_INVALID",
      error instanceof Error ? error.message : "invalid daytona config",
      error,
    );
  }
}
