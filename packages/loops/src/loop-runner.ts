/**
 * Durable loop orchestration.
 *
 * A loop is a control-plane decision maker. It may discover and decide, but
 * it never invokes a harness. Action decisions become governed WorkItems and
 * are executed later by the dependency scheduler.
 */

import type { ExecutionWorkItem, LoopOutput, WorkflowRun } from "@aaspai/contracts/execution";
import type { ExecutionGovernanceInput } from "@aaspai/contracts/governance";
import type { LoopConfigSource, LoopPattern, WorkItem } from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";
import type { LoopControlStore } from "./control.js";
import type { KillSwitch } from "./kill-switch.js";
import type { DecideResult, ResolvedLoopPattern } from "./pattern.js";
import type { StateStore } from "./state.js";

const log = getLogger("loops.runner");

export interface LoopExecutionLineage {
  goalId: string;
  projectId: string;
  repositoryId: string;
  definitionRevisionId: string;
}

export interface LoopRunnerOptions {
  organizationId: string;
  /** Kept as a compatibility seam for file-backed loop sources. */
  loopSource?: LoopConfigSource;
  execution: {
    store: LoopPersistence;
    lineage: LoopExecutionLineage;
  };
  killSwitch?: KillSwitch;
  controlStore?: Pick<LoopControlStore, "isPaused" | "setPaused">;
  stateStore?: Pick<StateStore, "view">;
}

/** Application-owned persistence port. Loop decisions do not depend on a DB or runner package. */
export interface LoopPersistence {
  getWorkflowRunByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowRun | null>;
  createWorkflowRun(input: {
    organizationId: string;
    goalId: string;
    definitionRevisionId: string;
    sourceType?: string | null;
    sourceId?: string | null;
    idempotencyKey: string;
  }): Promise<WorkflowRun>;
  updateWorkflowRunStatus(runId: string, status: WorkflowRun["status"]): Promise<WorkflowRun>;
  createLoopOutput(input: {
    organizationId: string;
    loopId: string;
    workflowRunId: string;
    kind: LoopOutput["kind"];
    sourceRef: string;
    title: string;
    body: string;
    severity?: LoopOutput["severity"];
    workItemId?: string | null;
  }): Promise<LoopOutput>;
  createWorkItem(input: {
    organizationId: string;
    goalId: string;
    projectId: string;
    repositoryId: string;
    workflowRunId: string;
    definitionRevisionId: string;
    title: string;
    description: string;
    branchName: string | null;
    sourceCommitSha: string | null;
    priority: number;
    deadlineAt: string | null;
    maxAttempts: number;
    idempotencyKey: string;
    metadata: Record<string, unknown>;
    governance: ExecutionGovernanceInput;
  }): Promise<Pick<ExecutionWorkItem, "id">>;
  getWorkItem(id: string): Promise<ExecutionWorkItem | null>;
  listWorkItems(organizationId: string): Promise<ExecutionWorkItem[]>;
  listLoopOutputs(organizationId: string, loopId?: string): Promise<LoopOutput[]>;
}

export interface RunOptions {
  /** Stable trigger identity. Reusing it coalesces duplicate active triggers. */
  triggerKey?: string;
  now?: Date;
}

export interface RunOutcome {
  loopId: string;
  runId: string;
  fired: number;
  reported: number;
  escalated: number;
  noops: number;
  durationMs: number;
  stopped: boolean;
  items: readonly WorkItem[];
  workItems: readonly ExecutionWorkItem[];
  outputs: readonly LoopOutput[];
}

export class LoopRunner {
  constructor(private readonly opts: LoopRunnerOptions) {}

