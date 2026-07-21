import type { TranscriptEntry } from "@aaspai/contracts/harness";
import pc from "picocolors";

/**
 * Pretty-print one transcript entry to a terminal-friendly line.
 * Coloured with picocolors; falls back to plain text when colors are off.
 */
export function formatClaudeTranscriptEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "init":
      return pc.blue(`[init]${entry.model ? ` model=${entry.model}` : ""}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`);
    case "assistant":
      return entry.text;
    case "thinking":
      return pc.gray(`[thinking] ${entry.text}`);
    case "user":
      return pc.cyan(`[user] ${entry.text}`);
    case "tool_call":
      return pc.yellow(`[tool:${entry.name}${entry.id ? `:${entry.id}` : ""}] ${entry.status}`);
    case "tool_result": {
      const head = pc.cyan(`[result:${entry.name}${entry.id ? `:${entry.id}` : ""}]`);
      if (entry.isError) return pc.red(`${head} ${entry.output ?? ""}`);
      return `${head} ${entry.output ?? ""}`;
    }
    case "result":
      return pc.blue(`[result]${entry.summary ? ` ${entry.summary}` : ""}${entry.isError ? " (error)" : ""}`);
    case "stderr":
      return pc.red(`[stderr] ${entry.text}`);
    case "system":
      return pc.gray(`[system] ${entry.text}`);
    case "stdout":
      return entry.text;
    case "diff":
      return pc.magenta(`[diff:${entry.path}]\n${entry.patch}`);
    default: {
      const _exhaustive: never = entry;
      void _exhaustive;
      return "";
    }
  }
}
