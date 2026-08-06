import { createHash, randomUUID } from "node:crypto";
import type { TelemetryProvider, TelemetrySourceKind } from "@aaspai/contracts";

/**
 * Canonical model helpers.
 *
 * Everything that enters telemetry storage passes through here so that
 * provider names, timestamps, and correlation fields use one vocabulary
 * (the plan §7 common envelope). Unknown values stay null — never empty
 * strings.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

export function newEventId(prefix = "tlx"): string {
  return `${prefix}_${randomUUID()}`;
}

/** Map an OTLP service name to the canonical provider enum. */
export function providerFromServiceName(serviceName: string | null | undefined): TelemetryProvider {
  const name = (serviceName ?? "").trim().toLowerCase();
  switch (name) {
    case "claude-code":
      return "claude-code";
    case "codex":
    case "codex_cli_rs":
      return "codex_cli_rs";
    case "gemini":
    case "gemini_cli":
      return "gemini_cli";
    case "opencode":
      return "opencode";
    case "copilot-chat":
      return "copilot-chat";
    case "github-copilot":
      return "github-copilot";
    default:
      if (name === "" || name === "unknown") return "unknown";
      if (name.startsWith("aaspai")) return "aaspai";
      if (name === "runtime" || name.includes("runtime")) return "runtime";
      return "unknown";
  }
}

export function serviceNameForProvider(provider: TelemetryProvider): string {
  switch (provider) {
    case "claude-code":
      return "claude-code";
    case "codex_cli_rs":
      return "codex_cli_rs";
    case "gemini_cli":
      return "gemini_cli";
    case "opencode":
      return "opencode";
    case "copilot-chat":
      return "copilot-chat";
    case "github-copilot":
      return "github-copilot";
    case "aaspai":
      return "aaspai";
    case "runtime":
      return "runtime";
    default:
      return "unknown";
  }
}

/** Convert an OTLP `timeUnixNano` (string or number of ns since epoch) to ISO-8601. */
export function nanosToIso(nanos: string | number | bigint | null | undefined): string | null {
  if (nanos === null || nanos === undefined || nanos === "" || nanos === 0) return null;
  const ns = BigInt(nanos);
  if (ns === 0n) return null;
  const ms = ns / 1_000_000n;
  return new Date(Number(ms)).toISOString();
}

/** Convert a JS Date or ISO string to ISO-8601 (round-trip safe). */
export function toIso(input: Date | string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) return input.toISOString();
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Current time as ISO-8601 (always valid). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Attribute key map → canonical JSON object with bounded size. */
export function attributesToJson(attributes: Record<string, unknown> | null | undefined): {
  json: Record<string, unknown>;
  redacted: boolean;
} {
  const out: Record<string, unknown> = {};
  const redacted = false;
  if (!attributes) return { json: out, redacted };
  for (const [key, value] of Object.entries(attributes)) {
    if (key.length === 0) continue;
    out[key.slice(0, 512)] = value;
  }
  return { json: out, redacted };
}

/** Flatten an OTLP AnyValue into a JSON-safe primitive. */
export function anyValueToJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj !== "object") return String(value);

  // OTLP AnyValue shapes
  if ("stringValue" in obj) return obj.stringValue;
  if ("boolValue" in obj) return obj.boolValue;
  if ("intValue" in obj) return Number(obj.intValue);
  if ("doubleValue" in obj) return obj.doubleValue;
  if ("bytesValue" in obj) {
    const bytes = obj.bytesValue;
    return typeof bytes === "string" ? bytes.slice(0, 8_192) : null;
  }
  if ("arrayValue" in obj && obj.arrayValue && typeof obj.arrayValue === "object") {
    const values = (obj.arrayValue as { values?: unknown[] }).values ?? [];
    return values.slice(0, 128).map((v) => anyValueToJson(v));
  }
  if ("kvlistValue" in obj && obj.kvlistValue && typeof obj.kvlistValue === "object") {
    const kvs =
      (obj.kvlistValue as { values?: Array<{ key?: string; value?: unknown }> }).values ?? [];
    const out: Record<string, unknown> = {};
    for (const kv of kvs.slice(0, 128)) {
      if (kv.key) out[kv.key] = anyValueToJson(kv.value);
    }
    return out;
  }
  return JSON.stringify(value).slice(0, 4_096);
}

/** Extract a string attribute by trying candidate keys in order. */
export function pickAttribute(
  attributes: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!attributes) return null;
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Extract a numeric attribute by trying candidate keys in order. */
export function pickNumberAttribute(
  attributes: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  if (!attributes) return null;
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Derive a stable dedup key for a canonical event. Content-based keys
 * make OTLP retries and watcher re-reads idempotent.
 */
export function dedupKeyFor(
  organizationId: string,
  provider: string,
  table: "log" | "span" | "metric",
  parts: Array<string | number | undefined | null>,
): string {
  const stable = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
  return `${table}:${organizationId}:${provider}:${sha1Hex(stable)}`;
}

export function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** Stable hash used for import cursors and dedup keys. */
export function stableHash(input: string): string {
  return sha1Hex(input);
}

export type { TelemetryProvider, TelemetrySourceKind };
