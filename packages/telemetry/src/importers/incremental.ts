import { open } from "node:fs/promises";
import type { ImportState } from "./types.js";

/**
 * Byte-offset incremental line reader (watcher dedupe safety).
 *
 * Adapted from the AI Observer reference `*_incremental.go` parsers:
 *
 * - resumes from the persisted byte offset;
 * - commits a line's bytes only when it is complete (has a trailing
 *   newline) and was processed successfully;
 * - a partial trailing line is left uncommitted so the next run
 *   re-reads it;
 * - the cursor advances only after durable success (callers persist
 *   state in the same transaction as the inserts).
 */
export interface IncrementalLineReaderOptions {
  onLine: (line: string, lineNo: number, hasNewline: boolean) => boolean | undefined;
  maxLineBytes?: number;
}

export interface IncrementalReadResult {
  state: ImportState;
  recordCount: number;
  eof: boolean;
}

export async function readIncrementalLines(
  filePath: string,
  state: ImportState,
  options:
    | IncrementalLineReaderOptions
    | ((line: string, lineNo: number, hasNewline: boolean) => boolean | undefined),
): Promise<IncrementalReadResult> {
  const onLine =
    typeof options === "function"
      ? options
      : (line: string, lineNo: number, hasNewline: boolean) =>
          options.onLine(line, lineNo, hasNewline);
  const handle = await open(filePath, "r");
  const nextState: ImportState = { ...state, parserState: { ...(state.parserState ?? {}) } };
  let committedBytes = 0;
  let recordCount = 0;
  let eof = false;
  try {
    const { size } = await handle.stat();
    if (state.byteOffset > size) {
      // File was truncated; restart from the beginning.
      nextState.byteOffset = 0;
      nextState.messageCount = 0;
      nextState.parserState = {};
    }
    const stream = handle.createReadStream({
      start: nextState.byteOffset,
      autoClose: false,
      highWaterMark: 1024 * 1024,
    });
    const reader = stream[Symbol.asyncIterator]();
    let buffer = "";
    let lineNo = 0;
    for (;;) {
      const { value, done } = await reader.next();
      if (done) {
        eof = true;
        break;
      }
      buffer += value.toString("utf8");
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const rawLine = buffer.slice(0, newlineIndex + 1);
        buffer = buffer.slice(newlineIndex + 1);
        const hasNewline = rawLine.endsWith("\n");
        const body = hasNewline ? rawLine.slice(0, -1) : rawLine;
        // Strip trailing CR for Windows line endings.
        const line = body.endsWith("\r") ? body.slice(0, -1) : body;
        lineNo += 1;
        const isComplete = hasNewline;
        const result = onLine(line, lineNo, hasNewline);
        if (result === false && !isComplete) {
          // Partial JSON line: do not commit; it will be re-read next run.
          committedBytes += 0;
          continue;
        }
        committedBytes += rawLine.length;
        if (result !== false) recordCount += 1;
      }
    }
    // Final partial line without newline: try to process it; commit only
    // if the handler accepted it (complete parse).
    if (buffer.length > 0) {
      lineNo += 1;
      const result = onLine(buffer, lineNo, false);
      if (result !== false) {
        committedBytes += buffer.length;
        recordCount += 1;
      }
    }
    nextState.byteOffset += committedBytes;
    nextState.messageCount = (nextState.messageCount ?? 0) + recordCount;
    return { state: nextState, recordCount, eof };
  } finally {
    await handle.close();
  }
}

/** Read an entire JSON document (used by the Gemini importer). */
export async function readWholeFile(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(filePath, "utf8");
}
