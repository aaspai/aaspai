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
import type { ClaudeStreamEvent } from "./config.js";
import {
  type ClaudeLocalConfig,
  claudeLocalConfigSchema,
  claudeLocalInfo,
  parseClaudeLocalConfig,
} from "./config.js";
import { parseClaudeStreamLine } from "./parse.js";

const REDACTED_TEXT_VALUE = "[REDACTED]";

/**
 * Adapter for Claude Code running as a local subprocess.
 *
 * Spawns `claude --output-format stream-json --verbose` and parses one
 * JSON event per stdout line. Session resume is done via `--resume` when
 * the run context carries a previous sessionId.
 */
export const claudeLocal: ServerAdapterModule = {
  info: claudeLocalInfo,
  execute,
  testEnvironment,
};

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  let config: ClaudeLocalConfig;
  try {
    config = parseClaudeLocalConfig(ctx.config);
  } catch (err) {
    return buildErrorResult(
      "config",
      "Invalid claude_local config",
      err instanceof Error ? err.message : String(err),
    );
  }
  const command = config.command;
  const args = buildClaudeArgs(config, ctx);
  const env = {
    ...buildAgentEnv(ctx.agent, {
      runId: ctx.runId,
      sessionId: ctx.runtime.sessionId,
      sessionDisplayId: ctx.runtime.sessionDisplayId,
      cwd: ctx.context.cwd,
      additionalEnv: config.env,
    }),
  };
  const cwd = config.cwd ?? ctx.context.cwd;
  const stdin = ctx.context.prompt;
  const timeoutMs = (config.timeoutSec ?? 0) * 1000 || undefined;

  const collectedText: string[] = [];
  const collectedErrors: string[] = [];
  const collectedUsage: UsageSummary = {};
  let sessionId: string | undefined = ctx.runtime.sessionId;
  let model: string | undefined = config.model;
  let stopReason: string | undefined;
  let timedOut = false;

  const onLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    if (stream === "stderr") {
      collectedErrors.push(redactHomePath(chunk));
    } else {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const entries = parseClaudeStreamLine(line, new Date().toISOString());
        for (const entry of entries) {
          if (entry.kind === "assistant" && typeof entry.text === "string") {
            collectedText.push(entry.text);
          } else if (entry.kind === "init") {
            if (entry.sessionId) sessionId = entry.sessionId;
            if (entry.model) model = entry.model;
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
    timeoutMs,
    onLog,
  });

  timedOut = result.timedOut;

  // Post-hoc parse of full stdout for usage + sessionId, in case events
  // were buffered and not surfaced through onLog.
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const ok = parsed as ClaudeStreamEvent;
    if (ok.session_id && !sessionId) sessionId = ok.session_id;
    if (ok.usage) {
      if (typeof ok.usage.input_tokens === "number")
        collectedUsage.inputTokens = ok.usage.input_tokens;
      if (typeof ok.usage.output_tokens === "number")
        collectedUsage.outputTokens = ok.usage.output_tokens;
      if (typeof ok.usage.cache_read_input_tokens === "number") {
        collectedUsage.cachedInputTokens = ok.usage.cache_read_input_tokens;
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
      usage: Object.keys(collectedUsage).length > 0 ? collectedUsage : undefined,
      usageBasis: "per_run",
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
      provider: "anthropic",
      biller: config.model ? "claude-code" : undefined,
      model,
      billingType: "subscription",
      clearSession: false,
    };
  }

  if (result.exitCode !== 0) {
    const family = classifyError(result.exitCode, errorMessage);
    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      exitCode: result.exitCode,
      timedOut: false,
      errorMessage: errorMessage || `claude exited with code ${result.exitCode}`,
      errorFamily: family,
      summary: summary || undefined,
      usage: Object.keys(collectedUsage).length > 0 ? collectedUsage : undefined,
      usageBasis: "per_run",
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
      provider: "anthropic",
      model,
      billingType: "subscription",
      clearSession: false,
    };
  }

  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    exitCode: 0,
    timedOut: false,
    summary: summary || undefined,
    usage: Object.keys(collectedUsage).length > 0 ? collectedUsage : undefined,
    usageBasis: "per_run",
    sessionId,
    sessionDisplayId: sessionId,
    sessionParams: { resume: Boolean(ctx.runtime.sessionId) },
    provider: "anthropic",
    model,
    billingType: "subscription",
    clearSession: !sessionId,
  };
}

export async function testEnvironment(ctx: { config: unknown; cwd?: string }): Promise<{
  ok: boolean;
  checks: { name: string; level: "info" | "warn" | "error"; message: string }[];
}> {
  const config = parseClaudeLocalConfig(ctx.config);
  const result = await runProcess({ command: config.command, args: ["--version"], cwd: ctx.cwd });
  const installed = result.exitCode === 0;
  const auth = installed
    ? await runProcess({ command: config.command, args: ["auth", "status"], cwd: ctx.cwd })
    : null;
  const ok = installed && auth?.exitCode === 0;
  return {
    ok,
    checks: [
      {
        name: "claude_cli",
        level: installed ? "info" : "error",
        message: installed
          ? `claude found: ${result.stdout.trim()}`
          : `claude not found: ${result.stderr.trim() || "binary missing"}`,
      },
      ...(installed
        ? [
            {
              name: "claude_auth" as const,
              level: (ok ? "info" : "error") as "info" | "error",
              message: ok
                ? auth?.stdout.trim() || "claude authenticated"
                : auth?.stderr.trim() || auth?.stdout.trim() || "claude is not authenticated",
            },
          ]
        : []),
    ],
  };
}

function buildClaudeArgs(config: ClaudeLocalConfig, ctx: AdapterExecutionContext): string[] {
  const args: string[] = ["--output-format", "stream-json", "--verbose"];
  if (config.permissionMode) {
    args.push("--permission-mode", config.permissionMode);
  }
  if (config.dangerouslySkipPermissions && config.permissionMode === "bypass-permissions") {
    args.push("--dangerously-skip-permissions");
  }
  if (config.model) args.push("--model", config.model);
  if (config.effort) args.push("--effort", config.effort);
  if (config.maxTurns) args.push("--max-turns", String(config.maxTurns));
  if (config.chrome) args.push("--chrome");
  if (ctx.runtime.sessionId) args.push("--resume", ctx.runtime.sessionId);
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

// satisfy unused-import check for REDACTED_TEXT_VALUE (kept for parity
// with codex-local; both drivers will surface redaction in their parse layer).
void REDACTED_TEXT_VALUE;
