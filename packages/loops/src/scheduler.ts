/**
 * Scheduler — the part that fires triggers and creates wakeups.
 *
 * Foundation slice: single-process, no leader election. Multi-replica
 * lands in Phase 4 (adds a `worker_leader_lease` table + the same
 * `INSERT ... ON CONFLICT DO UPDATE WHERE ...` pattern as suna).
 */

import { randomUUID } from "node:crypto";
import type { LoopPattern, Trigger, Wakeup } from "@aaspai/contracts/phase2";
import { getDefaultDb } from "@aaspai/db";
import { type WakeupInsert, wakeups as wakeupsTable } from "@aaspai/db/schema/phase2";
import { getLogger } from "@aaspai/observability";
import cronParser from "cron-parser";
import type { KillSwitch } from "./kill-switch.js";
import type { PatternRegistry } from "./pattern.js";

const log = getLogger("loops.scheduler");

export interface TickResult {
  fired: number;
  deferred: number;
  skipped: number;
}

export class Scheduler {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly registry: PatternRegistry,
    private readonly killSwitch: KillSwitch,
    private readonly opts: { tickIntervalMs?: number; organizationId?: string } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.opts.tickIntervalMs ?? 60_000;
    this.interval = setInterval(() => {
      this.tick(new Date()).catch((err) => log.error("tick failed", { err: String(err) }));
    }, intervalMs);
    this.interval.unref();
    log.info("Scheduler started", { intervalMs });
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick(now: Date): Promise<TickResult> {
    if (this.killSwitch.isGlobalPaused()) {
      return { fired: 0, deferred: 0, skipped: 0 };
    }
    let fired = 0;
    let deferred = 0;
    let skipped = 0;

    for (const resolved of this.registry.resolved()) {
      if (this.killSwitch.isPaused(resolved.pattern.id)) {
        skipped++;
        continue;
      }
      if (!isDue(resolved.pattern, now)) {
        skipped++;
        continue;
      }
      const fired2 = await this.fire(resolved.pattern, "scheduled");
      if (fired2) fired++;
      else deferred++;
    }
    return { fired, deferred, skipped };
  }

  async fire(loop: LoopPattern, source: "scheduled" | "manual" | "test"): Promise<boolean> {
    const wakeup: WakeupInsert = {
      id: `wake_${randomUUID()}`,
      organizationId: this.opts.organizationId ?? "default",
      loopId: loop.id,
      source: source === "manual" ? "manual" : "timer",
      triggerDetail: source,
      reason: `Loop fired: ${loop.id}`,
      agentId: loop.agent,
      payloadJson: JSON.stringify({ loopId: loop.id, agent: loop.agent }),
      status: "queued",
      idempotencyKey: `loop:${loop.id}:${Date.now()}:${randomUUID().slice(0, 8)}`,
      requestedAt: new Date().toISOString(),
    };
    const db = getDefaultDb();
    try {
      await db.db.insert(wakeupsTable).values(wakeup as never);
      log.info("wakeup enqueued", { id: wakeup.id, loopId: loop.id, source });
      return true;
    } catch (err) {
      log.warn("wakeup enqueue failed", { id: wakeup.id, err: String(err) });
      return false;
    }
  }
}

function isDue(loop: LoopPattern, now: Date): boolean {
  if (loop.schedule.kind === "manual") return false;
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    // Foundation: naive — fire every tick if interval elapsed.
    // Phase 3: track lastFiredAt per loop.
    return true;
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      const it = cronParser.parseExpression(loop.schedule.expression, {
        currentDate: now,
        tz: loop.schedule.timezone ?? "UTC",
      });
      const prev = it.prev().toDate();
      return now.getTime() - prev.getTime() < 60_000;
    } catch {
      return false;
    }
  }
  return false;
}
