import type { AgentAttempt, ExecutionWorkItem, WorkflowRun } from "@aaspai/contracts/execution";
import { assertHarnessExecutable } from "./capabilities.js";
import type { ExecutionStore } from "./store.js";

export interface SchedulerOptions {
  maxOrganizationConcurrency?: number;
  maxProjectConcurrency?: number;
  maxRepositoryConcurrency?: number;
  maxAgentConcurrency?: number;
  retryDelayMs?: number;
}

export interface SchedulerTickInput {
  organizationId: string;
  goalId: string;
  workflowRunId: string;
  agentId: string;
  harness: string;
  maxDispatch?: number;
  now?: Date;
}

export interface ScheduledExecutionContext {
  workItem: ExecutionWorkItem;
  attempt: AgentAttempt;
  workflowRun: WorkflowRun;
}

export type ScheduledExecutionOutcome = Extract<
  AgentAttempt["status"],
  "succeeded" | "failed" | "cancelled" | "timed_out"
>;

export interface SchedulerTickResult {
  dispatched: Array<{ workItem: ExecutionWorkItem; attempt: AgentAttempt; created: boolean }>;
  blocked: Array<{ workItemId: string; reason: string }>;
  progress: Awaited<ReturnType<ExecutionStore["getGoalProgress"]>>;
}

/**
 * Dependency-aware execution scheduler. It owns readiness, bounded dispatch,
 * retry eligibility, and progress projection; provider execution stays behind
 * the callback supplied to run().
 */
