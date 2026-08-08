import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type AdapterExecutionContext,
  type AdapterExecutionResult,
  HARNESS_PROTOCOL_VERSION,
} from "@aaspai/contracts/harness";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import { opencodeServer, shutdownManagedOpenCodeServers } from "@aaspai/opencode/server";
import type {
  RuntimeExecutionRequest,
  RuntimeExecutionResult,
  RuntimeLease,
} from "@aaspai/runtime";
import {
  createDaytonaProvider,
  type DaytonaProviderConfig,
  RuntimeController,
} from "@aaspai/runtime";

type Status = "passed" | "failed" | "warning" | "skipped";
type AnyRecord = Record<string, unknown>;

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reportDir = resolve(repoRoot, ".aaspai", "artifacts", "real-production-smoke");
const startedAt = new Date().toISOString();
const runId = `real-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const phases: Array<{
  name: string;
  status: Status;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  details?: unknown;
  error?: string;
}> = [];
const loadedSecrets: string[] = [];
const report: AnyRecord = {
  runId,
  startedAt,
  finishedAt: null,
  status: "running",
  config: {},
  sandbox: {},
  phases,
  artifacts: {
    directory: reportDir,
    json: join(reportDir, "report.json"),
    html: join(reportDir, "report.html"),
  },
};

async function loadEnv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
  }
  return values;
}

function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of loadedSecrets) {
    if (secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    );
}

function readRuntimeEnv(key: string): string | undefined {
  return process.env[key];
}

function text(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  return new TextDecoder().decode(bytes).slice(-16_384);
}

function safeResult(result: RuntimeExecutionResult): AnyRecord {
  return {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    terminationReason: result.terminationReason,
    durationMs: result.durationMs,
    stdout: text(result.stdoutTail),
    stderr: text(result.stderrTail),
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    identity: result.identity,
  };
}

function safeAdapterResult(result: AdapterExecutionResult): AnyRecord {
  const output = result.resultJson as AnyRecord | undefined;
  return {
    status: result.status,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    sessionParams: result.sessionParams,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    summary: result.summary?.slice(0, 8_192),
    errorCode: result.errorCode,
    errorMessage: result.errorMessage ? redact(result.errorMessage) : undefined,
    toolEvents: output?.toolEvents,
    toolsInvoked: output?.toolsInvoked,
  };
}

async function phase<T>(
  name: string,
  fn: () => Promise<T>,
  statusOnSuccess: Status = "passed",
): Promise<T | undefined> {
  const entry: (typeof phases)[number] = {
    name,
    status: "passed",
    startedAt: new Date().toISOString(),
  };
  phases.push(entry);
  const start = Date.now();
  try {
    const details = await fn();
    entry.status = statusOnSuccess;
    entry.details = details;
    entry.finishedAt = new Date().toISOString();
    entry.durationMs = Date.now() - start;
    console.log(`[${entry.status}] ${name}`);
    return details;
  } catch (error) {
    entry.status = "failed";
    entry.error = redact(error);
    entry.finishedAt = new Date().toISOString();
    entry.durationMs = Date.now() - start;
    console.error(`[failed] ${name}: ${entry.error}`);
    return undefined;
  }
}

function skip(name: string, reason: string): void {
  phases.push({
    name,
    status: "skipped",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    details: { reason },
  });
  console.log(`[skipped] ${name}: ${reason}`);
}

function toLegacyResult(result: RuntimeExecutionResult): RunProcessResult {
  return {
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    timedOut: result.status === "timed_out",
    stdout: text(result.stdoutTail),
    stderr: text(result.stderrTail),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    runtimeIdentity: {
      kind: "sandbox",
      cwd: result.identity.providerLeaseId ?? "daytona",
      ...(result.identity.pid ? { pid: result.identity.pid } : {}),
      ...(result.identity.nativeProcessId
        ? { remotePid: Number(result.identity.nativeProcessId) || undefined }
        : {}),
      connectionIdentity: `daytona:${result.identity.providerLeaseId ?? "unknown"}`,
    },
  };
}

async function main(): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(reportDir, { recursive: true }));
  const envPath = resolve(repoRoot, ".env.local");
  const env = await loadEnv(envPath);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && value.length >= 4) loadedSecrets.push(value);
  }
  const apiKey = env.DAYTONA_API_KEY?.trim() ?? readRuntimeEnv("DAYTONA_API_KEY")?.trim() ?? "";
  const opencodeKey =
    env.OPENCODE_API_KEY?.trim() ?? readRuntimeEnv("OPENCODE_API_KEY")?.trim() ?? "";
  if (apiKey.length >= 4) loadedSecrets.push(apiKey);
  if (opencodeKey.length >= 4) loadedSecrets.push(opencodeKey);
  const model =
    env.AASPAI_OPENCODE_MODEL ??
    env.OPENCODE_MODEL ??
    readRuntimeEnv("AASPAI_OPENCODE_MODEL") ??
    "opencode-go/mimo-v2.5";
  const opencodeCommand = env.OPENCODE_COMMAND ?? readRuntimeEnv("OPENCODE_COMMAND") ?? "opencode";
  const expectedOpenCodeVersion =
    env.REAL_SMOKE_OPENCODE_VERSION ?? readRuntimeEnv("REAL_SMOKE_OPENCODE_VERSION") ?? "1.18.15";
  const snapshot = env.DAYTONA_SNAPSHOT ?? readRuntimeEnv("DAYTONA_SNAPSHOT");
  const configInput: DaytonaProviderConfig = {
    ...(snapshot ? { snapshot } : {}),
    ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    ...(env.DAYTONA_TARGET ? { target: env.DAYTONA_TARGET } : {}),
    timeoutMs: 300_000,
    autoStopMinutes: 15,
    autoArchiveMinutes: 60,
    autoDeleteMinutes: 7 * 24 * 60,
  };
  report.config = {
    envFile: envPath,
    envFileFound: existsSync(envPath),
    credentials: {
      daytonaConfigured: apiKey.length > 0,
      opencodeConfigured: opencodeKey.length > 0,
    },
    model,
    opencodeCommand,
    expectedOpenCodeVersion,
    compatibilityOverride: expectedOpenCodeVersion !== "1.18.15",
    snapshotConfigured: Boolean(snapshot),
    providerEnvironmentKeys: Object.keys(env).filter((key) =>
      /^(OPENAI|ANTHROPIC|GOOGLE|OPENROUTER|OPENCODE)_/i.test(key),
    ),
    secretsPersisted: false,
  };
  if (!apiKey) {
    await phase("preflight.credentials", async () => {
      throw new Error("DAYTONA_API_KEY is not configured in .env.local or the environment");
    });
    return;
  }
  if (!opencodeKey) {
    await phase("preflight.credentials", async () => {
      throw new Error("OPENCODE_API_KEY is not configured in .env.local or the environment");
    });
  } else {
    await phase("preflight.credentials", async () => ({
      daytona: true,
      opencode: true,
      envKeys: Object.keys(env),
    }));
  }

  const provider = createDaytonaProvider(configInput, { credentials: { apiKey } });
  const controller = new RuntimeController({ provider, credentials: { apiKey } });
  const validation = await phase("daytona.validate-config", async () => {
    const result = await controller.validateConfig(configInput);
    if (!result.ok) throw new Error(result.errors.join("; "));
    return {
      normalized: {
        ...result.normalizedConfig,
        apiUrl: result.normalizedConfig.apiUrl ? "configured" : undefined,
      },
    };
  });
  const config = validation
    ? (
        (await controller.validateConfig(configInput)) as {
          ok: true;
          normalizedConfig: DaytonaProviderConfig;
        }
      ).normalizedConfig
    : configInput;
  await phase("daytona.probe", () =>
    controller.probe(config, { "aaspai-test": "real-production-smoke" }),
  );

  let lease: RuntimeLease | undefined;
  let workspaceCwd = "/workspace";
  let localScratch: string | undefined;
  const providerEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        /^(OPENAI|ANTHROPIC|GOOGLE|OPENROUTER|OPENCODE)_/i.test(key) && value.length > 0,
    ),
  );
  const run = async (
    request: RuntimeExecutionRequest,
    hooks?: { stdout?: (chunk: Uint8Array) => void; stderr?: (chunk: Uint8Array) => void },
  ): Promise<RuntimeExecutionResult> => {
    if (!lease) throw new Error("Daytona lease is not available");
    return await controller.execute(config, lease, request, {
      onStdout: (chunk) => {
        hooks?.stdout?.(chunk);
      },
      onStderr: (chunk) => {
        hooks?.stderr?.(chunk);
      },
    });
  };

  try {
    const acquired = await phase("daytona.acquire", async () => {
      lease = await controller.acquire(config, {
        labels: { "aaspai-test": "real-production-smoke", "aaspai-run": runId },
      });
      report.sandbox = {
        provider: "daytona",
        leaseId: lease.providerLeaseId,
        reusable: lease.reusable,
        metadata: { ...lease.metadata, sentinelNonce: "[present]" },
      };
      return { leaseId: lease.providerLeaseId, metadataKeys: Object.keys(lease.metadata) };
    });
    if (!acquired || !lease) {
      skip("daytona.workspace", "lease acquisition failed");
      skip("daytona.processes", "lease acquisition failed");
      skip("daytona.endpoint", "lease acquisition failed");
      skip("opencode.server", "lease acquisition failed");
      return;
    }
    const workspace = await phase("daytona.workspace", async () => {
      const realized = await controller.realize(config, lease as RuntimeLease);
      workspaceCwd = realized.cwd;
      const filesystem = controller.filesystem(lease as RuntimeLease);
      await filesystem.mkdir("smoke");
      const bytes = Uint8Array.from({ length: 4096 }, (_, index) => (index * 73 + 19) % 256);
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      await filesystem.write("smoke/binary.bin", bytes);
      const roundTrip = await filesystem.read("smoke/binary.bin");
      if (Buffer.from(roundTrip).compare(Buffer.from(bytes)) !== 0)
        throw new Error("binary filesystem round-trip mismatch");
      localScratch = await mkdtemp(join(tmpdir(), "aaspai-real-smoke-"));
      const localInput = join(localScratch, "upload.bin");
      const localOutput = join(localScratch, "download.bin");
      await writeFile(localInput, bytes);
      if (!filesystem.uploadFile || !filesystem.downloadFile)
        throw new Error("Daytona filesystem does not expose upload/download");
      await filesystem.uploadFile(localInput, "smoke/upload.bin");
      await filesystem.downloadFile("smoke/upload.bin", localOutput);
      const downloaded = await readFile(localOutput);
      if (downloaded.compare(Buffer.from(bytes)) !== 0)
        throw new Error("upload/download round-trip mismatch");
      return {
        cwd: workspaceCwd,
        binaryBytes: bytes.length,
        sha256: expectedHash,
        uploadDownload: true,
      };
    });
    if (!workspace) skip("daytona.processes", "workspace phase failed");
    else {
      await phase("daytona.processes", async () => {
        const streamChunks: string[] = [];
        const basic = await run({
          command: "node",
          args: ["-e", "process.stdout.write('stdout-ok'); process.stderr.write('stderr-ok')"],
          cwd: workspaceCwd,
          timeoutMs: 30_000,
        });
        if (basic.status !== "completed" || basic.exitCode !== 0)
          throw new Error(`basic process failed: ${JSON.stringify(safeResult(basic))}`);
        // Use a process that exits after its first data event. This verifies
        // live delivery without depending on a daemon-specific EOF encoding
        // (Daytona's session API transports Ctrl-D as input, not EOF).
        const stdinHandle = await controller.start(config, lease as RuntimeLease, {
          command: "node",
          args: [
            "-e",
            "process.stdin.setEncoding('utf8'); process.stdin.once('data', value => { process.stdout.write('stdin:' + value.trim()); process.exit(0) })",
          ],
          cwd: workspaceCwd,
          timeoutMs: 30_000,
        });
        await delay(500);
        await stdinHandle.writeStdin?.("live-input\n");
        const stdin = await stdinHandle.wait();
        if (!text(stdin.stdoutTail).includes("stdin:live-input"))
          throw new Error(`stdin failed: ${JSON.stringify(safeResult(stdin))}`);
        const streamed = await run(
          {
            command: "sh",
            args: ["-lc", "printf one; sleep .2; printf two; printf err >&2"],
            cwd: workspaceCwd,
            timeoutMs: 30_000,
          },
          { stdout: (chunk) => streamChunks.push(text(chunk)) },
        );
        if (streamed.status !== "completed" || !text(streamed.stdoutTail).includes("onetwo"))
          throw new Error(`stream failed: ${JSON.stringify(safeResult(streamed))}`);
        const cancelledHandle = await controller.start(config, lease as RuntimeLease, {
          command: "sh",
          args: ["-lc", "sleep 30"],
          cwd: workspaceCwd,
          timeoutMs: 30_000,
        });
        await delay(500);
        await cancelledHandle.cancel("real-smoke-cancel");
        const cancelled = await cancelledHandle.wait();
        if (cancelled.status !== "cancelled")
          throw new Error(`cancel failed: ${JSON.stringify(safeResult(cancelled))}`);
        const timedOut = await run({
          command: "sh",
          args: ["-lc", "sleep 30"],
          cwd: workspaceCwd,
          timeoutMs: 1_000,
          graceMs: 1_000,
        });
        if (timedOut.status !== "timed_out")
          throw new Error(`timeout failed: ${JSON.stringify(safeResult(timedOut))}`);
        return {
          basic: safeResult(basic),
          stdin: safeResult(stdin),
          streaming: { result: safeResult(streamed), chunks: streamChunks.slice(0, 32) },
          cancellation: safeResult(cancelled),
          timeout: safeResult(timedOut),
        };
      });
    }
    await phase("daytona.endpoint", async () => {
      const port = 18_000 + (randomBytes(2).readUInt16BE(0) % 1_000);
      const source = `require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('AASPAI_ENDPOINT_OK')}).listen(${port},'0.0.0.0')`;
      const handle = await controller.start(config, lease as RuntimeLease, {
        command: "node",
        args: ["-e", source],
        cwd: workspaceCwd,
        timeoutMs: 60_000,
      });
      let endpoint: Awaited<ReturnType<typeof controller.exposeEndpoint>> | undefined;
      try {
        await delay(1_500);
        endpoint = await controller.exposeEndpoint(config, lease as RuntimeLease, port, "http");
        const response = await fetch(endpoint.url, { headers: endpoint.headers });
        const body = await response.text();
        if (!response.ok || body !== "AASPAI_ENDPOINT_OK")
          throw new Error(`endpoint health failed (${response.status}): ${body.slice(0, 200)}`);
        const refreshed = await endpoint.refresh();
        return {
          port,
          url: refreshed.url.replace(/([?&]token=)[^&]+/gi, "$1[REDACTED]"),
          authenticated: Boolean(endpoint.headers),
          health: "AASPAI_ENDPOINT_OK",
        };
      } finally {
        await endpoint?.close().catch(() => undefined);
        await handle.cancel("real-smoke-endpoint-stop").catch(() => undefined);
        await handle.wait().catch(() => undefined);
      }
    });

    const opencodeReady = await phase("opencode.binary", async () => {
      const result = await run({
        command: opencodeCommand,
        args: ["--version"],
        cwd: workspaceCwd,
        timeoutMs: 30_000,
      });
      if (result.status !== "completed" || result.exitCode !== 0)
        throw new Error(`OpenCode command unavailable: ${JSON.stringify(safeResult(result))}`);
      const version = `${text(result.stdoutTail)}${text(result.stderrTail)}`.trim();
      return {
        command: opencodeCommand,
        version,
        expectedCompatibility: expectedOpenCodeVersion,
        exactVersionObserved: version.includes(expectedOpenCodeVersion),
      };
    });
    if (!opencodeReady) {
      skip("opencode.conversation", "OpenCode binary preflight failed");
      skip("opencode.resume", "OpenCode binary preflight failed");
      skip("opencode.question", "OpenCode binary preflight failed");
      skip("opencode.permission", "OpenCode binary preflight failed");
      skip("opencode.fork", "OpenCode binary preflight failed");
    } else {
      const sessionEvents: AnyRecord[] = [];
      const rawEvents: AnyRecord[] = [];
      const questions: AnyRecord[] = [];
      const permissions: AnyRecord[] = [];
      const runtimeBoundary = (): AdapterExecutionContext["execution"] => ({
        identity: {
          kind: "daytona",
          runtimeScope: lease?.providerLeaseId ?? runId,
          stateScope: lease?.providerLeaseId ?? runId,
          cwd: workspaceCwd,
        },
        run: async (options: RunProcessOptions) =>
          toLegacyResult(
            await run({
              command: options.command,
              args: options.args,
              cwd: options.cwd ?? workspaceCwd,
              env: { ...providerEnv, ...(options.env ?? {}) },
              inheritEnv: true,
              ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
              timeoutMs: options.timeoutMs,
              graceMs: options.graceMs,
            }),
          ),
        start: async (options: RunProcessOptions, hooks) => {
          const handle = await controller.start(
            config,
            lease as RuntimeLease,
            {
              command: options.command,
              args: options.args,
              cwd: options.cwd ?? workspaceCwd,
              env: { ...providerEnv, ...(options.env ?? {}) },
              inheritEnv: true,
              ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
              timeoutMs: options.timeoutMs,
              graceMs: options.graceMs,
            },
            { onStdout: hooks?.onStdout, onStderr: hooks?.onStderr },
          );
          return handle;
        },
        exposeEndpoint: async (options) =>
          await controller.exposeEndpoint(
            config,
            lease as RuntimeLease,
            options.port,
            options.protocol,
          ),
      });
      const executeOpenCode = async (
        prompt: string,
        sessionId?: string,
      ): Promise<AdapterExecutionResult> => {
        const context: AdapterExecutionContext = {
          protocolVersion: HARNESS_PROTOCOL_VERSION,
          runId: `${runId}-${randomUUID().slice(0, 8)}`,
          organizationId: "real-smoke",
          agent: {
            id: "real-smoke-agent",
            organizationId: "real-smoke",
            name: "Real Smoke OpenCode",
            adapterType: "opencode_local",
            adapterConfig: {},
          },
          runtime: sessionId ? { sessionId } : {},
          config: {
            model,
            command: opencodeCommand,
            timeoutSec: 120,
            serverStartupTimeoutMs: 60_000,
            serverExpectedVersion: expectedOpenCodeVersion,
            permissions: { bash: "ask", question: "ask" },
          },
          context: {
            cwd: workspaceCwd,
            prompt,
            systemPrompt:
              "You are being exercised by a real integration smoke test. Follow exact output instructions.",
          },
          execution: runtimeBoundary(),
          onLog: () => undefined,
          onEvent: (event) => {
            if (sessionEvents.length < 500) sessionEvents.push(event as unknown as AnyRecord);
          },
          onRawLog: (entry) => {
            if (rawEvents.length < 200)
              rawEvents.push({
                stream: entry.stream,
                chunk: entry.chunk.slice(-4_096),
                ts: entry.ts,
              });
          },
          onQuestion: async (question) => {
            questions.push({ prompt: question.prompt, options: question.options });
            return question.options?.[0] ?? "Yes";
          },
          onPermission: async (permission) => {
            permissions.push({
              toolName: permission.toolName,
              description: permission.description,
            });
            return "once" as const;
          },
        };
        return await opencodeServer.execute(context);
      };
      const first = await phase("opencode.conversation", async () => {
        const result = await executeOpenCode("Reply with exactly SMOKE_OK and nothing else.");
        if (result.status !== "completed")
          throw new Error(
            `OpenCode conversation failed: ${JSON.stringify(safeAdapterResult(result))}`,
          );
        return {
          result: safeAdapterResult(result),
          eventCount: sessionEvents.length,
          rawEventCount: rawEvents.length,
        };
      });
      const sessionId =
        first && typeof (first.result as AnyRecord)?.sessionId === "string"
          ? ((first.result as AnyRecord).sessionId as string)
          : undefined;
      if (!sessionId) {
        skip("opencode.resume", "initial OpenCode run did not return a native session ID");
        skip("opencode.question", "initial OpenCode run did not return a native session ID");
        skip("opencode.permission", "initial OpenCode run did not return a native session ID");
        skip("opencode.fork", "initial OpenCode run did not return a native session ID");
      } else {
        await phase("opencode.resume", async () => {
          const result = await executeOpenCode(
            "If you remember the prior turn, reply with exactly RESUME_OK and nothing else.",
            sessionId,
          );
          if (result.status !== "completed")
            throw new Error(`OpenCode resume failed: ${JSON.stringify(safeAdapterResult(result))}`);
          return { result: safeAdapterResult(result), sessionId, conversationContinued: true };
        });
        const questionPhaseStarted = phases.length;
        await phase("opencode.question", async () => {
          const before = questions.length;
          const result = await executeOpenCode(
            "Use your question tool to ask me one question with options Red and Blue. After I answer, reply exactly QUESTION_OK.",
            sessionId,
          );
          const observed = questions.length > before;
          const interactions = questions.slice(before);
          const optionsReceived = interactions.some(
            (item) => Array.isArray(item.options) && item.options.length >= 2,
          );
          if (result.status !== "completed")
            throw new Error(
              `OpenCode question turn failed: ${JSON.stringify(safeAdapterResult(result))}`,
            );
          return { result: safeAdapterResult(result), observed, optionsReceived, interactions };
        });
        const questionPhase = phases[questionPhaseStarted];
        if (questionPhase?.status === "passed")
          questionPhase.status =
            questions.length > 0 &&
            questions
              .slice(-1)
              .some((item) => Array.isArray(item.options) && item.options.length >= 2)
              ? "passed"
              : "warning";
        const permissionPhaseStarted = phases.length;
        await phase("opencode.permission", async () => {
          const before = permissions.length;
          const result = await executeOpenCode(
            "Run the harmless shell command printf PERMISSION_OK, then reply exactly PERMISSION_OK.",
            sessionId,
          );
          const observed = permissions.length > before;
          if (result.status !== "completed")
            throw new Error(
              `OpenCode permission turn failed: ${JSON.stringify(safeAdapterResult(result))}`,
            );
          return {
            result: safeAdapterResult(result),
            observed,
            interactions: permissions.slice(before),
          };
        });
        const permissionPhase = phases[permissionPhaseStarted];
        if (permissionPhase?.status === "passed")
          permissionPhase.status = permissions.length > 0 ? "passed" : "warning";
        await phase("opencode.fork", async () => {
          if (!opencodeServer.fork) throw new Error("OpenCode adapter does not expose fork");
          const forked = await opencodeServer.fork({ parentSessionId: sessionId });
          if (!forked.forked || !forked.childSessionId)
            throw new Error(`fork failed: ${JSON.stringify(forked)}`);
          const child = await executeOpenCode(
            "Reply with exactly FORK_OK and nothing else.",
            forked.childSessionId,
          );
          if (child.status !== "completed")
            throw new Error(`fork child failed: ${JSON.stringify(safeAdapterResult(child))}`);
          return {
            parentSessionId: sessionId,
            childSessionId: forked.childSessionId,
            result: safeAdapterResult(child),
          };
        });
      }
      report.opencode = {
        sessionId,
        questions,
        permissions,
        semanticEvents: sessionEvents.slice(-100),
        rawEvents: rawEvents.slice(-50),
      };
    }

    await shutdownManagedOpenCodeServers();
    await phase("daytona.hibernate-resume", async () => {
      const hibernated = await controller.release(config, lease as RuntimeLease, "hibernate");
      const restartedProvider = createDaytonaProvider(config, { credentials: { apiKey } });
      const restarted = new RuntimeController({
        provider: restartedProvider,
        credentials: { apiKey },
      });
      const resumed = await restarted.resume(
        config,
        (lease as RuntimeLease).providerLeaseId as string,
        (lease as RuntimeLease).metadata,
      );
      if (resumed.status !== "resumed")
        throw new Error(`resume returned ${resumed.status}: ${resumed.reason ?? "unknown"}`);
      lease = resumed.lease;
      const result = await restarted.execute(config, lease, {
        command: "node",
        args: ["-e", "process.stdout.write('RESUMED_OK')"],
        cwd: workspaceCwd,
        timeoutMs: 30_000,
      });
      if (result.status !== "completed" || !text(result.stdoutTail).includes("RESUMED_OK"))
        throw new Error(`resumed execution failed: ${JSON.stringify(safeResult(result))}`);
      return { hibernated, resumed: true, result: safeResult(result) };
    });
  } finally {
    await shutdownManagedOpenCodeServers();
    if (lease?.providerLeaseId) {
      await phase("daytona.destroy-cleanup", async () => {
        const destroyed = await controller.destroy(
          config,
          lease?.providerLeaseId as string,
          lease?.metadata,
        );
        if (!destroyed.destroyed)
          throw new Error(`Daytona destroy returned false: ${JSON.stringify(destroyed)}`);
        return destroyed;
      });
    }
    if (localScratch)
      await rm(localScratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function htmlEscape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeReport(): Promise<void> {
  const failed = phases.filter((item) => item.status === "failed").length;
  const warnings = phases.filter(
    (item) => item.status === "warning" || item.status === "skipped",
  ).length;
  report.finishedAt = new Date().toISOString();
  report.status = failed > 0 ? "failed" : warnings > 0 ? "partial" : "passed";
  report.summary = {
    overall: report.status,
    passed: phases.filter((item) => item.status === "passed").length,
    failed,
    warnings,
    total: phases.length,
  };
  const summary = report.summary as AnyRecord;
  const json = JSON.stringify(report, null, 2);
  const rows = phases
    .map(
      (item) =>
        `<tr><td>${htmlEscape(item.name)}</td><td class="${item.status}">${htmlEscape(item.status)}</td><td>${htmlEscape(item.durationMs ?? 0)} ms</td><td><pre>${htmlEscape((item.error ?? item.details) ? JSON.stringify(item.error ?? item.details, null, 2) : "")}</pre></td></tr>`,
    )
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>AASP AI real production smoke ${htmlEscape(runId)}</title><style>body{font:14px system-ui;margin:2rem;color:#17202a;background:#f7f8fa}h1{margin-bottom:.25rem}.card{display:inline-block;background:white;border:1px solid #dfe3e8;border-radius:10px;padding:1rem 1.5rem;margin:.5rem 0.5rem .8rem 0}.passed{color:#087f5b}.failed{color:#c92a2a}.warning,.skipped{color:#a15c00}table{width:100%;border-collapse:collapse;background:white}th,td{border:1px solid #dfe3e8;padding:.6rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;max-height:22rem;overflow:auto;margin:0;font-size:12px}</style><h1>Real Daytona + OpenCode smoke</h1><p><code>${htmlEscape(runId)}</code> · ${htmlEscape(report.finishedAt)}</p><div class="card"><strong>Overall</strong><br><span class="${report.status}">${htmlEscape(report.status)}</span></div><div class="card"><strong>Passed</strong><br>${htmlEscape(summary.passed)}</div><div class="card"><strong>Failed</strong><br>${htmlEscape(summary.failed)}</div><div class="card"><strong>Warnings/skips</strong><br>${htmlEscape(summary.warnings)}</div><h2>Phases</h2><table><thead><tr><th>Phase</th><th>Status</th><th>Duration</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table><h2>Configuration (secret-free)</h2><pre>${htmlEscape(JSON.stringify(report.config, null, 2))}</pre><h2>Sandbox</h2><pre>${htmlEscape(JSON.stringify(report.sandbox, null, 2))}</pre><h2>OpenCode observations</h2><pre>${htmlEscape(JSON.stringify(report.opencode ?? {}, null, 2))}</pre>`;
  await writeFile(join(reportDir, "report.json"), json, "utf8");
  await writeFile(join(reportDir, "report.html"), html, "utf8");
  console.log(`Report JSON: ${join(reportDir, "report.json")}`);
  console.log(`Report HTML: ${join(reportDir, "report.html")}`);
}

main()
  .catch((error) => {
    phases.push({
      name: "runner",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: redact(error),
    });
    console.error(`[failed] runner: ${redact(error)}`);
  })
  .finally(async () => {
    await writeReport();
    if (report.status === "failed") process.exitCode = 1;
  });
