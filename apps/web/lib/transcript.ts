/**
 * Chat transcript normalization.
 *
 * The session event stream emits flat `session_events` rows (kind +
 * payload). A single assistant "turn" produces many interleaved parts:
 * text deltas, thinking blocks, and tool calls with their results.
 *
 * `buildTurnParts` merges that flat stream into an ordered list of
 * renderable parts — mirroring how assistant-ui / paperclip represent a
 * chat message (text / reasoning / tool-call parts) — so the UI can
 * render one proper assistant bubble per turn instead of a raw log.
 *
 * `buildUIMessages` emits the Vercel AI SDK's standard `UIMessage`
 * format (`{ id, role, parts }` with `text` / `reasoning` /
 * `dynamic-tool` parts), so any AI-SDK-compatible frontend (AI Elements,
 * etc.) can render the conversation.
 */
import type { UIMessage } from "ai";

export interface ChatPartBase {
  seq: number;
}

export interface TextPart extends ChatPartBase {
  type: "text";
  text: string;
}

export interface ThinkingPart extends ChatPartBase {
  type: "thinking";
  text: string;
}

export interface ToolPart extends ChatPartBase {
  type: "tool";
  name: string;
  id?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export type ChatPart = TextPart | ThinkingPart | ToolPart;

/** Raw session event as received from the SSE stream / session detail. */
export interface StreamEntry {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  ts: string;
}

/** The stream payload kinds that map to transcript parts. */
const PART_KINDS = new Set(["assistant", "thinking", "tool_call", "tool_result", "result"]);

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Merge a flat event stream into ordered chat parts.
 *
 * - `assistant` text deltas are concatenated into a single text part
 *   (per assistant segment) for clean markdown rendering.
 * - `thinking` deltas are grouped into one thinking block.
 * - `tool_call` / `tool_result` with the same id are merged into a
 *   single tool part (input from the call, output from the result).
 */
export function buildTurnParts(entries: readonly StreamEntry[]): ChatPart[] {
  const parts: ChatPart[] = [];
  const tools = new Map<string, ToolPart>();

  const pushText = (text: string, seq: number) => {
    const last = parts.at(-1);
    if (last?.type === "text") {
      last.text += text;
    } else {
      parts.push({ type: "text", text, seq });
    }
  };

  for (const entry of entries) {
    if (!PART_KINDS.has(entry.kind)) continue;
    const p = entry.payload;

    if (entry.kind === "assistant") {
      const text = asString(p.text);
      if (text) pushText(text, entry.seq);
      continue;
    }

    if (entry.kind === "thinking") {
      const text = asString(p.text);
      if (!text) continue;
      const last = parts.at(-1);
      if (last?.type === "thinking") {
        last.text += text;
      } else {
        parts.push({ type: "thinking", text, seq: entry.seq });
      }
      continue;
    }

    if (entry.kind === "tool_call" || entry.kind === "tool_result") {
      const name = asString(p.name);
      const id = asString(p.id) || `${name}-${entry.seq}`;
      const status = asString(p.status);
      const existing = tools.get(id);
      if (entry.kind === "tool_call") {
        const part: ToolPart = {
          type: "tool",
          name,
          id,
          status,
          input: p.input ?? p.arguments,
          seq: entry.seq,
        };
        tools.set(id, part);
        parts.push(part);
      } else if (existing) {
        existing.status = status || existing.status;
        existing.output = p.output;
        existing.isError = p.isError === true || status === "failed";
      } else {
        // result without a preceding call (e.g. ask_user answer)
        parts.push({
          type: "tool",
          name,
          id,
          status,
          output: p.output,
          isError: p.isError === true || status === "failed",
          seq: entry.seq,
        });
      }
      continue;
    }

    if (entry.kind === "result") {
      const summary = asString(p.summary);
      if (summary) pushText(summary, entry.seq);
    }
  }

  return parts;
}

/** Extract the plain-text reply (for the compact final bubble). */
export function replyText(entries: readonly StreamEntry[]): string {
  const assistant = entries
    .filter((e) => e.kind === "assistant")
    .map((e) => asString(e.payload.text))
    .join("");
  if (assistant) return assistant;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const summary = asString(entries[i]?.payload.summary);
    if (entries[i]?.kind === "result" && summary) return summary;
  }
  return "";
}

/** Describe a tool call in one line for the collapsed header. */
export function toolSummary(part: ToolPart): string {
  if (typeof part.input === "string" && part.input.trim()) return part.input.trim();
  if (part.input && typeof part.input === "object") {
    const record = part.input as Record<string, unknown>;
    const path = record.path ?? record.filePath ?? record.url;
    if (typeof path === "string") return path;
    const command = record.command;
    if (typeof command === "string") return command.slice(0, 120);
    const prompt = record.prompt;
    if (typeof prompt === "string") return prompt.slice(0, 120);
  }
  return "";
}

/**
 * Build the standard Vercel AI SDK `UIMessage` representation of a
 * session transcript. Produces one assistant message whose parts are
 * `text`, `reasoning`, and `dynamic-tool` — the exact shape AI Elements
 * and other AI-SDK frontends consume. `seq` is used as the message id
 * for stable re-rendering.
 */
export function buildUIMessages(entries: readonly StreamEntry[]): UIMessage[] {
  const parts = buildTurnParts(entries);
  const uiParts: UIMessage["parts"] = [];
  for (const part of parts) {
    if (part.type === "text") {
      uiParts.push({ type: "text", text: part.text, state: "done" });
    } else if (part.type === "thinking") {
      uiParts.push({ type: "reasoning", text: part.text, state: "done" });
    } else if (part.type === "tool") {
      const base = {
        toolName: part.name,
        toolCallId: part.id ?? `${part.name}-${part.seq}`,
        title: part.name,
      };
      if (part.isError) {
        uiParts.push({
          ...base,
          type: "dynamic-tool",
          state: "output-error",
          input: part.input ?? {},
          errorText: asString(part.output) || "tool failed",
        });
      } else if (part.output !== undefined) {
        uiParts.push({
          ...base,
          type: "dynamic-tool",
          state: "output-available",
          input: part.input ?? {},
          output: part.output,
        });
      } else {
        uiParts.push({
          ...base,
          type: "dynamic-tool",
          state: "input-available",
          input: part.input ?? {},
        });
      }
    }
  }
  if (uiParts.length === 0) return [];
  return [
    {
      id: `msg-${parts[0]?.seq ?? 0}`,
      role: "assistant",
      parts: uiParts,
    },
  ];
}
