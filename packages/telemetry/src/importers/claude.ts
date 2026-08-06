import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { newEventId, providerFromServiceName } from "../canonical.js";
import {
  type ClaudePricingMode,
  type ClaudeTokenUsage,
  calculateClaudeCost,
  getClaudeCostWithMode,
} from "../cost.js";
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
 * Claude Code JSONL session importer.
 *
 * Adapted from the reference `backend/internal/importer/claude.go`:
 * session files live under `~/.config/claude/projects` (XDG) or
 * `~/.claude/projects` (legacy); each file is newline-delimited JSON
 * with `user`/`assistant` entries carrying message content blocks and
 * token usage. Metrics are deduplicated per `messageId:requestId`.
 */

interface ClaudeContent {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string;
  tool_use_id?: string;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeMessage {
  id?: string;
  model?: string;
  role?: string;
  type?: string;
  content?: ClaudeContent[];
  usage?: ClaudeUsage;
}

interface ClaudeEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  version?: string;
  cwd?: string;
  requestId?: string;
  costUSD?: number | null;
  message?: ClaudeMessage;
}

const CLAUDE_SERVICE = "claude-code";

export function claudeConfigPaths(envPath?: string): string[] {
  if (envPath) {
    return envPath
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }
  const home = homedir();
  const paths: string[] = [];
  const xdg = join(home, ".config", "claude", "projects");
  const legacy = join(home, ".claude", "projects");
  paths.push(xdg, legacy);
  return paths;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class ClaudeParser implements SessionParser {
  private readonly paths: string[];
  private readonly pricingMode: ClaudePricingMode;

  constructor(
    private readonly ctx: ParserContext,
    options: { paths?: string[]; envPath?: string; pricingMode?: ClaudePricingMode } = {},
  ) {
    this.paths = options.paths ?? claudeConfigPaths(options.envPath);
    this.pricingMode = options.pricingMode ?? "auto";
  }

  source(): ImportSource {
    return "claude-code";
  }

  async findSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const basePath of this.paths) {
      if (!(await fileExists(basePath))) continue;
      const stack = [basePath];
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
    return result;
  }

  async parseIncremental(filePath: string, state: ImportState): Promise<IncrementalResult> {
    const logs: LogInsert[] = [];
    const metrics: MetricInsert[] = [];
    const spans: SpanInsert[] = [];
    const receivedAt = new Date().toISOString();
    const seenRequests = new Set<string>(
      Array.isArray(state.parserState.seenRequests)
        ? (state.parserState.seenRequests as string[])
        : [],
    );
    let messageIndex =
      typeof state.parserState.messageIndex === "number"
        ? (state.parserState.messageIndex as number)
        : 0;
    const importSource = "local_jsonl";
    const importHash = undefined;

    const updateState = (): ImportState => ({
      byteOffset: 0,
      messageCount: state.messageCount,
      parserState: { seenRequests: [...seenRequests], messageIndex },
    });

    const { state: nextState, recordCount } = await readIncrementalLines(
      filePath,
      state,
      (line, _lineNo, hasNewline) => {
        if (line.trim() === "") return true;
        let entry: ClaudeEntry;
        try {
          entry = JSON.parse(line) as ClaudeEntry;
        } catch {
          // Commit malformed complete lines, but leave a partial trailing
          // line uncommitted so it is re-read next run (reference behavior).
          return hasNewline;
        }
        if (!entry.message) return true;
        if (entry.type !== "user" && entry.type !== "assistant") return true;
        const ts = parseTimestamp(entry.timestamp);
        if (!ts) return true;

        const sessionId = entry.sessionId ?? basename(filePath).replace(/\.jsonl$/, "");

        logs.push(...this.transcriptLogs(entry, ts, sessionId, messageIndex));
        messageIndex += this.countContent(entry);

        if (entry.type === "assistant" && entry.message.usage) {
          const dedupKey = `${entry.message.id ?? ""}:${entry.requestId ?? ""}`;
          if (entry.message.id && entry.requestId) {
            if (seenRequests.has(dedupKey)) return true;
            seenRequests.add(dedupKey);
          }
          const usage = entry.message.usage;
          const model = entry.message.model ?? "unknown";
          const tokenUsage: ClaudeTokenUsage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
          };

          logs.push({
            id: newEventId("tlog"),
            organizationId: this.ctx.organizationId,
            observedAt: ts,
            receivedAt,
            provider: "claude-code",
            sourceKind: "import",
            serviceName: CLAUDE_SERVICE,
            eventName: "claude_code.api_request",
            body: "api_request",
            severityText: "INFO",
            severityNumber: 9,
            sessionId,
            model,
            attributes: {
              "event.name": "claude_code.api_request",
              "session.id": sessionId,
              model,
              import_source: importSource,
              ...(entry.cwd ? { cwd: entry.cwd } : {}),
              ...(entry.requestId ? { request_id: entry.requestId } : {}),
            },
            dedupKey: `claude:api_request:${this.ctx.organizationId}:${entry.message.id ?? ""}:${entry.requestId ?? ""}`,
            importSource,
            importHash,
            parseStatus: "ok",
            rawAvailable: false,
          });

          const usageParts: Array<[string, number]> = [
            ["input", tokenUsage.inputTokens],
            ["output", tokenUsage.outputTokens],
            ["cacheCreation", tokenUsage.cacheCreationInputTokens],
            ["cacheRead", tokenUsage.cacheReadInputTokens],
          ];
          for (const [type, tokens] of usageParts) {
            if (tokens <= 0) continue;
            metrics.push(
              ...createTokenMetrics(
                this.ctx.organizationId,
                ts,
                receivedAt,
                model,
                type,
                tokens,
                sessionId,
              ),
            );
          }

          const cost = getClaudeCostWithMode(this.pricingMode, model, tokenUsage, entry.costUSD);
          if (cost > 0) {
            metrics.push(
              ...createCostMetrics(this.ctx.organizationId, ts, receivedAt, model, cost, sessionId),
            );
          }
        }
        return true;
      },
    );

    nextState.parserState.seenRequests = [...seenRequests];
    nextState.parserState.messageIndex = messageIndex;
    void updateState;
    return { logs, metrics, spans, state: nextState, recordCount };
  }

  private countContent(entry: ClaudeEntry): number {
    return entry.message?.content?.length ?? 0;
  }

  private transcriptLogs(
    entry: ClaudeEntry,
    ts: string,
    sessionId: string,
    messageIndex: number,
  ): LogInsert[] {
    const logs: LogInsert[] = [];
    const message = entry.message;
    if (!message?.content || message.content.length === 0) return logs;
    const baseRole = entry.type ?? "user";
    const receivedAt = new Date().toISOString();
    let index = messageIndex;
    for (const content of message.content) {
      if (!content.type) continue;
      let body: string;
      let role: string;
      const attributes: Record<string, unknown> = {
        "event.name": "transcript.message",
        "session.id": sessionId,
        "message.index": String(index),
        "message.role": baseRole,
        import_source: "local_jsonl",
      };
      if (message.model) attributes.model = message.model;
      if (message.id) attributes["message.id"] = message.id;

      switch (content.type) {
        case "text": {
          body = content.text ?? "";
          role = baseRole;
          if (body === "") continue;
          break;
        }
        case "tool_use": {
          role = "tool_use";
          attributes["message.role"] = role;
          attributes["tool.name"] = content.name ?? "";
          if (content.input !== undefined && content.input !== null) {
            attributes["tool.input"] = safeJsonStringify(content.input);
          }
          body = `Tool call: ${content.name ?? ""}`;
          break;
        }
        case "tool_result": {
          role = "tool_result";
          attributes["message.role"] = role;
          if (content.tool_use_id) attributes["tool.use_id"] = content.tool_use_id;
          if (content.content) attributes["tool.output"] = content.content;
          body = content.content ?? "";
          break;
        }
        default:
          index += 1;
          continue;
      }

      logs.push({
        id: newEventId("tlog"),
        organizationId: this.ctx.organizationId,
        observedAt: ts,
        receivedAt,
        provider: "claude-code",
        sourceKind: "import",
        serviceName: CLAUDE_SERVICE,
        eventName: "transcript.message",
        body,
        severityText: "INFO",
        severityNumber: 9,
        sessionId,
        model: message.model ?? undefined,
        toolName:
          content.type === "tool_use" || content.type === "tool_result"
            ? (content.name ?? content.tool_use_id)
            : undefined,
        attributes,
        dedupKey: `claude:transcript:${this.ctx.organizationId}:${sessionId}:${index}`,
        importSource: "local_jsonl",
        parseStatus: "ok",
        rawAvailable: false,
      });
      index += 1;
    }
    return logs;
  }
}

