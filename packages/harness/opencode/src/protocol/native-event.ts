/**
 * Native OpenCode event shapes used by the server's SSE payloads.
 *
 * The server transports one JSON object per event frame:
 *
 *   { "type", "timestamp", "sessionID", ...data }
 *
 * Event types emitted for a run:
 *   - `text`       data: { part: { type: "text", text, time } }
 *   - `reasoning`  data: { part: { type: "reasoning", text, time } }  (only when --thinking)
 *   - `tool_use`   data: { part: { type: "tool", tool, id, state } }
 *   - `step_start` data: { part: { type: "step-start" } }
 *   - `step_finish`data: { part: { type: "step-finish", tokens, cost } }
 *   - `error`      data: { error: { name, data?: { message? }, ... } }
 *
 * Older server builds may emit `type: "thinking"` /
 * `part.type: "thinking"`; the decoder accepts both spellings.
 */
export type OpenCodeToolState =
  | {
      status?: "pending" | "running" | "completed" | "error" | "cancelled";
      output?: unknown;
      error?: unknown;
    }
  | { status?: string; output?: unknown; error?: unknown };

export interface OpenCodeNativePart {
  type: string;
  id?: string;
  messageID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  input?: unknown;
  args?: unknown;
  name?: string;
  reason?: string;
  time?: { start?: number; end?: number };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
  state?: OpenCodeToolState;
  [k: string]: unknown;
}

export interface OpenCodeNativeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodeNativePart;
  error?: unknown;
  [k: string]: unknown;
}

export function isToolState(value: unknown): value is OpenCodeToolState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
