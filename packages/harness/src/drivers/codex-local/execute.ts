import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ErrorFamily,
  ServerAdapterModule,
  UsageSummary,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import {
  cancelAcpSession,
  executeAcp,
  resolveAcpEngine,
  testAcpEnvironment,
} from "../../shared/acp.js";
import { buildAgentEnv } from "../../shared/env.js";
import { createJsonlFramer } from "../../shared/jsonl.js";
import { redactCommandText, redactHomePath } from "../../shared/redact.js";
import { runProcess } from "../../shared/run-process.js";
import { acpSessionCodec } from "../../shared/session-codec.js";
import type { CodexStreamEvent } from "./config.js";
import { type CodexLocalConfig, codexLocalInfo, parseCodexLocalConfig } from "./config.js";
import { parseCodexStreamLine } from "./parse.js";

/**
 * Adapter for OpenAI Codex running as a local subprocess.
 *
 * Spawns `codex exec --json` and parses one JSON event per stdout line.
 * OpenAI's host-level `OPENAI_API_KEY` is intentionally scrubbed so a
 * machine-wide key does not leak into a managed run.
 */
export const codexLocal: ServerAdapterModule = {
  info: codexLocalInfo,
  sessionCodec: acpSessionCodec,
  execute,
  testEnvironment,
  cancel: async (request) => cancelAcpSession(request.sessionId),
  describe: () => ({
    type: "codex_local",
    label: codexLocalInfo.label,
    models: [...codexLocalInfo.models],
    nativeTools: ["apply_patch", "shell", "web_search", "view_image"],
    supportsCancel: true,
    supportsCompact: false,
    supportsFork: false,
    supportsResume: true,
    supportsThinking: true,
    supportsForkSession: false,
  }),
};

