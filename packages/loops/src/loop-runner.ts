/**
 * Durable loop orchestration.
 *
 * A loop is a control-plane decision maker. It may discover and decide, but
 * it never invokes a harness. Action decisions become governed WorkItems and
 * are executed later by the dependency scheduler.
 */

import type { ExecutionWorkItem, LoopOutput } from "@aaspai/contracts/execution";
import type { ExecutionGovernanceInput } from "@aaspai/contracts/governance";
import type { LoopConfigSource, LoopPattern, WorkItem } from "@aaspai/contracts/phase2";
import type { ExecutionStore } from "@aaspai/execution";
import { getLogger } from "@aaspai/observability";
import type { KillSwitch } from "./kill-switch.js";
import type { DecideResult, ResolvedLoopPattern } from "./pattern.js";

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
    store: ExecutionStore;
    lineage: LoopExecutionLineage;
  };
  killSwitch?: KillSwitch;
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

    const stopped =
      resolved.pattern.status !== "enabled" ||
      (resolved.pattern.pauseReason !== null && resolved.pattern.pauseReason !== undefined) ||
      this.opts.killSwitch?.isPaused(resolved.pattern.id) === true;
    if (stopped) {
      await store.updateWorkflowRunStatus(run.id, "cancelled");
      return emptyOutcome(resolved.pattern, run.id, startedAt, true);
    }

    log.info("loop run start", { loop: resolved.pattern.id, runId: run.id });
    const state = { paused: false, workflowRunId: run.id };
    const items = await resolved.discover(state, { loopId: resolved.pattern.id, now });
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
        if (resolved.pattern.autonomyLevel === "L0" || resolved.pattern.autonomyLevel === "L1") {
          reported++;
          outputs.push(
            await store.createLoopOutput({
              organizationId: this.opts.organizationId,
              loopId: resolved.pattern.id,
              workflowRunId: run.id,
              kind: "report",
              sourceRef: sourceRef(item),
              title: `Report-only action: ${item.title}`,
              body: decision.reason,
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
  }

  private async replayExisting(
    pattern: LoopPattern,
    run: Awaited<ReturnType<ExecutionStore["getWorkflowRun"]>> extends infer T
      ? Exclude<T, null>
      : never,
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
  const limits = [];
  const runs = numberValue(perRun.runs, 0);
  const tokens = numberValue(perRun.tokens, 0);
  const costUsd = numberValue(perRun.costUsd, 0);
  if (runs || tokens || costUsd) limits.push({ scope: "attempt" as const, runs, tokens, costUsd });
  return {
    risk: loop.autonomyLevel === "L3" ? "high" : loop.autonomyLevel === "L2" ? "medium" : "low",
    verification: {
      required: loop.autonomyLevel !== "L0",
      checkerAgentId: loop.agent,
      checkerHarness: "dry_run_local",
      minEvidence: 0,
    },
    approval: { required: loop.autonomyLevel === "L2", actorType: "human" },
    budget: { limits, soft: numberValue(budget.soft, 0.8) },
    policy: gate as ExecutionGovernanceInput["policy"],
  };
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
