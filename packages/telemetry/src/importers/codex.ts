import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { newEventId } from "../canonical.js";
import { calculateCodexCost } from "../cost.js";
import type { LogInsert, MetricInsert, SpanInsert } from "../repository.js";
import { readIncrementalLines } from "./incremental.js";
import {
  type ImportResult,
  type ImportSource,
  type ImportState,
  type IncrementalResult,
  type ParserContext,
  parseTimestamp,
  type SessionParser,
} from "./types.js";

/**
 * OpenAI Codex CLI JSONL session importer.
 *
 * Adapted from the reference `backend/internal/importer/codex.go` and
 * `watcher/codex_incremental.go`. Codex JSONL entries carry cumulative
 * token counts, so the parser emits deltas from the previous count
 * (persisted in parser state) and tracks the model per turn.
 */

interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: unknown;
}

interface CodexSessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  model_provider?: string;
  model?: string;
}

interface CodexTokenCount {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  tool_tokens?: number;
}

interface CodexTokenInfo {
  total_token_usage?: CodexTokenCount;
}

interface CodexEventMsg {
  type?: string;
  info?: CodexTokenInfo;
}

interface CodexContentItem {
  type?: string;
  text?: string;
}

interface CodexReasoningSummary {
  type?: string;
  text?: string;
}