  async run(resolved: ResolvedLoopPattern, options: RunOptions = {}): Promise<RunOutcome> {
    const startedAt = Date.now();
    const now = options.now ?? new Date();
    const triggerKey = options.triggerKey ?? now.toISOString();
    const { store, lineage } = this.opts.execution;
    const idempotencyKey = `loop:${resolved.pattern.id}:${triggerKey}`;
    const existing = await store.getWorkflowRunByIdempotency(
      this.opts.organizationId,
      idempotencyKey,
    );
    if (existing) return this.replayExisting(resolved.pattern, existing, startedAt);
    const run = await store.createWorkflowRun({
      organizationId: this.opts.organizationId,
      goalId: lineage.goalId,
      definitionRevisionId: lineage.definitionRevisionId,
      sourceType: "loop",
      sourceId: resolved.pattern.id,
      idempotencyKey,
    });

    const durablyPaused =
      (await this.opts.controlStore?.isPaused(this.opts.organizationId, resolved.pattern.id)) ===
      true;
    const stopped =
      resolved.pattern.status !== "enabled" ||
      (resolved.pattern.pauseReason !== null && resolved.pattern.pauseReason !== undefined) ||
      durablyPaused ||
      this.opts.killSwitch?.isPaused(resolved.pattern.id) === true;
    if (stopped) {
      await store.updateWorkflowRunStatus(run.id, "cancelled");
      return emptyOutcome(resolved.pattern, run.id, startedAt, true);
    }

    try {
      log.info("loop run start", { loop: resolved.pattern.id, runId: run.id });
      const state = {
        ...((await this.opts.stateStore?.view(resolved.pattern.id, {
          organizationId: this.opts.organizationId,
        })) ?? {
          loopId: resolved.pattern.id,
          paused: false,
          recentRuns: [],
          budgetToday: { tokens: 0, costUsd: 0, runs: 0 },
        }),
        workflowRunId: run.id,
      };
      const budgetMode = dailyBudgetMode(resolved.pattern, state);
      if (budgetMode === "kill_switch") {
        await this.opts.controlStore?.setPaused(
          this.opts.organizationId,
          resolved.pattern,
          true,
          "daily budget hard threshold reached",
        );
      }
      const items = await resolved.discover(state, {
        loopId: resolved.pattern.id,
        organizationId: this.opts.organizationId,
        now,
      });
      let fired = 0;
      let reported = 0;
      let escalated = 0;
      let noops = 0;
      const workItems: ExecutionWorkItem[] = [];
      const outputs: LoopOutput[] = [];

      for (const item of items) {
        const decision = await resolved.decide(item, state, { loopId: resolved.pattern.id, now });
        if (decision.kind === "act") {
          fired++;
          if (
            resolved.pattern.autonomyLevel === "L0" ||
            resolved.pattern.autonomyLevel === "L1" ||
            budgetMode !== "ok"
          ) {
            reported++;
            outputs.push(
              await store.createLoopOutput({
                organizationId: this.opts.organizationId,
                loopId: resolved.pattern.id,
                workflowRunId: run.id,
                kind: "report",
                sourceRef: sourceRef(item),
                title: `Report-only action: ${item.title}`,
                body:
                  budgetMode === "ok"
                    ? decision.reason
                    : `${decision.reason}\n\nBudget mode: ${budgetMode}; action suppressed.`,
              }),
            );
            continue;
          }
          const createdWorkItem = await store.createWorkItem({
            organizationId: this.opts.organizationId,
            goalId: lineage.goalId,
            projectId: lineage.projectId,
            repositoryId: lineage.repositoryId,
            workflowRunId: run.id,
            definitionRevisionId: lineage.definitionRevisionId,
            title: item.title,
            description: item.description ?? decision.reason,
            branchName: stringValue(item.data?.branchName),
            sourceCommitSha: validSha(item.data?.sourceCommitSha),
            priority: numberValue(item.data?.priority, 0),
            deadlineAt: stringValue(item.data?.deadlineAt),
            maxAttempts: boundedAttempts(item.data?.maxAttempts),
            idempotencyKey: `loop:${resolved.pattern.id}:${triggerKey}:${sourceRef(item)}`,
            metadata: {
              loopId: resolved.pattern.id,
              workflowRunId: run.id,
              sourceRef: item.ref,
              decision: decision.reason,
              payload: item.data ?? {},
              timeoutMs: numberValue(item.data?.timeoutMs, 0) || undefined,
              budgetEstimate: perRunBudget(resolved.pattern),
            },
            governance: governanceFor(resolved.pattern),
          });
          const workItem = await store.getWorkItem(createdWorkItem.id);
          if (!workItem) throw new Error(`Loop WorkItem ${createdWorkItem.id} disappeared`);
          workItems.push(workItem);
          continue;
        }

        if (decision.kind === "report") {
          reported++;
          outputs.push(
            await store.createLoopOutput({
              organizationId: this.opts.organizationId,
              loopId: resolved.pattern.id,
              workflowRunId: run.id,
              kind: "report",
              sourceRef: sourceRef(item),
              title: decision.payload.title,
              body: decision.payload.body,
            }),
          );
        } else if (decision.kind === "escalate") {
          escalated++;
          outputs.push(
            await store.createLoopOutput({
              organizationId: this.opts.organizationId,
              loopId: resolved.pattern.id,
              workflowRunId: run.id,
              kind: "escalation",
              sourceRef: sourceRef(item),
              title: `Escalation: ${item.title}`,
              body: decision.reason,
              severity: decision.severity,
            }),
          );
        } else {
          noops++;
        }
      }

      if (workItems.length === 0) await store.updateWorkflowRunStatus(run.id, "succeeded");
      const outcome: RunOutcome = {
        loopId: resolved.pattern.id,
        runId: run.id,
        fired,
        reported,
        escalated,
        noops,
        durationMs: Date.now() - startedAt,
        stopped: false,
        items,
        workItems,
        outputs,
      };
      log.info("loop run complete", { ...outcome, items: items.length });
      return outcome;
    } catch (error) {
      await store.updateWorkflowRunStatus(run.id, "failed");
      throw error;
    }
  }

