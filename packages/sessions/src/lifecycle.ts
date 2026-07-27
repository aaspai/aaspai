import type { SessionResult } from "@aaspai/contracts/phase2";
import type { Sessions } from "./sessions.js";

/** Public lifecycle facade; state changes still belong to the Sessions owner. */
export function pause(sessions: Sessions, id: string, reason: string): Promise<void> {
  return sessions.pause(id, reason);
}

export function resume(
  sessions: Sessions,
  id: string,
  answer?: string,
): Promise<SessionResult | null> {
  return sessions.resume(id, answer);
}

export function stop(sessions: Sessions, id: string, reason: string): Promise<void> {
  return sessions.stop(id, reason);
}

export function cancel(sessions: Sessions, id: string, reason: string): Promise<void> {
  return sessions.cancel(id, reason);
}
