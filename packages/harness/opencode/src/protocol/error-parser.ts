/**
 * Pull a human-readable message out of an opencode error event.
 *
 * OpenCode emits either a string (`"api key invalid"`) or an object shaped
 * like `{ name, data: { message }, code }` (matching a session error payload).
 * We try the obvious slots in priority order and fall back to JSON.stringify.
 */
export function extractErrorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const direct = typeof rec.message === "string" ? rec.message.trim() : "";
    if (direct) return direct;
    const data = rec.data;
    if (data && typeof data === "object") {
      const nested =
        typeof (data as Record<string, unknown>).message === "string"
          ? ((data as Record<string, unknown>).message as string).trim()
          : "";
      if (nested) return nested;
    }
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (name) return name;
    const code = typeof rec.code === "string" ? rec.code.trim() : "";
    if (code) return code;
    return JSON.stringify(rec);
  }
  return undefined;
}
