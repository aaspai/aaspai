/**
 * Scheduler — the part that fires triggers and creates wakeups.
 *
 * Foundation slice: single-process, no leader election. Multi-replica
 * lands in Phase 4 (adds a `worker_leader_lease` table + the same
 * `INSERT ... ON CONFLICT DO UPDATE WHERE ...` pattern as suna).
 */

import { randomUUID } from "node:crypto";
import type { LoopPattern } from "@aaspai/contracts/phase2";
import { and, desc, eq, getDefaultDb, inArray, type SqliteDb, workflowRuns } from "@aaspai/db";
import { type WakeupInsert, wakeups as wakeupsTable } from "@aaspai/db/schema/phase2";
import { getLogger } from "@aaspai/observability";
import cronParser from "cron-parser";
import { LoopControlStore } from "./control.js";
import type { KillSwitch } from "./kill-switch.js";
import type { PatternRegistry, ResolvedLoopPattern } from "./pattern.js";

const log = getLogger("loops.scheduler");

export interface TickResult {
  fired: number;
  deferred: number;
  skipped: number;
}

export interface DueLoopOccurrence {
  resolved: ResolvedLoopPattern;
  key: string;
  scheduledAt: Date;
}

export class Scheduler {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly registry: PatternRegistry,
    private readonly killSwitch: KillSwitch,
    private readonly opts: {
      tickIntervalMs?: number;
      organizationId?: string;
      db?: SqliteDb;
      controlStore?: Pick<LoopControlStore, "isPaused">;
    } = {},
  ) {
    this.db = opts.db ?? getDefaultDb().db;
    this.controlStore = opts.controlStore ?? new LoopControlStore(this.db);
  }

  private readonly db: SqliteDb;
  private readonly controlStore: Pick<LoopControlStore, "isPaused">;

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

    const occurrences = await this.dueOccurrences(now);
    const dueIds = new Set(occurrences.map(({ resolved }) => resolved.pattern.id));
    skipped = this.registry
      .resolved()
      .filter((resolved) => !dueIds.has(resolved.pattern.id)).length;
    for (const occurrence of occurrences) {
      const didFire = await this.fire(
        occurrence.resolved.pattern,
        "scheduled",
        occurrence.scheduledAt,
      );
      if (didFire) fired++;
      else deferred++;
    }
    return { fired, deferred, skipped };
  }

  /** Returns due patterns for durable orchestration callers. */
  due(now: Date): readonly ResolvedLoopPattern[] {
    if (this.killSwitch.isGlobalPaused()) return [];
    return this.registry
      .resolved()
      .filter((resolved) => !this.killSwitch.isPaused(resolved.pattern.id))
      .filter((resolved) => isDue(resolved.pattern, now, this.opts.tickIntervalMs));
  }

  /** Durable pause and catch-up aware occurrences for worker orchestration. */
  async dueOccurrences(now: Date): Promise<readonly DueLoopOccurrence[]> {
    if (this.killSwitch.isGlobalPaused()) return [];
    const organizationId = this.opts.organizationId ?? "default";
    const due: DueLoopOccurrence[] = [];
    for (const resolved of this.registry.resolved()) {
      if (
        this.killSwitch.isPaused(resolved.pattern.id) ||
        (await this.controlStore.isPaused(organizationId, resolved.pattern.id))
      ) {
        continue;
      }
      const [lastRun, lastWakeup, activeRun] = await Promise.all([
        this.db
          .select({
            createdAt: workflowRuns.createdAt,
            idempotencyKey: workflowRuns.idempotencyKey,
          })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.organizationId, organizationId),
              eq(workflowRuns.sourceType, "loop"),
              eq(workflowRuns.sourceId, resolved.pattern.id),
            ),
          )
          .orderBy(desc(workflowRuns.createdAt))
          .limit(1),
        this.db
          .select({
            createdAt: wakeupsTable.requestedAt,
            idempotencyKey: wakeupsTable.idempotencyKey,
          })
          .from(wakeupsTable)
          .where(
            and(
              eq(wakeupsTable.organizationId, organizationId),
              eq(wakeupsTable.loopId, resolved.pattern.id),
            ),
          )
          .orderBy(desc(wakeupsTable.requestedAt))
          .limit(1),
        resolved.pattern.concurrencyPolicy === "always_enqueue"
          ? Promise.resolve([])
          : this.db
              .select({ id: workflowRuns.id })
              .from(workflowRuns)
              .where(
                and(
                  eq(workflowRuns.organizationId, organizationId),
                  eq(workflowRuns.sourceType, "loop"),
                  eq(workflowRuns.sourceId, resolved.pattern.id),
                  inArray(workflowRuns.status, ["queued", "running"]),
                ),
              )
              .limit(1),
      ]);
      if (activeRun[0]) continue;
      const last = [lastRun[0], lastWakeup[0]]
        .filter((row): row is { createdAt: string; idempotencyKey: string } => Boolean(row))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      for (const scheduledAt of scheduledOccurrences(
        resolved.pattern,
        now,
        last ? lastOccurrenceAt(resolved.pattern, last) : null,
        this.opts.tickIntervalMs,
      )) {
        due.push({
          resolved,
          key: occurrenceKey(resolved.pattern, scheduledAt),
          scheduledAt,
        });
      }
    }
    return due;
  }

  async fire(
    loop: LoopPattern,
    source: "scheduled" | "manual" | "test",
    now = new Date(),
  ): Promise<boolean> {
    const organizationId = this.opts.organizationId ?? "default";
    const idempotencyKey = `loop:${organizationId}:${loop.id}:${occurrenceKey(loop, now)}:${loop.catchUpPolicy}`;
    const db = getDefaultDb();
    const active = await db.db
      .select({ id: wakeupsTable.id })
      .from(wakeupsTable)
      .where(
        and(
          eq(wakeupsTable.organizationId, organizationId),
          eq(wakeupsTable.loopId, loop.id),
          inArray(wakeupsTable.status, ["queued", "claimed"]),
        ),
      )
      .limit(1);
    if (active[0] && loop.concurrencyPolicy !== "always_enqueue") return false;
    const wakeup: WakeupInsert = {
      id: `wake_${randomUUID()}`,
      organizationId,
      loopId: loop.id,
      source: source === "manual" ? "manual" : "timer",
      triggerDetail: source,
      reason: `Loop fired: ${loop.id}`,
      agentId: loop.agent,
      payloadJson: JSON.stringify({ loopId: loop.id, agent: loop.agent }),
      status: "queued",
      idempotencyKey,
      requestedAt: now.toISOString(),
    };
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

export function isDue(loop: LoopPattern, now: Date, tickIntervalMs = 60_000): boolean {
  if (loop.schedule.kind === "manual") return false;
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    // Fire only when this tick crosses an interval boundary. Durable occurrence
    // keys below prevent duplicate execution and support bounded catch-up.
    return now.getTime() % (loop.schedule.seconds * 1_000) < tickIntervalMs;
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      const it = cronParser.parseExpression(loop.schedule.expression, {
        currentDate: now,
        tz: loop.schedule.timezone ?? "UTC",
      });
      const prev = it.prev().toDate();
      return now.getTime() - prev.getTime() < tickIntervalMs;
    } catch {
      return false;
    }
  }
  return false;
}

