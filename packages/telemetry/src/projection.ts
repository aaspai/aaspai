import { randomUUID } from "node:crypto";
import { pickAttribute } from "./canonical.js";
import type { LogInsert } from "./repository.js";

/**
 * Session reconstruction / transcript projection.
 *
 * Raw logs are projected into a readable session timeline (plan §7.5,
 * OBS-F09). The projection is derived data: replaying the same raw
 * events must produce the same projection. The Aaspai session and
 * execution records remain authoritative for execution outcome.
 */

export type TranscriptRole =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system"
  | "unknown";

export interface TranscriptMessage {
  id: string;
  organizationId: string;
  sessionId: string;
  seq: number;
  ts: string;
  role: TranscriptRole;
  kind: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  attributes: Record<string, unknown>;
  raw?: unknown;
}

export interface SessionProjection {
  sessionId: string;
  organizationId: string;
  provider: string;
  firstSeenAt: string;
  lastSeenAt: string;
  model?: string;
  messageCount: number;
  toolCallCount: number;
  transcript: TranscriptMessage[];
}

/** Map an event name / attributes to a transcript role (reference semantics). */
export function mapEventToRole(
  eventName: string | undefined,
  attributes: Record<string, unknown> | null | undefined,
): TranscriptRole {
  const name = eventName ?? "";
  const explicitRole = pickAttribute(attributes, ["message.role"]);
  if (explicitRole) {
    switch (explicitRole) {
      case "user":
        return "user";
      case "assistant":
        return "assistant";
      case "tool_use":
        return "tool_use";
      case "tool_result":
        return "tool_result";
      default:
        return "unknown";
    }
  }
  if (name.includes("user_prompt") || name.includes("codex.user_message")) return "user";
  if (name.includes("api_request") || name.includes("api_response")) return "assistant";
  if (name.includes("tool_result")) return "tool_result";
  if (
    name.includes("tool_decision") ||
    name.includes("tool_call") ||
    name.includes("function_call")
  ) {
    return "tool_use";
  }
  if (name.includes("api_error") || name.includes("session.") || name.includes("conversation")) {
    return "system";
  }
  if (name === "transcript.message") return "unknown";
  return "unknown";
}

/** Extract message content from attributes (reference `extractMessageContent`). */
export function extractMessageContent(
  body: string,
  attributes: Record<string, unknown> | null | undefined,
): string {
  const toolOutput = pickAttribute(attributes, ["tool.output"]);
  if (toolOutput) return toolOutput;
  const text = pickAttribute(attributes, ["text", "content"]);
  if (text) return text;
  return body ?? "";
}

/** Derive a transcript from canonical log inserts. */
export function projectTranscript(logs: LogInsert[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  let seq = 0;
  for (const log of logs) {
    const eventName = log.eventName ?? pickAttribute(log.attributes, ["event.name"]) ?? undefined;
    const role = mapEventToRole(eventName, log.attributes);
    if (role === "unknown" && eventName !== "transcript.message") continue;
    const text = extractMessageContent(log.body ?? "", log.attributes);
    const toolName = log.toolName ?? pickAttribute(log.attributes, ["tool.name"]) ?? undefined;
    const toolInputRaw = pickAttribute(log.attributes, ["tool.input"]);
    const toolInput = toolInputRaw ? safeJsonParse(toolInputRaw) : undefined;
    messages.push({
      id: `tmsg_${randomUUID()}`,
      organizationId: log.organizationId,
      sessionId: log.sessionId ?? "",
      seq,
      ts: log.observedAt,
      role,
      kind: log.eventName ?? "transcript.message",
      text: text || undefined,
      toolName,
      toolInput,
      attributes: log.attributes ?? {},
      raw: log.rawAvailable ? log.raw : undefined,
    });
    seq += 1;
  }
  return messages;
}

/** Build a session summary projection from transcript + logs. */
export function projectSession(input: {
  organizationId: string;
  sessionId: string;
  provider: string;
  logs: LogInsert[];
  metrics?: Array<{ name: string; value?: number | null }>;
  traces?: string[];
  executions?: string[];
  attempts?: string[];
  model?: string;
}): SessionProjection {
  const transcript = projectTranscript(input.logs);
  const toolCallCount = transcript.filter((m) => m.role === "tool_use").length;
  const times = input.logs.map((l) => l.observedAt).filter(Boolean);
  const firstSeenAt = times.length
    ? times.reduce((a, b) => (a < b ? a : b))
    : new Date().toISOString();
  const lastSeenAt = times.length
    ? times.reduce((a, b) => (a > b ? a : b))
    : new Date().toISOString();
  const model =
    input.model ??
    input.logs.find((l) => l.model)?.model ??
    pickAttribute(input.logs[0]?.attributes ?? null, ["model"]) ??
    undefined;

  return {
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    provider: input.provider,
    firstSeenAt,
    lastSeenAt,
    model,
    messageCount: transcript.length,
    toolCallCount,
    transcript,
  };
}

function safeJsonParse(input: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