  private async replayExisting(
    pattern: LoopPattern,
    run: WorkflowRun,
    startedAt: number,
  ): Promise<RunOutcome> {
    const workItems = (
      await this.opts.execution.store.listWorkItems(this.opts.organizationId)
    ).filter((item) => item.workflowRunId === run.id);
    const outputs = (
      await this.opts.execution.store.listLoopOutputs(this.opts.organizationId, pattern.id)
    ).filter((output) => output.workflowRunId === run.id);
    return {
      loopId: pattern.id,
      runId: run.id,
      fired: workItems.length,
      reported: outputs.filter((output) => output.kind === "report").length,
      escalated: outputs.filter((output) => output.kind === "escalation").length,
      noops: 0,
      durationMs: Math.max(0, Date.now() - startedAt),
      stopped: run.status === "cancelled",
      items: [],
      workItems,
      outputs,
    };
  }
}

function emptyOutcome(
  pattern: LoopPattern,
  runId: string,
  startedAt: number,
  stopped: boolean,
): RunOutcome {
  return {
    loopId: pattern.id,
    runId,
    fired: 0,
    reported: 0,
    escalated: 0,
    noops: 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    stopped,
    items: [],
    workItems: [],
    outputs: [],
  };
}

function sourceRef(item: WorkItem): string {
  return `${item.ref.kind}:${item.ref.id}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function validSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value : null;
}

function boundedAttempts(value: unknown): number {
  return Math.min(5, Math.max(1, Math.floor(numberValue(value, 1))));
}

function governanceFor(loop: LoopPattern): ExecutionGovernanceInput {
  const gate = parseObject(loop.gateJson);
  const budget = parseObject(loop.budgetJson);
  const perRun = objectValue(budget.perRun);
  const perDay = objectValue(budget.perDay);
  const limits = [];
  const runs = numberValue(perRun.runs, 0);
  const tokens = numberValue(perRun.tokens, 0);
  const costUsd = numberValue(perRun.costUsd, 0);
  if (runs || tokens || costUsd) limits.push({ scope: "attempt" as const, runs, tokens, costUsd });
  const dailyRuns = numberValue(perDay.runs, 0);
  const dailyTokens = numberValue(perDay.tokens, 0);
  const dailyCostUsd = numberValue(perDay.costUsd, 0);
  if (dailyRuns || dailyTokens || dailyCostUsd) {
    limits.push({
      scope: "loop" as const,
      runs: dailyRuns,
      tokens: dailyTokens,
      costUsd: dailyCostUsd,
    });
  }
  return {
    risk: loop.autonomyLevel === "L3" ? "high" : loop.autonomyLevel === "L2" ? "medium" : "low",
    verification: {
      required: loop.autonomyLevel !== "L0",
      checkerAgentId: "agent/tester",
      checkerHarness: null,
      minEvidence: 0,
    },
    approval: { required: loop.autonomyLevel === "L2", actorType: "human" },
    budget: { limits, soft: numberValue(budget.soft, 0.8) },
    policy: gate as ExecutionGovernanceInput["policy"],
  };
}

function perRunBudget(loop: LoopPattern): { tokens: number; costUsd: number } {
  const perRun = objectValue(parseObject(loop.budgetJson).perRun);
  return {
    tokens: numberValue(perRun.tokens, 0),
    costUsd: numberValue(perRun.costUsd, 0),
  };
}

function dailyBudgetMode(
  loop: LoopPattern,
  state: { budgetToday?: { tokens: number; costUsd: number; runs: number } },
): "ok" | "report_only" | "kill_switch" {
  const budget = parseObject(loop.budgetJson);
  const perDay = objectValue(budget.perDay);
  const usage = state.budgetToday ?? { tokens: 0, costUsd: 0, runs: 0 };
  const ratios = [
    ratio(usage.tokens, numberValue(perDay.tokens, 0)),
    ratio(usage.costUsd, numberValue(perDay.costUsd, 0)),
    ratio(usage.runs, numberValue(perDay.runs, 0)),
  ];
  const consumed = Math.max(...ratios);
  if (consumed >= numberValue(budget.hard, 1)) return "kill_switch";
  if (consumed >= numberValue(budget.soft, 0.8)) return "report_only";
  return "ok";
}

function ratio(used: number, cap: number): number {
  return cap > 0 ? used / cap : 0;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type { DecideResult };