function occurrenceKey(loop: LoopPattern, now: Date): string {
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    return `interval:${Math.floor(now.getTime() / (loop.schedule.seconds * 1_000))}`;
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      const it = cronParser.parseExpression(loop.schedule.expression, {
        currentDate: now,
        tz: loop.schedule.timezone ?? "UTC",
      });
      return `cron:${it.prev().toISOString()}`;
    } catch {
      return `invalid:${now.toISOString().slice(0, 16)}`;
    }
  }
  return `${loop.schedule.kind}:${now.toISOString().slice(0, 16)}`;
}

export function scheduledOccurrences(
  loop: LoopPattern,
  now: Date,
  lastRunAt: Date | null,
  tickIntervalMs = 60_000,
): readonly Date[] {
  if (loop.schedule.kind === "manual") return [];
  if (loop.catchUpPolicy === "skip_missed" || !lastRunAt) {
    return isDue(loop, now, tickIntervalMs) ? [occurrenceDate(loop, now)] : [];
  }

  const cap = catchUpCap(loop);
  const result: Date[] = [];
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    const intervalMs = loop.schedule.seconds * 1_000;
    let next = (Math.floor(lastRunAt.getTime() / intervalMs) + 1) * intervalMs;
    while (next <= now.getTime() && result.length < cap) {
      result.push(new Date(next));
      next += intervalMs;
    }
    return result;
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      const iterator = cronParser.parseExpression(loop.schedule.expression, {
        currentDate: lastRunAt,
        endDate: now,
        tz: loop.schedule.timezone ?? "UTC",
      });
      while (result.length < cap) {
        try {
          result.push(iterator.next().toDate());
        } catch {
          break;
        }
      }
    } catch {
      return [];
    }
  }
  return result;
}

/** Next automatic occurrence after a completed recurring process cycle. */
export function nextScheduledOccurrence(loop: Pick<LoopPattern, "schedule">, after: Date): Date | null {
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    return new Date(after.getTime() + loop.schedule.seconds * 1_000);
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      return cronParser
        .parseExpression(loop.schedule.expression, {
          currentDate: after,
          tz: loop.schedule.timezone ?? "UTC",
        })
        .next()
        .toDate();
    } catch {
      return null;
    }
  }
  return null;
}

function occurrenceDate(loop: LoopPattern, now: Date): Date {
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    const intervalMs = loop.schedule.seconds * 1_000;
    return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
  }
  if (loop.schedule.kind === "cron" && loop.schedule.expression) {
    try {
      return cronParser
        .parseExpression(loop.schedule.expression, {
          currentDate: now,
          tz: loop.schedule.timezone ?? "UTC",
        })
        .prev()
        .toDate();
    } catch {
      return now;
    }
  }
  return now;
}

function catchUpCap(loop: LoopPattern): number {
  try {
    const value = (JSON.parse(loop.configJson) as Record<string, unknown>).catchUpCap;
    return typeof value === "number" && Number.isInteger(value)
      ? Math.min(100, Math.max(1, value))
      : 5;
  } catch {
    return 5;
  }
}

function lastOccurrenceAt(
  loop: LoopPattern,
  run: { createdAt: string; idempotencyKey: string },
): Date {
  if (loop.schedule.kind === "interval" && loop.schedule.seconds) {
    const match = /:interval:(\d+)(?::|$)/.exec(run.idempotencyKey);
    if (match?.[1]) return new Date(Number(match[1]) * loop.schedule.seconds * 1_000);
  }
  if (loop.schedule.kind === "cron") {
    const match = /:cron:(.+?)(?::(?:skip_missed|enqueue_missed_with_cap)|$)/.exec(
      run.idempotencyKey,
    );
    if (match?.[1]) {
      const parsed = new Date(match[1]);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return new Date(run.createdAt);
}
