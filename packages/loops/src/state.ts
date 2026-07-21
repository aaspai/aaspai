/**
 * Loop state — the `STATE.md`-shaped view.
 *
 * In foundation, this is built from the DB (wakeups + sessions +
 * recent run history). In Phase 4+ it can also be a queryable view
 * over the event log.
 */
import { getDefaultDb } from "@aaspai/db";
import { wakeups, sessions, type WakeupRow, type SessionRow } from "@aaspai/db";
import { desc, eq } from "drizzle-orm";
import type { WorkItemRef } from "@aaspai/contracts/phase2";

export interface LoopStateView {
  loopId: string;
  highPriority: WorkItemRef[];
  watch: WorkItemRef[];
  noise: WorkItemRef[];
  lastRun?: { at: string; outcome: "succeeded" | "failed" | "cancelled" | "escalated" | "noop"; summary: string };
  recentRuns: Array<{ at: string; outcome: string; summary: string }>;
  paused: boolean;
}

export class StateStore {
  /**
   * Read the loop's current state view. Pulls the last 30 days of
   * wakeups + sessions for this loop.
   */
  async view(loopId: string, opts: { recentDays?: number; limit?: number } = {}): Promise<LoopStateView> {
    const limit = opts.limit ?? 50;
    const recentDays = opts.recentDays ?? 30;
    const cutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000).toISOString();
    const db = getDefaultDb().db;

    const recentWakeups = (await db
      .select()
      .from(wakeups)
      .where(eq(wakeups.loopId, loopId))
      .orderBy(desc(wakeups.requestedAt))
      .limit(limit)) as WakeupRow[];

    const recentSessions = (await db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .limit(limit)) as SessionRow[];

    const highPriority: WorkItemRef[] = [];
    const watch: WorkItemRef[] = [];
    const noise: WorkItemRef[] = [];

    for (const w of recentWakeups) {
      if (w.status === "failed") highPriority.push({ kind: "wakeup", id: w.id, title: w.reason ?? w.triggerDetail ?? "" });
      else if (w.status === "completed") watch.push({ kind: "wakeup", id: w.id, title: w.reason ?? "" });
      else noise.push({ kind: "wakeup", id: w.id });
    }

    const recentRuns = recentSessions
      .filter((s) => s.startedAt && s.startedAt > cutoff)
      .map((s) => ({
        at: s.finishedAt ?? s.startedAt ?? "",
        outcome: s.status,
        summary: s.resultJson ? "result" : (s.errorMessage ?? "no result"),
      }));

    const lastRun = recentRuns[0];

    return {
      loopId,
      highPriority,
      watch,
      noise,
      lastRun: lastRun
        ? { at: lastRun.at, outcome: lastRun.outcome as LoopStateView["lastRun"] extends infer L ? L extends { outcome: infer O } ? O : never : never, summary: lastRun.summary }
        : undefined,
      recentRuns,
      paused: false,
    };
  }
}
