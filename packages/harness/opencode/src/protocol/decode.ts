import type { OpenCodeNativeEvent } from "./native-event.js";

/**
 * Decode one normalized JSON event line into a typed
 * native event. Invalid or empty lines return `null`.
 */
export function decodeOpenCodeLine(line: string): OpenCodeNativeEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== "string" || event.type.length === 0) return null;
  const result: OpenCodeNativeEvent = { type: event.type };
  if (typeof event.timestamp === "number") result.timestamp = event.timestamp;
  if (typeof event.sessionID === "string" && event.sessionID.trim()) {
    result.sessionID = event.sessionID;
  }
  if (event.part && typeof event.part === "object" && !Array.isArray(event.part)) {
    result.part = event.part as OpenCodeNativeEvent["part"];
  }
  if ("error" in event) result.error = event.error;
  return result;
}