const SCRUB_ENV_KEYS = new Set(["OPENAI_API_KEY"]);

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let config: CodexLocalConfig;
  try {
    config = parseCodexLocalConfig(ctx.config);
  } catch (err) {
    return buildErrorResult(
      "config",
      "Invalid codex_local config",
      err instanceof Error ? err.message : String(err),
    );
  }
  const engine = await resolveAcpEngine("codex", {
    config: ctx.config,
    cwd: ctx.context.cwd,
    execution: ctx.execution,
    organizationId: ctx.organizationId,
    agentId: ctx.agent.id,
  });
  if (engine.engine === "acp") {
    return executeAcp(ctx, "codex", { timeoutSec: config.timeoutSec });
  }
  if (!engine.explicit && engine.fallbackReason) {
    await ctx.onLog(
      "stderr",
      `[aaspai] Codex ACP unavailable; falling back to CLI. ${engine.fallbackReason}\n`,
    );
  }
  const command = config.command;
  const args = buildCodexArgs(config, ctx);
  const env = {
    ...buildAgentEnv(ctx.agent, {
      runId: ctx.runId,
      sessionId: ctx.runtime.sessionId,
      sessionDisplayId: ctx.runtime.sessionDisplayId,
      cwd: ctx.context.cwd,
      additionalEnv: config.env,
    }),
  };
  // Scrub host-level OPENAI_API_KEY so we don't leak a machine-wide key.
  for (const key of SCRUB_ENV_KEYS) {
    if (!(key in env)) env[key] = "";
  }
  const cwd = config.cwd ?? ctx.context.cwd;
  const stdin = ctx.context.prompt;
  const timeoutMs = (config.timeoutSec ?? 0) * 1000 || undefined;

  const collectedText: string[] = [];
  const collectedErrors: string[] = [];
  const collectedUsage: UsageSummary = {};
  let sessionId: string | undefined;
  const model: string | undefined = config.model;
  let timedOut = false;
  let inactivityTimedOut = false;
  const monitorController = new AbortController();
  const stdoutFramer = createJsonlFramer();
  let sawStdoutLine = false;
  let monitorActive = true;
  let inactivityTimer: NodeJS.Timeout | undefined;
  const resetInactivityTimer = (): void => {
    if (!monitorActive) return;
    clearTimeout(inactivityTimer!);
    inactivityTimer = setTimeout(() => {
      inactivityTimedOut = true;
      monitorController.abort();
    }, config.outputInactivityTimeoutMs);
    inactivityTimer.unref();
  };
  resetInactivityTimer();
  const onAbort = (): void => monitorController.abort();
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });

  const processLine = async (line: string, emit: boolean): Promise<void> => {
    if (line.length === 0) return;
    sawStdoutLine = true;
    resetInactivityTimer();
    const entries = parseCodexStreamLine(line, new Date().toISOString());
    for (const entry of entries) {
      if (entry.kind === "assistant" && typeof entry.text === "string") {
        collectedText.push(entry.text);
      } else if (entry.kind === "init") {
        if (entry.sessionId) sessionId = entry.sessionId;
      }
    }
    if (emit) await ctx.onLog("stdout", line);
  };

  const onLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    if (stream === "stderr") {
      const redacted = redactHomePath(chunk);
      collectedErrors.push(redacted);
      await ctx.onLog(stream, redacted);
    } else {
      for (const line of stdoutFramer.push(chunk)) await processLine(line, true);
    }
  };

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await (ctx.execution?.run ?? runProcess)({
      command,
      args,
      cwd,
      env,
      stdin,
      signal: monitorController.signal,
      timeoutMs,
      graceMs: config.graceSec * 1_000,
      onLog,
    });
  } finally {
    monitorActive = false;
    clearTimeout(inactivityTimer!);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
  for (const line of stdoutFramer.flush()) await processLine(line, true);
  timedOut = result.timedOut || inactivityTimedOut;

  // Managed runtimes may return buffered stdout without invoking onLog.
  if (!sawStdoutLine && result.stdout) {
    const fallbackFramer = createJsonlFramer();
    for (const line of [...fallbackFramer.push(result.stdout), ...fallbackFramer.flush()]) {
      await processLine(line, false);
    }
  }

  const metadataFramer = createJsonlFramer();
  for (const line of [...metadataFramer.push(result.stdout), ...metadataFramer.flush()]) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const ok = parsed as CodexStreamEvent;
    const sid = ok.thread_id ?? ok.session_id;
    if (sid && !sessionId) sessionId = sid;
    if (ok.usage) {
      if (typeof ok.usage.input_tokens === "number")
        collectedUsage.inputTokens = ok.usage.input_tokens;
      if (typeof ok.usage.output_tokens === "number")
        collectedUsage.outputTokens = ok.usage.output_tokens;
      if (typeof ok.usage.cached_input_tokens === "number") {
        collectedUsage.cachedInputTokens = ok.usage.cached_input_tokens;
      }
    }
  }

  const summary = collectedText.join("\n").trim();
  const errorMessage = collectedErrors.join("").trim();

  if (timedOut) {
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      exitCode: result.exitCode,
      timedOut: true,
      errorMessage: inactivityTimedOut
        ? `No Codex output for ${config.outputInactivityTimeoutMs}ms`
        : "Run exceeded timeout",
      errorFamily: "transient_upstream",
      summary: summary || undefined,
      usage: collectedUsage.inputTokens !== undefined ? collectedUsage : undefined,
      usageBasis: "per_run",
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
      provider: "openai",
      model,
      billingType: "api",
      clearSession: false,
    };
  }

  if (result.exitCode !== 0) {
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      exitCode: result.exitCode,
      timedOut: false,
      errorMessage: errorMessage || `codex exited with code ${result.exitCode}`,
      errorFamily: classifyError(result.exitCode, errorMessage),
      summary: summary || undefined,
      usage: collectedUsage.inputTokens !== undefined ? collectedUsage : undefined,
      usageBasis: "per_run",
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
      provider: "openai",
      model,
      billingType: "api",
      clearSession: false,
    };
  }

  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 0,
    timedOut: false,
    summary: summary || undefined,
    usage: collectedUsage.inputTokens !== undefined ? collectedUsage : undefined,
    usageBasis: "per_run",
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
    provider: "openai",
    model,
    billingType: "api",
    clearSession: !sessionId,
  };
}