export function createTokenMetrics(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  tokenType: string,
  value: number,
  sessionId?: string,
): MetricInsert[] {
  const make = (name: string): MetricInsert => ({
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "claude-code",
    sourceKind: "import",
    serviceName: CLAUDE_SERVICE,
    name,
    metricType: "sum",
    sessionId,
    model,
    value,
    attributes: { type: tokenType, model, import_source: "local_jsonl" },
    dedupKey: `claude:metric:${name}:${organizationId}:${model}:${tokenType}:${ts}:${value}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  });
  return [make("claude_code.token.usage"), make("claude_code.token.usage_user_facing")];
}

export function createCostMetrics(
  organizationId: string,
  ts: string,
  receivedAt: string,
  model: string,
  costUsd: number,
  sessionId?: string,
): MetricInsert[] {
  const make = (name: string): MetricInsert => ({
    id: newEventId("tmet"),
    organizationId,
    observedAt: ts,
    receivedAt,
    provider: "claude-code",
    sourceKind: "import",
    serviceName: CLAUDE_SERVICE,
    name,
    metricType: "sum",
    sessionId,
    model,
    value: costUsd,
    attributes: { model, import_source: "local_jsonl" },
    dedupKey: `claude:cost:${name}:${organizationId}:${model}:${ts}:${costUsd}`,
    importSource: "local_jsonl",
    rawAvailable: false,
  });
  return [make("claude_code.cost.usage"), make("claude_code.cost.usage_user_facing")];
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export { calculateClaudeCost, providerFromServiceName };
