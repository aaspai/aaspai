import type { AdapterSessionCodec } from "@aaspai/contracts/harness";

/**
 * Session identity codec for the OpenCode server adapter.
 *
 * Adapter-specific: normalizes the opencode native session id (surfaced
 * via `sessionId` / `session_id` / `nativeSessionId` or the adapter's
 * `nativeSession` binding) into a canonical `sessionId` without guessing at
 * arbitrary keys.
 */
const OPENCODE_SESSION_ID_KEYS = ["sessionId", "session_id", "nativeSessionId"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nativeSessionId(input: Record<string, unknown>): string | undefined {
  const direct = OPENCODE_SESSION_ID_KEYS.map((key) => stringValue(input[key])).find(Boolean);
  if (direct) return direct;
  const native = record(input.nativeSession);
  return native ? stringValue(native.nativeSessionId) : undefined;
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const input = record(raw);
  if (!input) return null;
  const id = nativeSessionId(input);
  return id ? { ...input, sessionId: id } : null;
}

export const opencodeSessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId: (params) => (normalize(params)?.sessionId as string | undefined) ?? null,
};
