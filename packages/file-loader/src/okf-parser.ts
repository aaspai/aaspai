import { z } from "zod";
import * as jsYaml from "js-yaml";
import { okfFrontmatterSchema } from "@aaspai/contracts/phase2";

/**
 * Parse a single OKF / SKILL.md-style file.
 *
 * The format is:
 *
 *     ---
 *     <YAML frontmatter>
 *     ---
 *     <markdown body>
 *
 * The frontmatter is validated against the OKF reserved fields. The
 * body is the content of the concept / skill / agent.
 */
export interface ParsedFile<T = unknown> {
  frontmatter: T;
  body: string;
  raw: string;
  hash: string;
}

export class OkfParseError extends Error {
  readonly code = "AASPAI_OKF_PARSE_ERROR";
  constructor(message: string, readonly filePath?: string) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = "OkfParseError";
  }
}

const FENCE = "---";
const SHA256_HEX_LENGTH = 64;

/** Minimal sha256 hex (Web Crypto, available in Node 20+). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Synchronous sha256 hex — uses Node's `node:crypto`. */
export function sha256HexSync(input: string): string {
  const { createHash } = nodeCrypto;
  return createHash("sha256").update(input).digest("hex");
}

import * as nodeCrypto from "node:crypto";

/**
 * Parse a markdown file with YAML frontmatter. Validates the
 * frontmatter against the OKF reserved fields. Throws OkfParseError
 * on malformed input.
 */
export function parseOkfFile<T = z.infer<typeof okfFrontmatterSchema>>(
  raw: string,
  opts: { filePath?: string; frontmatterSchema?: z.ZodType<T> } = {},
): ParsedFile<T> {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE)) {
    throw new OkfParseError("File does not start with --- frontmatter fence", opts.filePath);
  }
  const endIndex = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (endIndex < 0) {
    throw new OkfParseError("Frontmatter fence is not closed", opts.filePath);
  }
  const yaml = text.slice(FENCE.length + 1, endIndex).trim();
  const body = text.slice(endIndex + FENCE.length + 2).replace(/^\n/, "");
  let frontmatter: unknown;
  try {
    frontmatter = jsYaml.load(yaml, { schema: jsYaml.JSON_SCHEMA });
  } catch (err) {
    throw new OkfParseError(`YAML parse error: ${(err as Error).message}`, opts.filePath);
  }
  if (frontmatter === null || typeof frontmatter !== "object") {
    throw new OkfParseError("Frontmatter must be a YAML object", opts.filePath);
  }
  const schema = opts.frontmatterSchema ?? (okfFrontmatterSchema as unknown as z.ZodType<T>);
  const result = schema.safeParse(frontmatter);
  if (!result.success) {
    throw new OkfParseError(
      `Frontmatter validation failed: ${result.error.issues.map((i) => i.message).join("; ")}`,
      opts.filePath,
    );
  }
  const hash = sha256HexSync(raw);
  if (hash.length !== SHA256_HEX_LENGTH) {
    throw new OkfParseError("Hash computation failed", opts.filePath);
  }
  return { frontmatter: result.data, body, raw, hash };
}

/** Serialize a parsed file back to its markdown form. */
export function serializeOkfFile(file: { frontmatter: Record<string, unknown>; body: string }): string {
  const yaml = jsYaml.dump(file.frontmatter, { schema: jsYaml.JSON_SCHEMA, lineWidth: 120 });
  return `---\n${yaml}\n---\n\n${file.body}\n`;
}
