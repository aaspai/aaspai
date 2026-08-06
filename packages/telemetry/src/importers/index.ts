import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { GeminiParser } from "./gemini.js";
import type { ImportSource, ParserContext, SessionParser } from "./types.js";

export { ClaudeParser } from "./claude.js";
export { CodexParser } from "./codex.js";
export { GeminiParser } from "./gemini.js";
export { readIncrementalLines, readWholeFile } from "./incremental.js";
export {
  computeFileHash,
  IMPORT_SOURCES,
  type ImportError,
  type ImportResult,
  type ImportSource,
  type ImportState,
  type IncrementalResult,
  type ParserContext,
  parseTimestamp,
  type SessionParser,
} from "./types.js";

export function parserFor(
  source: ImportSource,
  ctx: ParserContext,
  options: {
    envPath?: string;
    paths?: string[];
    sessionsPath?: string;
    codexHome?: string;
    geminiHome?: string;
  } = {},
): SessionParser {
  switch (source) {
    case "claude-code":
      return new ClaudeParser(ctx, { envPath: options.envPath, paths: options.paths });
    case "codex_cli_rs":
      return new CodexParser(ctx, {
        envPath: options.envPath,
        sessionsPath: options.sessionsPath,
        codexHome: options.codexHome,
      });
    case "gemini_cli":
      return new GeminiParser(ctx, { envPath: options.envPath, geminiHome: options.geminiHome });
    default:
      throw new Error(`unsupported import source: ${source}`);
  }
}
