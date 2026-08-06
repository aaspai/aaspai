import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { newEventId } from "../canonical.js";
import { calculateGeminiCostForTokenType } from "../cost.js";
import type { LogInsert, MetricInsert, SpanInsert } from "../repository.js";
import { readWholeFile } from "./incremental.js";
import type {
  ImportResult,
  ImportSource,
  ImportState,
  IncrementalResult,
  ParserContext,
  SessionParser,
} from "./types.js";

/**
 * Gemini CLI session importer.
 *
 * Adapted from the reference `backend/internal/importer/gemini.go` and
 * `watcher/gemini_incremental.go`. Gemini session files are single JSON
 * documents; the parser tracks progress by message count and re-reads
 * the whole file each time (skipping already-processed messages).
 */

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: Array<{
    functionResponse?: {
      id?: string;
      name?: string;
      response?: { output?: string };
    };
  }>;
  status?: string;
  timestamp?: string;
  displayName?: string;
}

interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string;
  tokens?: GeminiTokens;
  model?: string;
  toolCalls?: GeminiToolCall[];
}

interface GeminiSession {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
  summary?: string;
}

const GEMINI_SERVICE = "gemini_cli";

export function geminiPath(envPath?: string, geminiHome?: string): string {
  if (envPath) return envPath;
  if (geminiHome) return join(geminiHome, "tmp");
  return join(homedir(), ".gemini", "tmp");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function parseGeminiTime(raw: string): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function mapGeminiSeverity(msgType: string): string {
  switch (msgType) {
    case "error":
      return "ERROR";
    case "warning":
      return "WARN";
    default:
      return "INFO";
  }
}

export function mapGeminiSeverityNumber(msgType: string): number {
  switch (msgType) {
    case "error":
      return 17;
    case "warning":
      return 13;
    default:
      return 9;
  }
}

export function mapGeminiTypeToRole(msgType: string): string {
  if (msgType === "user") return "user";
  return "assistant";
}

export class GeminiParser implements SessionParser {
  private readonly path: string;

  constructor(
    private readonly ctx: ParserContext,
    options: { path?: string; envPath?: string; geminiHome?: string } = {},
  ) {
    this.path = options.path ?? geminiPath(options.envPath, options.geminiHome);
  }

  source(): ImportSource {
    return "gemini_cli";
  }

  async findSessionFiles(): Promise<string[]> {
    if (!this.path || !(await exists(this.path))) return [];
    const files: string[] = [];
    const stack = [this.path];
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
        } else if (entry.name.startsWith("session-") && entry.name.endsWith(".json")) {
          files.push(full);
        }
      }
    }
    return files;
  }

  async parseFile(filePath: string): Promise<ImportResult> {
    const state: ImportState = { byteOffset: 0, messageCount: 0, parserState: {} };
    const incremental = await this.parseIncremental(filePath, state);
    return {
      filePath,
      sessionId: incremental.logs[0]?.sessionId ?? basename(filePath).replace(/\.json$/, ""),
      logs: incremental.logs,
      metrics: incremental.metrics,
      spans: incremental.spans,
      recordCount: incremental.recordCount,
      firstTime: incremental.logs[0]?.observedAt ?? null,
      lastTime: incremental.logs[incremental.logs.length - 1]?.observedAt ?? null,
      errors: [],
    };
  }

  async parseIncremental(filePath: string, state: ImportState): Promise<IncrementalResult> {
    const logs: LogInsert[] = [];
    const metrics: MetricInsert[] = [];
    const spans: SpanInsert[] = [];
    const receivedAt = new Date().toISOString();
    const importSource = "local_jsonl";

    const data = await readWholeFile(filePath);
    let session: GeminiSession;
    try {
      session = JSON.parse(data) as GeminiSession;
    } catch {
      return { logs, metrics, spans, state, recordCount: 0 };
    }

    const messages = session.messages ?? [];
    const alreadyProcessed =
      typeof state.parserState.messageCount === "number"
        ? (state.parserState.messageCount as number)
        : state.messageCount;
    if (alreadyProcessed >= messages.length) {
      return { logs, metrics, spans, state, recordCount: 0 };
    }
    const newMessages = messages.slice(alreadyProcessed);

    let messageIndex = alreadyProcessed;
    for (const msg of newMessages) {
      const ts = parseGeminiTime(msg.timestamp ?? "");
      if (!ts) {
        messageIndex += 1;
        continue;
      }

      logs.push({
        id: newEventId("tlog"),
        organizationId: this.ctx.organizationId,
        observedAt: ts,
        receivedAt,
        provider: "gemini_cli",
        sourceKind: "import",
        serviceName: GEMINI_SERVICE,
        eventName: "transcript.message",
        body: (msg.content ?? "").slice(0, 16_384),
        severityText: mapGeminiSeverity(msg.type ?? ""),
        severityNumber: mapGeminiSeverityNumber(msg.type ?? ""),
        sessionId: session.sessionId,
        model: msg.model ?? undefined,
        attributes: {
          "event.name": "transcript.message",
          "session.id": session.sessionId ?? "",
          "message.id": msg.id ?? "",
          "message.index": String(messageIndex),
          "message.role": mapGeminiTypeToRole(msg.type ?? ""),
          ...(msg.model ? { model: msg.model } : {}),
          ...(session.projectHash ? { project_hash: session.projectHash } : {}),
          ...(msg.tokens?.input ? { input_tokens: String(msg.tokens.input) } : {}),
          ...(msg.tokens?.output ? { output_tokens: String(msg.tokens.output) } : {}),
          ...(msg.tokens?.cached ? { cache_read_input_tokens: String(msg.tokens.cached) } : {}),
          import_source: importSource,
        },
        dedupKey: `gemini:msg:${this.ctx.organizationId}:${session.sessionId ?? ""}:${messageIndex}`,
        importSource,
        parseStatus: "ok",
        rawAvailable: false,
      });
      messageIndex += 1;

      for (const toolCall of msg.toolCalls ?? []) {
        const toolTs = toolCall.timestamp ? (parseGeminiTime(toolCall.timestamp) ?? ts) : ts;
        logs.push({
          id: newEventId("tlog"),
          organizationId: this.ctx.organizationId,
          observedAt: toolTs,
          receivedAt,
          provider: "gemini_cli",
          sourceKind: "import",
          serviceName: GEMINI_SERVICE,
          eventName: "transcript.message",
          body: `Tool call: ${toolCall.name ?? ""}`,
          severityText: "INFO",
          severityNumber: 9,
          sessionId: session.sessionId,
          model: msg.model ?? undefined,
          toolName: toolCall.name,
          attributes: {
            "event.name": "transcript.message",
            "session.id": session.sessionId ?? "",
            "message.index": String(messageIndex),
            "message.role": "tool_use",
            "tool.name": toolCall.name ?? "",
            ...(toolCall.args !== undefined && toolCall.args !== null
              ? {
                  "tool.input":
                    typeof toolCall.args === "string"
                      ? toolCall.args
                      : JSON.stringify(toolCall.args),
                }
              : {}),
            import_source: importSource,
          },
          dedupKey: `gemini:tool:${this.ctx.organizationId}:${session.sessionId ?? ""}:${messageIndex}`,
          importSource,
          parseStatus: "ok",
          rawAvailable: false,
        });
        messageIndex += 1;

        const functionResponse = toolCall.result?.[0]?.functionResponse;
        if (functionResponse) {
          const toolOutput = functionResponse.response?.output ?? "";
          logs.push({
            id: newEventId("tlog"),
            organizationId: this.ctx.organizationId,
            observedAt: toolTs,
            receivedAt,
            provider: "gemini_cli",
            sourceKind: "import",
            serviceName: GEMINI_SERVICE,
            eventName: "transcript.message",
            body: toolOutput.slice(0, 16_384),
            severityText: "INFO",
            severityNumber: 9,
            sessionId: session.sessionId,
            toolName: toolCall.name,
            attributes: {
              "event.name": "transcript.message",
              "session.id": session.sessionId ?? "",
              "message.index": String(messageIndex),
              "message.role": "tool_result",
              "tool.name": toolCall.name ?? "",
              ...(toolCall.status ? { success: String(toolCall.status === "success") } : {}),
              ...(toolOutput ? { "tool.output": toolOutput } : {}),
              import_source: importSource,
            },
            dedupKey: `gemini:toolresult:${this.ctx.organizationId}:${session.sessionId ?? ""}:${messageIndex}`,
            importSource,
            parseStatus: "ok",
            rawAvailable: false,
          });
          messageIndex += 1;
        }
      }

      if (msg.type === "gemini" && msg.tokens) {
        const tokens = msg.tokens;
        const model = msg.model ?? "";
        let totalCost = 0;
        const tokenTypes: Array<[string, number, string | null]> = [
          ["input", tokens.input ?? 0, "input"],
          ["output", tokens.output ?? 0, "output"],
          ["cached", tokens.cached ?? 0, "cache"],
          ["thoughts", tokens.thoughts ?? 0, "thought"],
          ["tool", tokens.tool ?? 0, null],
        ];
        for (const [type, count, costType] of tokenTypes) {
          if (count <= 0) continue;
          metrics.push(
            createGeminiTokenMetric(
              this.ctx.organizationId,
              ts,
              receivedAt,
              model,
              type,
              count,
              session.sessionId,
            ),
          );
          if (costType) {
            const cost = calculateGeminiCostForTokenType(model, costType, count);
            if (cost !== null) totalCost += cost;
          }
        }
        if (totalCost > 0) {
          metrics.push(
            createGeminiCostMetric(
              this.ctx.organizationId,
              ts,
              receivedAt,
              model,
              totalCost,
              session.sessionId,
            ),
          );
        }
      }
    }

    const nextState: ImportState = {
      byteOffset: data.length,
      messageCount: messages.length,
      parserState: { messageCount: messages.length },
    };
    return {
      logs,
      metrics,
      spans,
      state: nextState,
      recordCount: messages.length - alreadyProcessed,
    };
  }
}

function createGeminiTokenMetric(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  tokenType: string,
  value: number,
  sessionId?: string,
): MetricInsert {
  return {
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "gemini_cli",
    sourceKind: "import",
    serviceName: GEMINI_SERVICE,
    name: "gemini_cli.token.usage",
    metricType: "sum",
    sessionId,
    model: model || undefined,
    value,
    attributes: { type: tokenType, model, import_source: "local_jsonl" },
    dedupKey: `gemini:token:${organizationId}:${model}:${tokenType}:${ts}:${value}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  };
}

function createGeminiCostMetric(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  costUsd: number,
  sessionId?: string,
): MetricInsert {
  return {
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "gemini_cli",
    sourceKind: "import",
    serviceName: GEMINI_SERVICE,
    name: "gemini_cli.cost.usage",
    metricType: "sum",
    sessionId,
    model: model || undefined,
    value: costUsd,
    attributes: { model, import_source: "local_jsonl" },
    dedupKey: `gemini:cost:${organizationId}:${model}:${ts}:${costUsd}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  };
}
