import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInfo,
  ServerAdapterModule,
  TranscriptEntry,
  UsageSummary,
} from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { buildAgentEnv } from "./env.js";
import { createJsonlFramer } from "./jsonl.js";
import { redactHomePath } from "./redact.js";
import { runProcess } from "./run-process.js";
import { localSessionCodec } from "./session-codec.js";

export type LocalAgentDefinition = {
  info: AdapterInfo;
  command: string;
  buildArgs(config: Record<string, unknown>, ctx: AdapterExecutionContext): string[];
  promptMode?: "stdin" | "argument";
  promptFlag?: string;
  resumeFlag?: string;
};

type ParsedLine = {
  entries: TranscriptEntry[];
  sessionId?: string;
  usage?: UsageSummary;
  summary?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return asRecord(value) as JsonObject | undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
}

function usageFrom(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = record.input_tokens ?? record.inputTokens;
  const output = record.output_tokens ?? record.outputTokens;
  const cached =
    record.cached_input_tokens ?? record.cachedInputTokens ?? record.cache_read_input_tokens;
  const usage: UsageSummary = {};
  if (typeof input === "number" && input >= 0) usage.inputTokens = input;
  if (typeof output === "number" && output >= 0) usage.outputTokens = output;
  if (typeof cached === "number" && cached >= 0) usage.cachedInputTokens = cached;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function parseContent(value: unknown, ts: string): TranscriptEntry[] {
  if (typeof value === "string" && value.trim()) return [{ kind: "assistant", ts, text: value }];
  if (!Array.isArray(value)) return [];
  const entries: TranscriptEntry[] = [];
  for (const block of value) {
    const record = asRecord(block);
    if (!record) continue;
    const type = firstString(record.type, record.kind);
    const text = firstString(record.text, record.content, record.thinking);
    if (type === "thinking" || type === "thought") {
      if (text) entries.push({ kind: "thinking", ts, text });
    } else if (type === "tool_use" || type === "tool_call") {
      entries.push({
        kind: "tool_call",
        ts,
        name: firstString(record.name, record.tool_name, record.title) ?? "tool",
        id: firstString(record.id, record.tool_call_id, record.toolCallId),
        status: "started",
        input: asJsonObject(record.input ?? record.arguments),
      });
    } else if (text) {
      entries.push({ kind: "assistant", ts, text });
    }
  }
  return entries;
}

function parseLine(line: string, ts: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { entries: [] };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { entries: [{ kind: "stdout", ts, text: redactHomePath(line) }] };
  }
  const record = asRecord(value);
  if (!record) return { entries: [{ kind: "stdout", ts, text: redactHomePath(line) }] };
  const sessionId = firstString(
    record.session_id,
    record.sessionId,
    record.thread_id,
    record.threadId,
    record.run_id,
    record.runId,
  );
  const usage = usageFrom(record.usage ?? record.token_usage);
  const type = (firstString(record.type, record.event, record.kind) ?? "").toLowerCase();
  const message = asRecord(record.message);
  const summary = firstString(record.result, record.summary, record.output);
  const entries: TranscriptEntry[] = [];
  if (type.includes("tool") && (type.includes("result") || type.includes("complete"))) {
    entries.push({
      kind: "tool_result",
      ts,
      name: firstString(record.name, record.tool_name, record.title) ?? "tool",
      id: firstString(record.id, record.tool_call_id, record.toolCallId),
      output: firstString(record.output, record.result, record.content) ?? JSON.stringify(record),
      isError: record.is_error === true || record.isError === true || type.includes("error"),
    });
  } else if (type.includes("tool")) {
    entries.push(...parseContent([record], ts));
  } else if (type === "result" || type === "final" || type === "completed") {
    entries.push({ kind: "result", ts, summary, isError: record.error != null });
  } else {
    entries.push(
      ...parseContent(record.content ?? message?.content ?? record.message ?? record.text, ts),
    );
    if (entries.length === 0 && summary) entries.push({ kind: "assistant", ts, text: summary });
    if (entries.length === 0) entries.push({ kind: "system", ts, text: JSON.stringify(record) });
  }
  return { entries, sessionId, usage, summary };
}

function mergeUsage(current: UsageSummary, next: UsageSummary | undefined): void {
  if (!next) return;
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"] as const) {
    if (next[key] !== undefined) current[key] = next[key];
  }
}

function configRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function configNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function configEnv(config: Record<string, unknown>): Record<string, string> | undefined {
  const value = asRecord(config.env);
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function createLocalAgentAdapter(definition: LocalAgentDefinition): ServerAdapterModule {
  return {
    info: definition.info,
    sessionCodec: localSessionCodec,
    async execute(ctx): Promise<AdapterExecutionResult> {
      const config = configRecord(ctx.config);
      const args = definition.buildArgs(config, ctx);
      const cwd =
        typeof config.cwd === "string" && config.cwd.trim() ? config.cwd : ctx.context.cwd;
      const timeoutSec = configNumber(config, "timeoutSec");
      const graceSec = configNumber(config, "graceSec");
      const stdin = definition.promptMode === "argument" ? undefined : ctx.context.prompt;
      if (definition.promptMode === "argument" && definition.promptFlag) {
        args.push(definition.promptFlag, ctx.context.prompt);
      }
      const env = buildAgentEnv(ctx.agent, {
        runId: ctx.runId,
        sessionId: ctx.runtime.sessionId,
        sessionDisplayId: ctx.runtime.sessionDisplayId,
        cwd,
        additionalEnv: configEnv(config),
      });
      const framer = createJsonlFramer();
      const text: string[] = [];
      const usage: UsageSummary = {};
      let sawOutput = false;
      let sessionId: string | undefined;
      let summary: string | undefined;
      const emit = async (line: string): Promise<void> => {
        const parsed = parseLine(line, new Date().toISOString());
        if (parsed.entries.length > 0) sawOutput = true;
        sessionId ??= parsed.sessionId;
        summary ??= parsed.summary;
        mergeUsage(usage, parsed.usage);
        for (const entry of parsed.entries) {
          if (entry.kind === "assistant" || entry.kind === "thinking") text.push(entry.text);
          await ctx.onLog("stdout", `${JSON.stringify(entry)}\n`);
        }
      };
      const runner = ctx.execution?.run ?? runProcess;
      const result = await runner({
        command:
          typeof config.command === "string" && config.command.trim()
            ? config.command
            : definition.command,
        args,
        cwd,
        env,
        stdin,
        timeoutMs: timeoutSec ? Math.round(timeoutSec * 1_000) : undefined,
        graceMs: graceSec ? Math.round(graceSec * 1_000) : undefined,
        signal: ctx.signal,
        onSpawn: ctx.onSpawn,
        onLog: async (stream, chunk) => {
          if (stream === "stderr") {
            await ctx.onLog(
              "stderr",
              `${JSON.stringify({ kind: "stderr", ts: new Date().toISOString(), text: redactHomePath(chunk) })}\n`,
            );
            return;
          }
          for (const line of framer.push(chunk)) await emit(line);
        },
      });
      for (const line of framer.flush()) await emit(line);
      if (!sawOutput && result.stdout.trim()) {
        for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) await emit(line);
      }
      if (Object.keys(usage).length === 0 && result.exitCode !== 0) {
        summary = (summary ?? result.stderr.trim()) || undefined;
      }
      return {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        errorMessage:
          result.exitCode === 0 ? undefined : result.stderr.trim() || "Agent process failed",
        errorFamily: result.exitCode === 0 ? undefined : "transient_upstream",
        summary:
          (summary ?? text.join("\n").trim()) || (result.exitCode === 0 ? "completed" : "failed"),
        usage: Object.keys(usage).length > 0 ? usage : undefined,
        usageBasis: "per_run",
        sessionId,
        sessionDisplayId: sessionId,
        sessionParams: sessionId ? { nativeSessionId: sessionId, cwd } : undefined,
        model: typeof config.model === "string" ? config.model : undefined,
        runtimeIdentity: result.runtimeIdentity,
        clearSession: false,
      };
    },
    async testEnvironment(ctx) {
      const config = configRecord(ctx.config);
      const command =
        typeof config.command === "string" && config.command.trim()
          ? config.command
          : definition.command;
      const result = await runProcess({ command, args: ["--version"], cwd: ctx.cwd });
      return {
        ok: result.exitCode === 0,
        checks: [
          {
            name: "cli",
            level: result.exitCode === 0 ? "info" : "error",
            message:
              result.exitCode === 0
                ? `${definition.info.label} found: ${result.stdout.trim()}`
                : `${definition.info.label} unavailable: ${result.stderr.trim() || "binary missing"}`,
          },
        ],
      };
    },
    describe: () => ({
      type: definition.info.type,
      label: definition.info.label,
      models: [...definition.info.models],
      nativeTools: [],
      supportsCancel: false,
      supportsCompact: false,
      supportsFork: false,
      supportsResume: Boolean(definition.resumeFlag),
      supportsThinking: false,
      supportsForkSession: false,
    }),
  };
}

export function standardLocalArgs(
  config: Record<string, unknown>,
  ctx: AdapterExecutionContext,
  options: {
    outputFormat?: string;
    resumeFlag?: string;
    modelFlag?: string;
    modeFlag?: string;
    yoloFlag?: string;
  } = {},
): string[] {
  const args = Array.isArray(config.extraArgs)
    ? config.extraArgs.filter((value): value is string => typeof value === "string")
    : [];
  if (options.outputFormat) args.push(options.outputFormat);
  if (typeof config.model === "string" && config.model.trim() && options.modelFlag) {
    args.push(options.modelFlag, config.model.trim());
  }
  if (typeof config.mode === "string" && config.mode.trim() && options.modeFlag) {
    args.push(options.modeFlag, config.mode.trim());
  }
  if (ctx.runtime.sessionId && options.resumeFlag)
    args.push(options.resumeFlag, ctx.runtime.sessionId);
  if (options.yoloFlag && !args.some((arg) => /^(--yolo|--trust|-f)$/i.test(arg)))
    args.push(options.yoloFlag);
  return args;
}