export class DependencyScheduler {
  private readonly maxOrganizationConcurrency: number;
  private readonly maxProjectConcurrency: number;
  private readonly maxRepositoryConcurrency: number;
  private readonly maxAgentConcurrency: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: ExecutionStore,
    options: SchedulerOptions = {},
  ) {
    this.maxOrganizationConcurrency = Math.max(1, options.maxOrganizationConcurrency ?? 2);
    this.maxProjectConcurrency = Math.max(1, options.maxProjectConcurrency ?? 1);
    this.maxRepositoryConcurrency = Math.max(1, options.maxRepositoryConcurrency ?? 1);
    this.maxAgentConcurrency = Math.max(1, options.maxAgentConcurrency ?? 1);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  }

  async tick(input: SchedulerTickInput): Promise<SchedulerTickResult> {
    assertHarnessExecutable(input.harness);
    const now = (input.now ?? new Date()).toISOString();
    await this.store.reconcileExpiredLocks(now);
    const items = (await this.store.listWorkItems(input.organizationId, input.goalId)).filter(
      (item) => item.workflowRunId === null || item.workflowRunId === input.workflowRunId,
    );
    const dependencies = new Map<
      string,
      Awaited<ReturnType<ExecutionStore["listWorkItemDependencies"]>>
    >();
    for (const item of items)
      dependencies.set(item.id, await this.store.listWorkItemDependencies(item.id));
    const statuses = new Map(items.map((item) => [item.id, item.status]));
    const blocked: Array<{ workItemId: string; reason: string }> = [];

    for (const item of items) {
      if (isTerminal(item.status) || isActive(item.status) || isGovernancePending(item.status))
        continue;
      if (item.deadlineAt && item.deadlineAt <= now) {
        const reason = `deadline passed at ${item.deadlineAt}`;
        await this.store.updateWorkItemStatus(item.id, "blocked", { blockedReason: reason });
        blocked.push({ workItemId: item.id, reason });
        statuses.set(item.id, "blocked");
        continue;
      }
      const blockers = (dependencies.get(item.id) ?? []).filter((edge) => {
        const status = statuses.get(edge.dependsOnWorkItemId);
        return status === "failed" || status === "cancelled" || status === "blocked";
      });
      if (blockers.length > 0) {
        const reason = `blocked by ${blockers.map((edge) => edge.dependsOnWorkItemId).join(", ")}`;
        if (item.status !== "blocked" || item.blockedReason !== reason) {
          await this.store.updateWorkItemStatus(item.id, "blocked", { blockedReason: reason });
        }
        blocked.push({ workItemId: item.id, reason });
        statuses.set(item.id, "blocked");
        continue;
      }
      const waiting = (dependencies.get(item.id) ?? []).filter(
        (edge) => statuses.get(edge.dependsOnWorkItemId) !== "completed",
      );
      if (waiting.length === 0 && item.status === "proposed") {
        await this.store.updateWorkItemStatus(item.id, "ready");
        statuses.set(item.id, "ready");
      }
    }

    const activeAttempts = await this.listActiveAttempts(items);
    let organizationActive = activeAttempts.length;
    const projectActive = new Map<string, number>();
    const repositoryActive = new Map<string, number>();
    const agentActive = new Map<string, number>();
    for (const active of activeAttempts) {
      const item = items.find((candidate) => candidate.id === active.workItemId);
      if (item) {
        projectActive.set(item.projectId, (projectActive.get(item.projectId) ?? 0) + 1);
        for (const repositoryId of item.repositoryIds ?? [item.repositoryId]) {
          repositoryActive.set(repositoryId, (repositoryActive.get(repositoryId) ?? 0) + 1);
        }
        agentActive.set(active.agentId, (agentActive.get(active.agentId) ?? 0) + 1);
      }
    }

    const dispatched: SchedulerTickResult["dispatched"] = [];
    const limit = Math.max(1, input.maxDispatch ?? items.length);
    for (const item of items) {
      if (dispatched.length >= limit || organizationActive >= this.maxOrganizationConcurrency)
        break;
      const current = await this.store.getWorkItem(item.id);
      if (current?.status !== "ready") continue;
      if (current.retryAfter && current.retryAfter > now) continue;
      const projectCount = projectActive.get(current.projectId) ?? 0;
      if (projectCount >= this.maxProjectConcurrency) continue;
      const repositoryIds = current.repositoryIds ?? [current.repositoryId];
      if (
        repositoryIds.some(
          (repositoryId) =>
            (repositoryActive.get(repositoryId) ?? 0) >= this.maxRepositoryConcurrency,
        )
      )
        continue;
      if ((agentActive.get(input.agentId) ?? 0) >= this.maxAgentConcurrency) continue;
      const result = await this.store.dispatchWorkItem({
        workflowRunId: input.workflowRunId,
        workItemId: current.id,
        agentId: input.agentId,
        harness: input.harness,
        organizationConcurrency: this.maxOrganizationConcurrency,
        projectConcurrency: this.maxProjectConcurrency,
        repositoryConcurrency: this.maxRepositoryConcurrency,
        agentConcurrency: this.maxAgentConcurrency,
      });
      if (!result) continue;
      dispatched.push({ workItem: current, ...result });
      organizationActive++;
      projectActive.set(current.projectId, projectCount + 1);
      for (const repositoryId of repositoryIds) {
        repositoryActive.set(repositoryId, (repositoryActive.get(repositoryId) ?? 0) + 1);
      }
      agentActive.set(input.agentId, (agentActive.get(input.agentId) ?? 0) + 1);
    }

    if (dispatched.length > 0) {
      const workflowRun = await this.store.getWorkflowRun(input.workflowRunId);
      if (workflowRun?.status === "queued") {
        await this.store.updateWorkflowRunStatus(workflowRun.id, "running");
      }
    }

    return {
      dispatched,
      blocked,
      progress: await this.store.getGoalProgress(input.goalId),
    };
  }

  async run(
    input: SchedulerTickInput,
    execute: (context: ScheduledExecutionContext) => Promise<ScheduledExecutionOutcome>,
    options: { maxTicks?: number } = {},
  ): Promise<SchedulerTickResult> {
    const maxTicks = Math.max(1, options.maxTicks ?? 100);
    let latest: SchedulerTickResult = await this.tick(input);
    for (let tick = 0; tick < maxTicks; tick++) {
      if (latest.dispatched.length === 0) {
        await this.finishWorkflowRun(input.workflowRunId, latest.progress);
        return latest;
      }
      for (const dispatched of latest.dispatched) {
        const attempt = await this.store.startScheduledAttempt(dispatched.attempt.id);
        const workflowRun = await this.store.getWorkflowRun(input.workflowRunId);
        if (!workflowRun) throw new Error(`Workflow run ${input.workflowRunId} not found`);
        let outcome: ScheduledExecutionOutcome = "failed";
        let error: string | null = null;
        try {
          outcome = await execute({ workItem: dispatched.workItem, attempt, workflowRun });
        } catch (caught) {
          error = String(caught instanceof Error ? caught.message : caught);
        }
        await this.store.completeScheduledAttempt({
          attemptId: dispatched.attempt.id,
          status: outcome,
          error,
          retryDelayMs: this.retryDelayMs,
        });
      }
      latest = await this.tick(input);
    }
    await this.finishWorkflowRun(input.workflowRunId, latest.progress);
    return latest;
  }

  private async finishWorkflowRun(
    workflowRunId: string,
    progress: SchedulerTickResult["progress"],
  ): Promise<void> {
    if (
      progress.total === 0 ||
      progress.active > 0 ||
      progress.ready > 0 ||
      progress.proposed > 0 ||
      progress.awaitingVerification > 0 ||
      progress.awaitingApproval > 0
    ) {
      return;
    }
    const status = progress.completed === progress.total ? "succeeded" : "failed";
    const run = await this.store.getWorkflowRun(workflowRunId);
    if (run && run.status !== status)
      await this.store.updateWorkflowRunStatus(workflowRunId, status);
  }

  private async listActiveAttempts(items: ExecutionWorkItem[]): Promise<AgentAttempt[]> {
    const attempts: AgentAttempt[] = [];
    for (const item of items) {
      const active = (await this.store.listAttemptsForWorkItem(item.id)).filter((attempt) =>
        isActiveAttempt(attempt.status),
      );
      attempts.push(...active);
    }
    return attempts;
  }
}

function isTerminal(status: ExecutionWorkItem["status"]): boolean {
  return ["completed", "failed", "cancelled", "blocked"].includes(status);
}

function isGovernancePending(status: ExecutionWorkItem["status"]): boolean {
  return status === "awaiting_verification" || status === "awaiting_approval";
}

function isActive(status: ExecutionWorkItem["status"]): boolean {
  return status === "claimed" || status === "in_progress";
}

function isActiveAttempt(status: AgentAttempt["status"]): boolean {
  return ["queued", "preparing", "running", "cancelling"].includes(status);
}