export async function testEnvironment(ctx: { config: unknown; cwd?: string }): Promise<{
  ok: boolean;
  checks: { name: string; level: "info" | "warn" | "error"; message: string }[];
}> {
  let config: CodexLocalConfig;
  try {
    config = parseCodexLocalConfig(ctx.config);
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          name: "config",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const engine = await resolveAcpEngine("codex", {
    config: (ctx.config ?? {}) as AdapterExecutionContext["config"],
    cwd: ctx.cwd,
  });
  if (engine.engine === "acp") {
    return testAcpEnvironment("codex", {
      config: ctx.config,
      cwd: ctx.cwd,
    });
  }
  const result = await runProcess({ command: config.command, args: ["--version"], cwd: ctx.cwd });
  const installed = result.exitCode === 0;
  const auth = installed
    ? await runProcess({ command: config.command, args: ["login", "status"], cwd: ctx.cwd })
    : null;
  const authenticated = installed && auth?.exitCode === 0;
  const sandboxArgs = codexSandboxProbeArgs(config.sandbox);
  const sandbox =
    authenticated && sandboxArgs
      ? await runProcess({ command: config.command, args: sandboxArgs, cwd: ctx.cwd })
      : null;
  const ok = authenticated && (!sandboxArgs || sandbox?.exitCode === 0);
  return {
    ok,
    checks: [
      ...(engine.fallbackReason
        ? [
            {
              name: "acp_fallback",
              level: "warn" as const,
              message: `ACP unavailable; testing the Codex CLI fallback: ${engine.fallbackReason}`,
            },
          ]
        : []),
      {
        name: "codex_cli",
        level: installed ? "info" : "error",
        message: installed
          ? `codex found: ${result.stdout.trim()}`
          : `codex not found: ${result.stderr.trim() || "binary missing"}`,
      },
      ...(installed
        ? [
            {
              name: "codex_auth" as const,
              level: (authenticated ? "info" : "error") as "info" | "error",
              message: authenticated
                ? auth?.stdout.trim() || "codex authenticated"
                : auth?.stderr.trim() || auth?.stdout.trim() || "codex is not authenticated",
            },
          ]
        : []),
      ...(sandboxArgs && authenticated
        ? [
            {
              name: "codex_sandbox" as const,
              level: (sandbox?.exitCode === 0 ? "info" : "error") as "info" | "error",
              message:
                sandbox?.exitCode === 0
                  ? "Codex local sandbox is ready"
                  : `Codex local sandbox failed: ${redactHomePath(
                      sandbox?.stderr.trim() || sandbox?.stdout.trim() || "unknown error",
                    )}`,
            },
          ]
        : []),
    ],
  };
}

export function codexSandboxProbeArgs(
  sandbox: CodexLocalConfig["sandbox"],
  platform = process.platform,
): string[] | null {
  return platform === "win32"
    ? ["sandbox", "-c", `sandbox_mode="${sandbox}"`, "--", "cmd.exe", "/d", "/c", "exit", "0"]
    : null;
}

function buildCodexArgs(config: CodexLocalConfig, ctx: AdapterExecutionContext): string[] {
  const args: string[] = ctx.runtime.sessionId
    ? ["exec", "resume", ctx.runtime.sessionId, "--json"]
    : ["exec", "--json", "--sandbox", config.sandbox];
  if (config.model) args.push("--model", config.model);
  if (config.modelReasoningEffort)
    args.push("-c", `model_reasoning_effort=${config.modelReasoningEffort}`);
  args.push("-c", `approval_policy="${config.approvalMode}"`);
  if (ctx.runtime.sessionId) args.push("-c", `sandbox_mode="${config.sandbox}"`);
  for (const extra of config.extraArgs) args.push(extra);
  return args;
}

function classifyError(exitCode: number | null, stderr: string): ErrorFamily {
  const lower = stderr.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("quota") || lower.includes("usage limit")) {
    return "provider_quota";
  }
  if (lower.includes("unauthorized") || lower.includes("auth") || lower.includes("api key")) {
    return "auth";
  }
  if (lower.includes("refused") || lower.includes("refusal") || lower.includes("policy")) {
    return "model_refusal";
  }
  if (exitCode === null) return "transient_upstream";
  return "internal";
}

function buildErrorResult(
  family: ErrorFamily,
  message: string,
  details: string,
): AdapterExecutionResult {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 1,
    timedOut: false,
    errorMessage: `${message}: ${redactCommandText(details).slice(0, 1_000)}`,
    errorFamily: family,
    summary: message,
    usageBasis: "per_run",
    clearSession: false,
  };
}