interface CodexResponseItem {
  type?: string;
  role?: string;
  content?: CodexContentItem[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: unknown;
  summary?: CodexReasoningSummary[];
}

interface CodexParserState {
  sessionId: string;
  currentModel: string;
  messageIndex: number;
  lastTokenCount: CodexTokenCount | null;
}

const CODEX_SERVICE = "codex_cli_rs";

export function codexSessionsPath(envPath?: string, codexHome?: string): string {
  if (envPath) return envPath;
  if (codexHome) return join(codexHome, "sessions");
  return join(homedir(), ".codex", "sessions");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class CodexParser implements SessionParser {
  private readonly sessionsPath: string;

  constructor(
    private readonly ctx: ParserContext,
    options: { sessionsPath?: string; envPath?: string; codexHome?: string } = {},
  ) {
    this.sessionsPath =
      options.sessionsPath ?? codexSessionsPath(options.envPath, options.codexHome);
  }

  source(): ImportSource {
    return "codex_cli_rs";
  }

  async findSessionFiles(): Promise<string[]> {
    if (!this.sessionsPath || !(await exists(this.sessionsPath))) return [];
    const files: string[] = [];
    const stack = [this.sessionsPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      let entries: Array<{ name: string; isDirectory: boolean }>;
      try {
        entries = (await readdir(current, { withFileTypes: true })).map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
        }));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory) {
          stack.push(full);
        } else if (entry.name.endsWith(".jsonl")) {
          files.push(full);
        }
      }
    }
    return files;
  }

  async parseFile(filePath: string): Promise<ImportResult> {
    const result: ImportResult = {
      filePath,
      sessionId: basename(filePath).replace(/\.jsonl$/, ""),
      logs: [],
      metrics: [],
      spans: [],
      recordCount: 0,
      firstTime: null,
      lastTime: null,
      errors: [],
    };
    const state: ImportState = { byteOffset: 0, messageCount: 0, parserState: {} };
    const incremental = await this.parseIncremental(filePath, state);
    result.logs = incremental.logs;
    result.metrics = incremental.metrics;
    result.spans = incremental.spans;
    result.recordCount = incremental.recordCount;
    for (const log of incremental.logs) {
      const ts = log.observedAt;
      if (!result.firstTime || ts < result.firstTime) result.firstTime = ts;
      if (!result.lastTime || ts > result.lastTime) result.lastTime = ts;
    }
    const metaLog = incremental.logs.find((l) => l.eventName === "codex.conversation_starts");
    if (metaLog?.sessionId) result.sessionId = metaLog.sessionId;
    return result;
  }

  async parseIncremental(filePath: string, state: ImportState): Promise<IncrementalResult> {
    const logs: LogInsert[] = [];
    const metrics: MetricInsert[] = [];
    const spans: SpanInsert[] = [];
    const receivedAt = new Date().toISOString();
    const importSource = "local_jsonl";

    const parserState: CodexParserState = {
      sessionId:
        typeof state.parserState.sessionId === "string" && state.parserState.sessionId
          ? (state.parserState.sessionId as string)
          : basename(filePath).replace(/\.jsonl$/, ""),
      currentModel:
        typeof state.parserState.currentModel === "string"
          ? (state.parserState.currentModel as string)
          : "",
      messageIndex:
        typeof state.parserState.messageIndex === "number"
          ? (state.parserState.messageIndex as number)
          : state.messageCount,
      lastTokenCount: (state.parserState.lastTokenCount as CodexTokenCount) ?? null,
    };

    const { state: nextState, recordCount } = await readIncrementalLines(
      filePath,
      state,
      (line, _lineNo, hasNewline) => {
        if (line.trim() === "") return true;
        let entry: CodexEntry;
        try {
          entry = JSON.parse(line) as CodexEntry;
        } catch {
          return hasNewline;
        }
        const ts = parseTimestamp(entry.timestamp);
        if (!ts) return true;
        const payload = entry.payload as Record<string, unknown> | null | undefined;

        switch (entry.type) {
          case "session_meta": {
            const meta = (payload ?? {}) as CodexSessionMeta;
            if (meta.id) parserState.sessionId = meta.id;
            if (meta.model) parserState.currentModel = meta.model;
            logs.push({
              id: newEventId("tlog"),
              organizationId: this.ctx.organizationId,
              observedAt: ts,
              receivedAt,
              provider: "codex_cli_rs",
              sourceKind: "import",
              serviceName: CODEX_SERVICE,
              eventName: "codex.conversation_starts",
              body: "conversation_starts",
              severityText: "INFO",
              severityNumber: 9,
              sessionId: meta.id ?? parserState.sessionId,
              model: meta.model,
              attributes: {
                "event.name": "codex.conversation_starts",
                "session.id": meta.id ?? parserState.sessionId,
                model: meta.model ?? "",
                model_provider: meta.model_provider ?? "",
                cli_version: meta.cli_version ?? "",
                cwd: meta.cwd ?? "",
                import_source: importSource,
              },
              dedupKey: `codex:session_meta:${this.ctx.organizationId}:${parserState.sessionId}`,
              importSource,
              parseStatus: "ok",
              rawAvailable: false,
            });
            break;
          }
          case "event_msg": {
            const eventMsg = (payload ?? {}) as CodexEventMsg;
            if (eventMsg.type === "token_count") {
              const tokenCount = eventMsg.info?.total_token_usage;
              if (!tokenCount) break;
              const cachedTokens =
                (tokenCount.cache_read_input_tokens ?? 0) || (tokenCount.cached_input_tokens ?? 0);
              const last = parserState.lastTokenCount;
              const delta = (field: (t: CodexTokenCount) => number): number =>
                last === null ? field(tokenCount) : field(tokenCount) - field(last);
              const lastCached = last
                ? (last.cache_read_input_tokens ?? 0) || (last.cached_input_tokens ?? 0)
                : 0;

              const deltas: Array<[string, number]> = [
                ["input", delta((t) => t.input_tokens ?? 0)],
                ["output", delta((t) => t.output_tokens ?? 0)],
                ["cache_creation", delta((t) => t.cache_creation_input_tokens ?? 0)],
                ["cache_read", cachedTokens - lastCached],
                ["reasoning", delta((t) => t.reasoning_output_tokens ?? 0)],
                ["tool", delta((t) => t.tool_tokens ?? 0)],
              ];
              const model = parserState.currentModel;
              for (const [type, count] of deltas) {
                if (count > 0) {
                  metrics.push(
                    createCodexTokenMetric(
                      this.ctx.organizationId,
                      ts,
                      receivedAt,
                      model,
                      type,
                      count,
                      parserState.sessionId,
                    ),
                  );
                }
              }
              const cost = calculateCodexCost(
                model,
                delta((t) => t.input_tokens ?? 0),
                cachedTokens - lastCached,
                delta((t) => t.output_tokens ?? 0),
              );
              if (cost !== null && cost > 0) {
                metrics.push(
                  createCodexCostMetric(
                    this.ctx.organizationId,
                    ts,
                    receivedAt,
                    model,
                    cost,
                    parserState.sessionId,
                  ),
                );
              }
              parserState.lastTokenCount = tokenCount;
            } else if (eventMsg.type === "user_message" || eventMsg.type === "agent_message") {
              logs.push({
                id: newEventId("tlog"),
                organizationId: this.ctx.organizationId,
                observedAt: ts,
                receivedAt,
                provider: "codex_cli_rs",
                sourceKind: "import",
                serviceName: CODEX_SERVICE,
                eventName: `codex.${eventMsg.type}`,
                body: eventMsg.type,
                severityText: "INFO",
                severityNumber: 9,
                sessionId: parserState.sessionId || undefined,
                attributes: {
                  "event.name": `codex.${eventMsg.type}`,
                  "session.id": parserState.sessionId,
                  import_source: importSource,
                },
                dedupKey: `codex:event:${this.ctx.organizationId}:${parserState.sessionId}:${ts}:${eventMsg.type}`,
                importSource,
                parseStatus: "ok",
                rawAvailable: false,
              });
            }
            break;
          }
          case "turn_context": {
            const turnCtx = (payload ?? {}) as { model?: string };
            if (turnCtx.model) parserState.currentModel = turnCtx.model;
            break;
          }
          case "response_item": {
            const respItem = (payload ?? {}) as CodexResponseItem;
            const sessionId = parserState.sessionId;
            const model = parserState.currentModel;
            switch (respItem.type) {
              case "message": {
                let textContent = "";
                for (const content of respItem.content ?? []) {
                  if (content.type === "input_text" || content.type === "output_text") {
                    if (textContent !== "") textContent += "\n";
                    textContent += content.text ?? "";
                  }
                }
                if (textContent === "") break;
                const role = respItem.role || "assistant";
                logs.push({
                  id: newEventId("tlog"),
                  organizationId: this.ctx.organizationId,
                  observedAt: ts,
                  receivedAt,
                  provider: "codex_cli_rs",
                  sourceKind: "import",
                  serviceName: CODEX_SERVICE,
                  eventName: "transcript.message",
                  body: textContent.slice(0, 16_384),
                  severityText: "INFO",
                  severityNumber: 9,
                  sessionId,
                  model: model || undefined,
                  attributes: {
                    "event.name": "transcript.message",
                    "session.id": sessionId,
                    "message.index": String(parserState.messageIndex),
                    "message.role": role,
                    import_source: importSource,
                  },
                  dedupKey: `codex:msg:${this.ctx.organizationId}:${sessionId}:${parserState.messageIndex}`,
                  importSource,
                  parseStatus: "ok",
                  rawAvailable: false,
                });
                parserState.messageIndex += 1;
                break;
              }
              case "function_call": {
                logs.push({
                  id: newEventId("tlog"),
                  organizationId: this.ctx.organizationId,
                  observedAt: ts,
                  receivedAt,
                  provider: "codex_cli_rs",
                  sourceKind: "import",
                  serviceName: CODEX_SERVICE,
                  eventName: "transcript.message",
                  body: `Tool call: ${respItem.name ?? ""}`,
                  severityText: "INFO",
                  severityNumber: 9,
                  sessionId,
                  model: model || undefined,
                  toolName: respItem.name,
                  attributes: {
                    "event.name": "transcript.message",
                    "session.id": sessionId,
                    "message.index": String(parserState.messageIndex),
                    "message.role": "tool_use",
                    "tool.name": respItem.name ?? "",
                    ...(respItem.arguments ? { "tool.input": respItem.arguments } : {}),
                    ...(respItem.call_id ? { "tool.call_id": respItem.call_id } : {}),
                    import_source: importSource,
                  },
                  dedupKey: `codex:tool:${this.ctx.organizationId}:${sessionId}:${parserState.messageIndex}`,
                  importSource,
                  parseStatus: "ok",
                  rawAvailable: false,
                });
                parserState.messageIndex += 1;
                break;
              }
              case "function_call_output": {
                let outputContent = "";
                if (respItem.output !== undefined && respItem.output !== null) {
                  if (typeof respItem.output === "string") {
                    outputContent = respItem.output;
                  } else {
                    try {
                      outputContent = JSON.stringify(respItem.output);
                    } catch {
                      outputContent = String(respItem.output);
                    }
                  }
                }
                logs.push({
                  id: newEventId("tlog"),
                  organizationId: this.ctx.organizationId,
                  observedAt: ts,
                  receivedAt,
                  provider: "codex_cli_rs",
                  sourceKind: "import",
                  serviceName: CODEX_SERVICE,
                  eventName: "transcript.message",
                  body: outputContent.slice(0, 16_384),
                  severityText: "INFO",
                  severityNumber: 9,
                  sessionId,
                  toolName: undefined,
                  attributes: {
                    "event.name": "transcript.message",
                    "session.id": sessionId,
                    "message.index": String(parserState.messageIndex),
                    "message.role": "tool_result",
                    ...(outputContent !== "" ? { "tool.output": outputContent } : {}),
                    ...(respItem.call_id ? { "tool.call_id": respItem.call_id } : {}),
                    import_source: importSource,
                  },
                  dedupKey: `codex:toolresult:${this.ctx.organizationId}:${sessionId}:${parserState.messageIndex}`,
                  importSource,
                  parseStatus: "ok",
                  rawAvailable: false,
                });
                parserState.messageIndex += 1;
                break;
              }
              case "reasoning": {
                let reasoningText = "";
                for (const summary of respItem.summary ?? []) {
                  if (summary.type === "summary_text" && summary.text) {
                    if (reasoningText !== "") reasoningText += "\n";
                    reasoningText += summary.text;
                  }
                }
                if (reasoningText === "") break;
                logs.push({
                  id: newEventId("tlog"),
                  organizationId: this.ctx.organizationId,
                  observedAt: ts,
                  receivedAt,
                  provider: "codex_cli_rs",
                  sourceKind: "import",
                  serviceName: CODEX_SERVICE,
                  eventName: "transcript.message",
                  body: reasoningText.slice(0, 16_384),
                  severityText: "INFO",
                  severityNumber: 9,
                  sessionId,
                  model: model || undefined,
                  attributes: {
                    "event.name": "transcript.message",
                    "session.id": sessionId,
                    "message.index": String(parserState.messageIndex),
                    "message.role": "assistant",
                    import_source: importSource,
                  },
                  dedupKey: `codex:reasoning:${this.ctx.organizationId}:${sessionId}:${parserState.messageIndex}`,
                  importSource,
                  parseStatus: "ok",
                  rawAvailable: false,
                });
                parserState.messageIndex += 1;
                break;
              }
              default:
                break;
            }
            break;
          }
          default:
            break;
        }
        return true;
      },
    );

    nextState.parserState = {
      sessionId: parserState.sessionId,
      currentModel: parserState.currentModel,
      messageIndex: parserState.messageIndex,
      lastTokenCount: parserState.lastTokenCount,
    };
    nextState.messageCount = parserState.messageIndex;

    return { logs, metrics, spans, state: nextState, recordCount };
  }
}

function createCodexTokenMetric(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  tokenType: string,
  value: number,
  sessionId: string,
): MetricInsert {
  return {
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "codex_cli_rs",
    sourceKind: "import",
    serviceName: CODEX_SERVICE,
    name: "codex_cli_rs.token.usage",
    metricType: "sum",
    sessionId,
    model: model || undefined,
    value,
    attributes: { type: tokenType, model, import_source: "local_jsonl" },
    dedupKey: `codex:token:${organizationId}:${sessionId}:${tokenType}:${ts}:${value}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  };
}

function createCodexCostMetric(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  costUsd: number,
  sessionId: string,
): MetricInsert {
  return {
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "codex_cli_rs",
    sourceKind: "import",
    serviceName: CODEX_SERVICE,
    name: "codex_cli_rs.cost.usage",
    metricType: "sum",
    sessionId,
    model: model || undefined,
    value: costUsd,
    attributes: { model, import_source: "local_jsonl" },
    dedupKey: `codex:cost:${organizationId}:${sessionId}:${ts}:${costUsd}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  };
}
