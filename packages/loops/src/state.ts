import type { WorkItemRef } from "@aaspai/contracts/phase2";
import {
  agentAttempts,
  and,
  desc,
  eq,
  executionApprovals,
  executionBudgetReservations,
  executionWorkItems,
  getDefaultDb,
  gte,
  inArray,
  loopControls,
  type SqliteDb,
  wakeups,
  workflowRuns,
} from "@aaspai/db";

export interface LoopStateView {
  loopId: string;
  highPriority: WorkItemRef[];
  watch: WorkItemRef[];
  noise: WorkItemRef[];
  workItems: Array<{ id: string; status: string; title: string; updatedAt: string }>;
  attempts: Array<{ id: string; workItemId: string; status: string; role: string }>;
  humanOverrides: Array<{ id: string; workItemId: string; status: string; reason: string }>;
  budgetToday?: { tokens: number; costUsd: number; runs: number };
  lastRun?: {
    at: string;
    outcome: "succeeded" | "failed" | "cancelled" | "escalated" | "noop";
    summary: string;
  };
  recentRuns: Array<{ at: string; outcome: string; summary: string }>;
  paused: boolean;
}

export class StateStore {
  constructor(private readonly db: SqliteDb = getDefaultDb().db) {}

  async view(
    loopId: string,
    opts: { organizationId?: string; recentDays?: number; limit?: number } = {},
  ): Promise<LoopStateView> {
    const organizationId = opts.organizationId ?? "default";
    const limit = opts.limit ?? 50;
    const cutoff = new Date(
      Date.now() - (opts.recentDays ?? 30) * 24 * 60 * 60 * 1000,
    ).toISOString();

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [recentWakeups, runs, control, budgetRows] = await Promise.all([
      this.db
        .select()
        .from(wakeups)
        .where(and(eq(wakeups.organizationId, organizationId), eq(wakeups.loopId, loopId)))
        .orderBy(desc(wakeups.requestedAt))
        .limit(limit),
      this.db
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.sourceType, "loop"),
            eq(workflowRuns.sourceId, loopId),
          ),
        )
        .orderBy(desc(workflowRuns.createdAt))
        .limit(limit),
      this.db
        .select({ paused: loopControls.paused })
        .from(loopControls)
        .where(
          and(eq(loopControls.organizationId, organizationId), eq(loopControls.loopId, loopId)),
        )
        .limit(1),
      this.db
        .select()
        .from(executionBudgetReservations)
        .where(
          and(
            eq(executionBudgetReservations.organizationId, organizationId),
            eq(executionBudgetReservations.scope, "loop"),
            eq(executionBudgetReservations.scopeId, loopId),
            gte(executionBudgetReservations.createdAt, dayStart.toISOString()),
          ),
        ),
    ]);

    const runIds = runs.map((run) => run.id);
    const workRows = runIds.length
      ? await this.db
          .select()
          .from(executionWorkItems)
          .where(
            and(
              eq(executionWorkItems.organizationId, organizationId),
              inArray(executionWorkItems.workflowRunId, runIds),
            ),
          )
          .orderBy(desc(executionWorkItems.updatedAt))
          .limit(limit)
      : [];
    const workIds = workRows.map((item) => item.id);
    const [attemptRows, approvalRows] = workIds.length
      ? await Promise.all([
          this.db
            .select()
            .from(agentAttempts)
            .where(
              and(
                eq(agentAttempts.organizationId, organizationId),
                inArray(agentAttempts.workItemId, workIds),
              ),
            )
            .orderBy(desc(agentAttempts.createdAt))
            .limit(limit),
          this.db
            .select()
            .from(executionApprovals)
            .where(
              and(
                eq(executionApprovals.organizationId, organizationId),
                inArray(executionApprovals.workItemId, workIds),
              ),
            )
            .orderBy(desc(executionApprovals.requestedAt))
            .limit(limit),
        ])
      : [[], []];

    const highPriority: WorkItemRef[] = [];
    const watch: WorkItemRef[] = [];
    const noise: WorkItemRef[] = [];
    for (const wakeup of recentWakeups) {
      const ref = {
        kind: "wakeup",
        id: wakeup.id,
        ...(wakeup.reason || wakeup.triggerDetail
          ? { title: wakeup.reason ?? wakeup.triggerDetail ?? undefined }
          : {}),
      };
      if (wakeup.status === "failed") highPriority.push(ref);
      else if (wakeup.status === "completed") watch.push(ref);
      else noise.push(ref);
    }
    for (const item of workRows) {
      const ref = { kind: "work_item", id: item.id, title: item.title };
      if (["failed", "blocked", "awaiting_approval"].includes(item.status)) highPriority.push(ref);
      else if (["completed", "verified", "approved"].includes(item.status)) watch.push(ref);
      else noise.push(ref);
    }

    const recentRuns = runs
      .filter((run) => run.createdAt >= cutoff)
      .map((run) => ({
        at: run.finishedAt ?? run.startedAt ?? run.createdAt,
        outcome: run.status,
        summary: `${workRows.filter((item) => item.workflowRunId === run.id).length} work items`,
      }));
    const latest = recentRuns[0];

    return {
      loopId,
      highPriority,
      watch,
      noise,
      workItems: workRows.map((item) => ({
        id: item.id,
        status: item.status,
        title: item.title,
        updatedAt: item.updatedAt,
      })),
      attempts: attemptRows.map((attempt) => ({
        id: attempt.id,
        workItemId: attempt.workItemId,
        status: attempt.status,
        role: attempt.role,
      })),
      humanOverrides: approvalRows.map((approval) => ({
        id: approval.id,
        workItemId: approval.workItemId,
        status: approval.status,
        reason: approval.reason,
      })),
      budgetToday: {
        tokens: budgetRows.reduce(
          (sum, row) => sum + (row.status === "reserved" ? row.reservedTokens : row.actualTokens),
          0,
        ),
        costUsd: budgetRows.reduce(
          (sum, row) => sum + (row.status === "reserved" ? row.reservedCostUsd : row.actualCostUsd),
          0,
        ),
        runs: budgetRows
          .filter((row) => row.status === "reserved" || row.status === "settled")
          .reduce((sum, row) => sum + row.reservedRuns, 0),
      },
      ...(latest
        ? {
            lastRun: {
              at: latest.at,
              outcome: normalizeOutcome(latest.outcome),
              summary: latest.summary,
            },
          }
        : {}),
      recentRuns,
      paused: control[0]?.paused === true,
    };
  }
}

function normalizeOutcome(
  status: string,
): "succeeded" | "failed" | "cancelled" | "escalated" | "noop" {
  if (["succeeded", "failed", "cancelled", "escalated", "noop"].includes(status)) {
    return status as "succeeded" | "failed" | "cancelled" | "escalated" | "noop";
  }
  return status === "completed" ? "succeeded" : "noop";
}
