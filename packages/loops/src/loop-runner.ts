/**
 * LoopRunner — executes a single `LoopPattern` end-to-end.
 *
 * `discover` → for each work item → `decide` → if `act`, create a wakeup
 * and (optionally) run the session inline → if `report`, append to the
 * loop's run log → if `escalate`, write a kill-switch / audit event.
 *
 * Foundation slice: discovers, decides, runs the session via
 * `@aaspai/sessions`, and writes a run record. Phase 3b moves the
 * wakeup creation to the scheduler (so the loop and scheduler are
 * not on the same process tick).
 */
import { randomUUID } from "node:crypto";
import { getDefaultDb } from "@aaspai/db";
import {
  wakeups,
  auditEvents,
  type WakeupInsert,
  type AuditEventInsert,
} from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import { Sessions } from "@aaspai/sessions";
import type {
  LoopConfigSource,
  LoopPattern,
  WorkItem,
  DecideResult,
} from "@aaspai/contracts/phase2";
import type { ResolvedLoopPattern } from "./pattern.js";
import { eq } from "drizzle-orm";

const log = getLogger("loops.runner");

export interface LoopRunnerOptions {
  organizationId: string;
  loopSource: LoopConfigSource;
  sessions: Sessions;
}

export interface RunOutcome {
  loopId: string;
  runId: string;
  fired: number;
  reported: number;
  escalated: number;
  noops: number;
  durationMs: number;
  items: readonly WorkItem[];
}

export class LoopRunner {
  constructor(private readonly opts: LoopRunnerOptions) {}

  /**
   * Run a single loop once. Loads the pattern from the source, runs
   * discover + decide, then executes any `act` decisions inline.
   */
  async run(resolved: ResolvedLoopPattern): Promise<RunOutcome> {
    const startedAt = Date.now();
    const runId = `run_${randomUUID()}`;
    log.info("loop run start", { loop: resolved.pattern.id, runId });

    const state = await this.snapshotState(resolved.pattern);
    const items = await resolved.discover(state as never, { loopId: resolved.pattern.id, now: new Date() });

    let fired = 0;
    let reported = 0;
    let escalated = 0;
    let noops = 0;
    const decisions: Array<{ item: WorkItem; decide: DecideResult }> = [];

    for (const item of items) {
      const decide = await resolved.decide(item, state as never, { loopId: resolved.pattern.id, now: new Date() });
      decisions.push({ item, decide });
      if (decide.kind === "act") fired++;
      else if (decide.kind === "report") reported++;
      else if (decide.kind === "escalate") escalated++;
      else noops++;
    }

    // Execute any "act" decisions inline (synchronous, foundation).
    // Phase 3b: enqueue wakeups instead and let the scheduler run them.
    for (const { item, decide } of decisions) {
      if (decide.kind !== "act") continue;
      const wakeup = await this.enqueueWakeup(resolved.pattern, item, decide.reason);
      if (wakeup) {
        try {
          await this.opts.sessions.execute({
            organizationId: this.opts.organizationId,
            agentId: resolved.pattern.agent,
            adapter: "dry_run_local",
            runtime: { kind: "local" },
            prompt: this.buildActPrompt(resolved.pattern, item, decide),
            config: {},
            skills: [],
            budget: {},
            idempotencyKey: wakeup.id,
            wakeupId: wakeup.id,
            traceId: runId,
          });
        } catch (err) {
          log.error("act execution failed", { loop: resolved.pattern.id, item, err: String(err) });
        }
      }
    }

    // Audit event for the run
    await this.recordAudit({
      action: "loop.run",
      targetType: "loop",
      targetId: resolved.pattern.id,
      metadata: {
        runId,
        items: items.length,
        fired,
        reported,
        escalated,
        noops,
        durationMs: Date.now() - startedAt,
      },
    });

    const outcome: RunOutcome = {
      loopId: resolved.pattern.id,
      runId,
      fired,
      reported,
      escalated,
      noops,
      durationMs: Date.now() - startedAt,
      items,
    };
    log.info("loop run complete", { ...outcome, items: items.length });
    return outcome;
  }

  /**
   * The "STATE.md view" — what the discover function sees. For
   * foundation, this is a small read of recent sessions + the
   * loop's status. Phase 4 wires the real StateStore.
   */
  private async snapshotState(_loop: LoopPattern): Promise<unknown> {
    return { paused: _loop.pauseReason !== null && _loop.pauseReason !== undefined };
  }

  private async enqueueWakeup(loop: LoopPattern, item: WorkItem, reason: string): Promise<WakeupInsert | null> {
    const wakeup: WakeupInsert = {
      id: `wake_${randomUUID()}`,
      organizationId: this.opts.organizationId,
      loopId: loop.id,
      source: "manual",
      triggerDetail: loop.id,
      reason: `${reason}: ${item.title}`,
      agentId: loop.agent,
      payloadJson: JSON.stringify({ item, loopId: loop.id }),
      status: "queued",
      idempotencyKey: `loop:${loop.id}:${item.ref.id}`,
      requestedAt: new Date().toISOString(),
    };
    try {
      const db = getDefaultDb();
      await db.db.insert(wakeups).values(wakeup as never);
      return wakeup;
    } catch (err) {
      log.warn("wakeup enqueue failed", { err: String(err) });
      return null;
    }
  }

  private buildActPrompt(loop: LoopPattern, item: WorkItem, decide: { reason: string }): string {
    return [
      `Loop: ${loop.id} (${loop.title})`,
      `Action: ${decide.reason}`,
      `Item: ${item.title}`,
      `Reference: ${item.ref.kind}/${item.ref.id}`,
      "",
      "Decide whether to delegate, defer, or escalate. Respond tersely.",
    ].join("\n");
  }

  /**
   * Run a single pattern inline. The discover/decide run in-process
   * (no DB roundtrip); any `act` decisions execute the session in
   * the same call. The result is a structured `RunOutcome` for the
   * audit log + STATE.md.
   */
  /** Make `_loop` (the unused param warning suppressor) cooperate with TS. */
  private readonly __unused: (loop: LoopPattern) => void = (l) => void l;

  private async recordAudit(input: { action: string; targetType: string; targetId: string; metadata: JsonObjectSafe }): Promise<void> {
    const now = new Date().toISOString();
    const audit: AuditEventInsert = {
      id: `evt_${randomUUID()}`,
      organizationId: this.opts.organizationId,
      actorId: "system:loop-runner",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      occurredAt: now,
      recordedAt: now,
      metadataJson: JSON.stringify(input.metadata),
    };
    try {
      const db = getDefaultDb();
      await db.db.insert(auditEvents).values(audit as never);
    } catch (err) {
      log.warn("audit insert failed", { err: String(err) });
    }
  }
}

// We avoid pulling `JsonObject` here to keep this module's surface tight.
type JsonObjectSafe = Record<string, unknown>;

export { eq };
