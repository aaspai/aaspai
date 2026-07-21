/**
 * discover.ts — read recent sessions + recent wakeups from the DB.
 * Returns them as `WorkItem`s for the decide function to evaluate.
 */
import { getDefaultDb } from "@aaspai/db";
import { sessions, wakeups, type SessionRow, type WakeupRow } from "@aaspai/db";
import { desc, gte } from "drizzle-orm";
import type { WorkItem } from "@aaspai/contracts/phase2";

const LOOKBACK_HOURS = 24;

// We type the db as the SQLite variant for foundation (no-op for
// Postgres path; Phase 4 swaps this in).
type Db = ReturnType<typeof getDefaultDb>["db"];

export default async function discover(): Promise<readonly WorkItem[]> {
  const db = getDefaultDb().db as Db;
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const recentSessions = await db
    .select()
    .from(sessions)
    .where(gte(sessions.startedAt, cutoff))
    .orderBy(desc(sessions.startedAt))
    .limit(50);

  const recentWakeups = await db
    .select()
    .from(wakeups)
    .where(gte(wakeups.requestedAt, cutoff))
    .orderBy(desc(wakeups.requestedAt))
    .limit(50);

  const items: WorkItem[] = [];

  for (const s of recentSessions) {
    items.push({
      ref: { kind: "session", id: s.id, title: s.prompt.slice(0, 80) },
      title: `${s.status}: ${s.prompt.slice(0, 60)}`,
      description: `agent=${s.agentId} adapter=${s.adapter} started=${s.startedAt ?? "?"}`,
      discoveredAt: s.startedAt ?? new Date().toISOString(),
      data: { kind: "session", status: s.status, errorMessage: s.errorMessage },
    });
  }

  for (const w of recentWakeups) {
    items.push({
      ref: { kind: "wakeup", id: w.id, title: w.reason ?? w.triggerDetail ?? "wakeup" },
      title: `${w.status}: ${w.reason ?? w.triggerDetail ?? ""}`.trim(),
      description: `loop=${w.loopId} source=${w.source} status=${w.status}`,
      discoveredAt: w.requestedAt,
      data: { kind: "wakeup", status: w.status, error: w.error },
    });
  }

  return items;
}
