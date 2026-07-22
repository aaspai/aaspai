import type { TranscriptEntry } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { redactHomePath } from "../../shared/redact.js";
import { type ClaudeStreamEvent, claudeStreamEventSchema } from "./config.js";

/**
 * Parse a single line of Claude Code's `stream-json` output into zero
 * or more `TranscriptEntry`s. Mirrors the entry kinds every adapter in
 * the foundation emits (assistant / thinking / tool_call / tool_result /
 * init / result / stderr / system / stdout).
 */
export function parseClaudeStreamLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "stdout", ts, text: redactHomePath(line) }];
  }

  const result = claudeStreamEventSchema.safeParse(parsed);
  if (!result.success) {
    return [{ kind: "stdout", ts, text: redactHomePath(line) }];
  }
  return claudeEventToTranscript(result.data, ts);
}

function claudeEventToTranscript(event: ClaudeStreamEvent, ts: string): TranscriptEntry[] {
  switch (event.type) {
    case "system": {
      const sessionId = event.session_id;
      if (event.subtype === "init" || event.subtype === "session_start") {
        return [
          {
            kind: "init",
            ts,
            model: typeof event.message === "string" ? event.message : undefined,
            sessionId,
          },
        ];
      }
      return [{ kind: "system", ts, text: JSON.stringify(event.message ?? event) }];
    }
    case "assistant": {
      const message = event.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
      const entries: TranscriptEntry[] = [];
      for (const block of blocks) {
        if (!isObject(block)) continue;
        const bType = typeof block.type === "string" ? block.type : "";
        if (bType === "text" && typeof block.text === "string") {
          entries.push({ kind: "assistant", ts, text: block.text, delta: false });
        } else if (bType === "thinking" && typeof block.thinking === "string") {
          entries.push({ kind: "thinking", ts, text: block.thinking, delta: false });
        } else if (bType === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          const id = typeof block.id === "string" ? block.id : undefined;
          const input: JsonObject = isObject(block.input) ? (block.input as JsonObject) : {};
          entries.push({
            kind: "tool_call",
            ts,
            name,
            id,
            status: "started",
            input,
          });
        }
      }
      return entries.length > 0
        ? entries
        : [{ kind: "assistant", ts, text: JSON.stringify(message ?? event) }];
    }
    case "user": {
      const message = event.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        const blocks = message.content as unknown[];
        const out: TranscriptEntry[] = [];
        for (const block of blocks) {
          if (!isObject(block)) continue;
          if (block.type === "tool_result") {
            const name = typeof block.name === "string" ? block.name : "tool";
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
            const content = block.content;
            const text = typeof content === "string" ? content : JSON.stringify(content);
            out.push({
              kind: "tool_result",
              ts,
              name,
              id,
              output: text,
              isError: block.is_error === true,
            });
          }
        }
        return out.length > 0 ? out : [{ kind: "user", ts, text: JSON.stringify(message) }];
      }
      return [{ kind: "user", ts, text: JSON.stringify(message ?? event) }];
    }
    case "result": {
      const summary = (event as { result?: string }).result;
      const isError = (event as { is_error?: boolean }).is_error === true;
      const entry: TranscriptEntry = {
        kind: "result",
        ts,
        summary: typeof summary === "string" ? summary : undefined,
        isError,
        stopReason: event.subtype,
      };
      return [entry];
    }
    case "error": {
      const message = (event as { error?: { message?: string } }).error;
      const text = message?.message ?? JSON.stringify(event);
      return [{ kind: "stderr", ts, text }];
    }
    default: {
      return [{ kind: "system", ts, text: JSON.stringify(event) }];
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
