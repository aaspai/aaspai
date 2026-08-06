import type { LogInsert, MetricInsert, SpanInsert } from "../repository.js";

/**
 * Native provider file importers.
 *
 * Interfaces and behavior adapted from the AI Observer reference
 * `backend/internal/importer` (MIT licensed). Each parser:
 *
 * - finds session files under provider-specific paths;
 * - parses one file into canonical inserts (logs, metrics, spans);
 * - preserves raw records;
 * - reports record-level parse errors instead of failing the file;
 * - returns a deterministic source cursor for resumable import.
 */

export type ImportSource = "claude-code" | "codex_cli_rs" | "gemini_cli" | "aaspai";

export const IMPORT_SOURCES: ImportSource[] = ["claude-code", "codex_cli_rs", "gemini_cli"];

export interface ImportResult {
  filePath: string;
  sessionId: string;
  logs: LogInsert[];
  metrics: MetricInsert[];
  spans: SpanInsert[];
  recordCount: number;
  firstTime: string | null;
  lastTime: string | null;
  errors: ImportError[];
}

export interface ImportError {
  filePath: string;
  line?: number;
  error: string;
}

export interface ImportState {
  byteOffset: number;
  messageCount: number;
  parserState: Record<string, unknown>;
}

export interface IncrementalResult {
  logs: LogInsert[];
  metrics: MetricInsert[];
  spans: SpanInsert[];
  state: ImportState;
  recordCount: number;
}

export interface SessionParser {
  source(): ImportSource;
  findSessionFiles(): Promise<string[]>;
  parseFile(filePath: string): Promise<ImportResult>;
  parseIncremental(filePath: string, state: ImportState): Promise<IncrementalResult>;
}

export interface ParserContext {
  organizationId: string;
}

/** Parse an RFC3339(Nano) timestamp into an ISO string, or null. */
export function parseTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Compute the SHA-256 hash of a file's contents. */
export async function computeFileHash(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}
