import type { TranscriptEntry } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { redactHomePath } from "../../shared/redact.js";
import { type CodexStreamEvent, codexStreamEventSchema } from "./config.js";

/**
 * Parse a single line of `codex exec --json` output into zero or more
 * `TranscriptEntry`s. Mirrors the entry kinds the foundation emits.
 */
export function parseCodexStreamLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "stdout", ts, text: redactHomePath(line) }];
  }

  const result = codexStreamEventSchema.safeParse(parsed);
  if (!result.success) {
    return [{ kind: "stdout", ts, text: redactHomePath(line) }];
  }
  return codexEventToTranscript(result.data, ts);
}

function codexEventToTranscript(event: CodexStreamEvent, ts: string): TranscriptEntry[] {
  const sessionId = event.thread_id ?? event.session_id;

  switch (event.type) {
    case "thread.started":
    case "session.started":
      return [{ kind: "init", ts, sessionId }];
    case "turn.started":
      return [{ kind: "system", ts, text: "turn started" }];
    case "turn.completed": {
      const usage = event.usage;
      const summaryParts: string[] = [];
      if (usage?.input_tokens !== undefined) summaryParts.push(`in=${usage.input_tokens}`);
      if (usage?.output_tokens !== undefined) summaryParts.push(`out=${usage.output_tokens}`);
      return [
        {
          kind: "result",
          ts,
          summary: summaryParts.length > 0 ? summaryParts.join(" ") : undefined,
          stopReason: "completed",
        },
      ];
    }
    case "turn.failed": {
      const errorText =
        typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {});
      return [
        { kind: "result", ts, summary: errorText, isError: true, stopReason: "failed" },
        { kind: "stderr", ts, text: errorText },
      ];
    }
    case "item.completed":
    case "item.started":
    case "item.updated": {
      const item = event.item as
        | {
            type?: string;
            name?: string;
            text?: string;
            content?: unknown;
            id?: string;
            status?: string;
            input?: unknown;
            output?: unknown;
            is_error?: boolean;
          }
        | undefined;
      if (!item) return [{ kind: "system", ts, text: JSON.stringify(event) }];
      if (item.type === "agent_message" && typeof item.text === "string") {
        return [{ kind: "assistant", ts, text: item.text }];
      }
      if (item.type === "reasoning" && typeof item.text === "string") {
        return [{ kind: "thinking", ts, text: item.text }];
      }
      if (item.type === "command_execution" || item.type === "tool_call") {
        const name = item.name ?? (item.type === "command_execution" ? "command" : "tool");
        const status =
          event.type === "item.completed"
            ? "completed"
            : event.type === "item.started"
              ? "started"
              : "started";
        const input: JsonObject | undefined = isObject(item.input)
          ? (item.input as JsonObject)
          : undefined;
        return [
          {
            kind: "tool_call",
            ts,
            name,
            id: item.id,
            status,
            input,
          },
        ];
      }
      if (item.type === "command_execution_output" || item.type === "tool_result") {
        const output =
          typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        return [
          {
            kind: "tool_result",
            ts,
            name: item.name ?? "tool",
            id: item.id,
            output,
            isError: item.is_error === true,
          },
        ];
      }
      return [{ kind: "system", ts, text: JSON.stringify(event) }];
    }
    case "error": {
      const text =
        typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {});
      return [{ kind: "stderr", ts, text }];
    }
    default:
      return [{ kind: "system", ts, text: JSON.stringify(event) }];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
