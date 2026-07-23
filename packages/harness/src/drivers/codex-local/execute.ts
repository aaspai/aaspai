import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ErrorFamily,
  ServerAdapterModule,
  UsageSummary,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { buildAgentEnv } from "../../shared/env.js";
import { redactCommandText, redactHomePath } from "../../shared/redact.js";
import { runProcess } from "../../shared/run-process.js";
import type { CodexStreamEvent } from "./config.js";
import {
  type CodexLocalConfig,
  codexLocalConfigSchema,
  codexLocalInfo,
  parseCodexLocalConfig,
} from "./config.js";
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
  execute,
  testEnvironment,
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
  let sessionId: string | undefined = ctx.runtime.sessionId;
  const model: string | undefined = config.model;
  let stopReason: string | undefined;
  let timedOut = false;

  const onLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    if (stream === "stderr") {
      collectedErrors.push(redactHomePath(chunk));
      await ctx.onLog(stream, redactHomePath(chunk));
    } else {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const entries = parseCodexStreamLine(line, new Date().toISOString());
        for (const entry of entries) {
          if (entry.kind === "assistant" && typeof entry.text === "string") {
            collectedText.push(entry.text);
          } else if (entry.kind === "init") {
            if (entry.sessionId) sessionId = entry.sessionId;
          } else if (entry.kind === "result") {
            if (entry.stopReason) stopReason = entry.stopReason;
          }
        }
        await ctx.onLog(stream, line);
      }
    }
  };

  const result = await runProcess({
    command,
    args,
    cwd,
    env,
    stdin,
    signal: ctx.signal,
    timeoutMs,
    onLog,
  });
  timedOut = result.timedOut;

  for (const line of result.stdout.split(/\r?\n/)) {
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
      errorMessage: "Run exceeded timeout",
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
  const config = parseCodexLocalConfig(ctx.config);
  const result = await runProcess({ command: config.command, args: ["--version"], cwd: ctx.cwd });
  const installed = result.exitCode === 0;
  const auth = installed
    ? await runProcess({ command: config.command, args: ["login", "status"], cwd: ctx.cwd })
    : null;
  const ok = installed && auth?.exitCode === 0;
  return {
    ok,
    checks: [
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
              level: (ok ? "info" : "error") as "info" | "error",
              message: ok
                ? auth?.stdout.trim() || "codex authenticated"
                : auth?.stderr.trim() || auth?.stdout.trim() || "codex is not authenticated",
            },
          ]
        : []),
    ],
  };
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
