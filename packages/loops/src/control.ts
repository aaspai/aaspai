import type { LoopPattern } from "@aaspai/contracts/phase2";
import { getDefaultDb, loopControls, type SqliteDb } from "@aaspai/db";
import { and, eq } from "drizzle-orm";

export class LoopControlStore {
  constructor(private readonly db: SqliteDb = getDefaultDb().db) {}

  async setPaused(
    organizationId: string,
    pattern: LoopPattern,
    paused: boolean,
    reason?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(loopControls)
      .values({
        organizationId,
        loopId: pattern.id,
        paused,
        pauseReason: paused ? (reason ?? "manual pause") : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [loopControls.organizationId, loopControls.loopId],
        set: {
          paused,
          pauseReason: paused ? (reason ?? "manual pause") : null,
          updatedAt: now,
        },
      });
  }

  async isPaused(organizationId: string, loopId: string): Promise<boolean> {
    const rows = await this.db
      .select({ paused: loopControls.paused })
      .from(loopControls)
      .where(and(eq(loopControls.organizationId, organizationId), eq(loopControls.loopId, loopId)))
      .limit(1);
    return rows[0]?.paused === true;
  }
}
