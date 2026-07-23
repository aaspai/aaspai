import { randomUUID } from "node:crypto";
import type {
  AgentAttempt,
  Artifact,
  AttemptStatus,
  ExecutionEvent,
  ExecutionWorkItem,
  ExecutionWorkItemDependency,
  ExecutionWorkspace,
  Goal,
  Project,
  Repository,
  ResourceLock,
  SourceSnapshot,
  WorkflowRun,
} from "@aaspai/contracts/execution";
import {
  agentAttemptSchema,
  assertValidAttemptTransition,
  executionEventSchema,
  executionPlanSchema,
  executionWorkItemDependencySchema,
  executionWorkItemSchema,
  executionWorkspaceSchema,
  goalSchema,
  resourceLockSchema,
  workflowRunSchema,
} from "@aaspai/contracts/execution";
import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import {
  agentAttempts,
  and,
  artifacts,
  asc,
  definitionRevisions,
  desc,
  eq,
  executionEvents,
  executionPlans,
  executionWorkItemDependencies,
  executionWorkItems,
  executionWorkspaces,
  goals,
  sessionEvents as harnessSessionEvents,
  sessions as harnessSessions,
  inArray,
  isNull,
  lte,
  projects,
  repositories,
  resourceLocks,
  type SqliteDb,
  workflowRuns,
} from "@aaspai/db";

export interface CreateGoalInput {
  id?: string;
  organizationId: string;
  title: string;
  description?: string;
  status?: Goal["status"];
}

export interface CreateProjectInput {
  id?: string;
  organizationId: string;
  goalId: string;
  title: string;
  description?: string;
  status?: Project["status"];
}

export interface CreateRepositoryInput {
  id?: string;
  organizationId: string;
  projectId?: string | null;
  purpose: Repository["purpose"];
  provider: Repository["provider"];
  localPath: string;
  remoteUrl?: string | null;
  defaultBranch?: string;
}

export interface CreateDefinitionRevisionInput {
  id?: string;
  organizationId: string;
  repositoryId: string;
  commitSha: string;
  sourcePath: string;
  dirty?: boolean;
  contentHash: string;
}

export interface CreateWorkItemInput {
  id?: string;
  organizationId: string;
  goalId: string;
  projectId: string;
  repositoryId: string;
  title: string;
  description?: string;
  definitionRevisionId?: string | null;
  sourceCommitSha?: string | null;
  branchName?: string | null;
  priority?: number;
  deadlineAt?: string | null;
  maxAttempts?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  status?: ExecutionWorkItem["status"];
}

export interface DispatchWorkItemInput {
  workflowRunId: string;
  workItemId: string;
  agentId: string;
  harness: string;
  timeoutMs?: number | null;
  organizationConcurrency?: number;
  projectConcurrency?: number;
}

export interface CreateWorkflowRunInput {
  id?: string;
  organizationId: string;
  goalId: string;
  definitionRevisionId: string;
  idempotencyKey: string;
  status?: WorkflowRun["status"];
}

export interface CreateAttemptInput {
  id?: string;
  organizationId: string;
  workflowRunId: string;
  workItemId: string;
  agentId: string;
  harness: string;
  attemptNumber?: number;
  timeoutMs?: number | null;
  status?: AgentAttempt["status"];
}

export interface CreateHarnessSessionInput {
  id?: string;
  organizationId: string;
  agentId: string;
  adapter: string;
  prompt: string;
  runtime?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface CreateWorkspaceInput {
  id?: string;
  organizationId: string;
  attemptId: string;
  repositoryId: string;
  path: string;
  branchName: string;
  baseCommitSha: string;
  status?: ExecutionWorkspace["status"];
}

export interface CreatePlanInput {
  id?: string;
  organizationId: string;
  definitionRevisionId: string;
  workItemId: string;
  attemptId: string;
  sourceSnapshot: SourceSnapshot;
  target: ExecutionTarget;
  harness: string;
  prompt: string;
  timeoutMs?: number | null;
  runtimeConfig?: Record<string, unknown>;
}

export interface AppendEventInput {
  organizationId: string;
  attemptId: string;
  type: string;
  payload: Record<string, unknown>;
  seq: number;
  ts?: string;
}

export interface CreateArtifactInput extends Omit<Artifact, "id" | "createdAt"> {
  id?: string;
  createdAt?: string;
}

export interface AcquireResourceLockInput {
  id?: string;
  organizationId: string;
  resourceType: ResourceLock["resourceType"];
  resourceId: string;
  ownerAttemptId: string;
  leaseExpiresAt: string;
}

export class ExecutionStore {
  constructor(private readonly db: SqliteDb) {}

  async createGoal(input: CreateGoalInput) {
    const row = {
      id: input.id ?? makeId("goal"),
      organizationId: input.organizationId,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "planned",
      createdAt: now(),
      updatedAt: now(),
    } satisfies typeof goals.$inferInsert;
    await this.db.insert(goals).values(row);
    return row;
  }

  async createProject(input: CreateProjectInput) {
    const row = {
      id: input.id ?? makeId("project"),
      organizationId: input.organizationId,
      goalId: input.goalId,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "active",
      createdAt: now(),
      updatedAt: now(),
    } satisfies typeof projects.$inferInsert;
    await this.db.insert(projects).values(row);
    return row;
  }

  async getGoal(goalId: string): Promise<Goal | null> {
    const rows = await this.db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    return rows[0] ? goalSchema.parse(rows[0]) : null;
  }

  async createRepository(input: CreateRepositoryInput) {
    const row = {
      id: input.id ?? makeId("repo"),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      purpose: input.purpose,
      provider: input.provider,
      localPath: input.localPath,
      remoteUrl: input.remoteUrl ?? null,
      defaultBranch: input.defaultBranch ?? "main",
      createdAt: now(),
      updatedAt: now(),
    } satisfies typeof repositories.$inferInsert;
    await this.db.insert(repositories).values(row);
    return row;
  }

  async createDefinitionRevision(input: CreateDefinitionRevisionInput) {
    const row = {
      id: input.id ?? makeId("revision"),
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      sourcePath: input.sourcePath,
      dirty: input.dirty ?? false,
      contentHash: input.contentHash,
      createdAt: now(),
    } satisfies typeof definitionRevisions.$inferInsert;
    await this.db.insert(definitionRevisions).values(row);
    return row;
  }

  async createWorkItem(input: CreateWorkItemInput) {
    const existing = await this.db
      .select()
      .from(executionWorkItems)
      .where(
        and(
          eq(executionWorkItems.organizationId, input.organizationId),
          eq(executionWorkItems.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];

    const row = {
      id: input.id ?? makeId("work"),
      organizationId: input.organizationId,
      goalId: input.goalId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "proposed",
      definitionRevisionId: input.definitionRevisionId ?? null,
      sourceCommitSha: input.sourceCommitSha ?? null,
      branchName: input.branchName ?? null,
      claimedByAttemptId: null,
      claimedAt: null,
      priority: input.priority ?? 0,
      deadlineAt: input.deadlineAt ?? null,
      maxAttempts: input.maxAttempts ?? 1,
      retryAfter: null,
      blockedReason: null,
      idempotencyKey: input.idempotencyKey,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: now(),
      updatedAt: now(),
    } satisfies typeof executionWorkItems.$inferInsert;
    await this.db.insert(executionWorkItems).values(row);
    return row;
  }

  async addWorkItemDependency(
    organizationId: string,
    workItemId: string,
    dependsOnWorkItemId: string,
  ): Promise<ExecutionWorkItemDependency> {
    if (workItemId === dependsOnWorkItemId) {
      throw new Error("A work item cannot depend on itself");
    }
    const items = await this.listWorkItems(organizationId);
    const child = items.find((item) => item.id === workItemId);
    const dependency = items.find((item) => item.id === dependsOnWorkItemId);
    if (!child || !dependency) throw new Error("Dependency work item not found");
    if (child.goalId !== dependency.goalId) {
      throw new Error("Dependency must stay within the same goal");
    }
    const edges = await this.listWorkItemDependenciesForOrganization(organizationId);
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
      const next = graph.get(edge.workItemId) ?? [];
      next.push(edge.dependsOnWorkItemId);
      graph.set(edge.workItemId, next);
    }
    const pending = [dependsOnWorkItemId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current || visited.has(current)) continue;
      if (current === workItemId) throw new Error("Dependency would create a cycle");
      visited.add(current);
      pending.push(...(graph.get(current) ?? []));
    }

    const row = {
      organizationId,
      workItemId,
      dependsOnWorkItemId,
      createdAt: now(),
    } satisfies typeof executionWorkItemDependencies.$inferInsert;
    try {
      await this.db.insert(executionWorkItemDependencies).values(row);
    } catch (error) {
      if (!/unique constraint failed/i.test(String((error as Error)?.message ?? error)))
        throw error;
    }
    return executionWorkItemDependencySchema.parse(row);
  }

  async listWorkItemDependencies(workItemId: string): Promise<ExecutionWorkItemDependency[]> {
    const rows = await this.db
      .select()
      .from(executionWorkItemDependencies)
      .where(eq(executionWorkItemDependencies.workItemId, workItemId));
    return rows.map((row) => executionWorkItemDependencySchema.parse(row));
  }

  private async listWorkItemDependenciesForOrganization(
    organizationId: string,
  ): Promise<ExecutionWorkItemDependency[]> {
    const rows = await this.db
      .select()
      .from(executionWorkItemDependencies)
      .where(eq(executionWorkItemDependencies.organizationId, organizationId));
    return rows.map((row) => executionWorkItemDependencySchema.parse(row));
  }

  async listWorkItems(organizationId: string, goalId?: string): Promise<ExecutionWorkItem[]> {
    const rows = await this.db
      .select()
      .from(executionWorkItems)
      .where(
        goalId
          ? and(
              eq(executionWorkItems.organizationId, organizationId),
              eq(executionWorkItems.goalId, goalId),
            )
          : eq(executionWorkItems.organizationId, organizationId),
      )
      .orderBy(desc(executionWorkItems.priority), asc(executionWorkItems.createdAt));
    return rows.map((row) => parseWorkItem(row));
  }

  async updateWorkItemStatus(
    workItemId: string,
    status: ExecutionWorkItem["status"],
    options: { blockedReason?: string | null; retryAfter?: string | null } = {},
  ): Promise<ExecutionWorkItem> {
    await this.db
      .update(executionWorkItems)
      .set({
        status,
        blockedReason: options.blockedReason ?? null,
        retryAfter: options.retryAfter ?? null,
        updatedAt: now(),
      })
      .where(eq(executionWorkItems.id, workItemId));
    const updated = await this.getWorkItem(workItemId);
    if (!updated) throw new Error(`Work item ${workItemId} not found`);
    return updated;
  }

  async getWorkItem(workItemId: string): Promise<ExecutionWorkItem | null> {
    const rows = await this.db
      .select()
      .from(executionWorkItems)
      .where(eq(executionWorkItems.id, workItemId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return parseWorkItem(row);
  }

  async createWorkflowRun(input: CreateWorkflowRunInput) {
    const existing = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, input.organizationId),
          eq(workflowRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const row = {
      id: input.id ?? makeId("run"),
      organizationId: input.organizationId,
      goalId: input.goalId,
      definitionRevisionId: input.definitionRevisionId,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
    } satisfies typeof workflowRuns.$inferInsert;
    await this.db.insert(workflowRuns).values(row);
    return row;
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    return rows[0] ? workflowRunSchema.parse(rows[0]) : null;
  }

  async updateWorkflowRunStatus(
    runId: string,
    status: WorkflowRun["status"],
  ): Promise<WorkflowRun> {
    const finishedAt = ["succeeded", "failed", "cancelled", "timed_out"].includes(status)
      ? now()
      : null;
    await this.db
      .update(workflowRuns)
      .set({
        status,
        startedAt: status === "running" ? now() : undefined,
        finishedAt,
      })
      .where(eq(workflowRuns.id, runId));
    const updated = await this.getWorkflowRun(runId);
    if (!updated) throw new Error(`Workflow run ${runId} not found`);
    return updated;
  }

  async createAttempt(input: CreateAttemptInput) {
    const row = {
      id: input.id ?? makeId("attempt"),
      organizationId: input.organizationId,
      workflowRunId: input.workflowRunId,
      workItemId: input.workItemId,
      agentId: input.agentId,
      harness: input.harness,
      harnessSessionId: null,
      status: input.status ?? "queued",
      attemptNumber: input.attemptNumber ?? 1,
      timeoutMs: input.timeoutMs ?? null,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      createdAt: now(),
    } satisfies typeof agentAttempts.$inferInsert;
    await this.db.insert(agentAttempts).values(row);
    return row;
  }

  async listAttemptsForWorkItem(workItemId: string): Promise<AgentAttempt[]> {
    const rows = await this.db
      .select()
      .from(agentAttempts)
      .where(eq(agentAttempts.workItemId, workItemId))
      .orderBy(asc(agentAttempts.attemptNumber));
    return rows.map((row) => agentAttemptSchema.parse(row));
  }

  /**
   * Claims a ready work item and creates its attempt with a database-backed
   * unique attempt number. A duplicate scheduler tick returns the existing
   * active attempt instead of creating another unit of work.
   */
  async dispatchWorkItem(input: DispatchWorkItemInput): Promise<{
    attempt: AgentAttempt;
    created: boolean;
  } | null> {
    const workItem = await this.getWorkItem(input.workItemId);
    if (!workItem || !["proposed", "ready"].includes(workItem.status)) return null;
    if (workItem.retryAfter && workItem.retryAfter > now()) return null;

    const attempts = await this.listAttemptsForWorkItem(input.workItemId);
    const active = attempts.find((attempt) => isActiveAttemptStatus(attempt.status));
    if (active) return { attempt: active, created: false };
    const attemptNumber = (attempts.at(-1)?.attemptNumber ?? 0) + 1;
    let created: AgentAttempt;
    try {
      const row = await this.createAttempt({
        organizationId: workItem.organizationId,
        workflowRunId: input.workflowRunId,
        workItemId: input.workItemId,
        agentId: input.agentId,
        harness: input.harness,
        attemptNumber,
        timeoutMs: input.timeoutMs,
      });
      created = agentAttemptSchema.parse(row);
    } catch (error) {
      if (!/unique constraint failed/i.test(String((error as Error)?.message ?? error)))
        throw error;
      const winner = (await this.listAttemptsForWorkItem(input.workItemId)).find((attempt) =>
        isActiveAttemptStatus(attempt.status),
      );
      if (!winner) return null;
      return { attempt: winner, created: false };
    }

    const slots = await this.acquireSchedulerSlots({
      organizationId: workItem.organizationId,
      projectId: workItem.projectId,
      attemptId: created.id,
      organizationConcurrency: input.organizationConcurrency ?? 1,
      projectConcurrency: input.projectConcurrency ?? 1,
    });
    if (!slots) {
      await this.db.delete(agentAttempts).where(eq(agentAttempts.id, created.id));
      return null;
    }

    if (!(await this.claimWorkItem(input.workItemId, created.id))) {
      await this.releaseSchedulerLocks(created.id);
      await this.db.delete(agentAttempts).where(eq(agentAttempts.id, created.id));
      const winner = (await this.listAttemptsForWorkItem(input.workItemId)).find((attempt) =>
        isActiveAttemptStatus(attempt.status),
      );
      return winner ? { attempt: winner, created: false } : null;
    }
    return { attempt: created, created: true };
  }

  async startScheduledAttempt(attemptId: string): Promise<AgentAttempt> {
    const current = await this.getAttempt(attemptId);
    if (!current) throw new Error(`Agent attempt ${attemptId} not found`);
    if (current.status === "queued") await this.transitionAttempt(attemptId, "preparing");
    const preparing = await this.getAttempt(attemptId);
    if (preparing?.status === "preparing") await this.transitionAttempt(attemptId, "running");
    await this.db
      .update(executionWorkItems)
      .set({ status: "in_progress", blockedReason: null, updatedAt: now() })
      .where(
        and(
          eq(executionWorkItems.id, current.workItemId),
          eq(executionWorkItems.claimedByAttemptId, attemptId),
        ),
      );
    const started = await this.getAttempt(attemptId);
    if (!started) throw new Error(`Agent attempt ${attemptId} disappeared`);
    return started;
  }

  async completeScheduledAttempt(input: {
    attemptId: string;
    status: Extract<AgentAttempt["status"], "succeeded" | "failed" | "cancelled" | "timed_out">;
    error?: string | null;
    retryDelayMs?: number;
  }): Promise<{ attempt: AgentAttempt; workItem: ExecutionWorkItem }> {
    const current = await this.getAttempt(input.attemptId);
    if (!current) throw new Error(`Agent attempt ${input.attemptId} not found`);
    if (isTerminalAttemptStatus(current.status)) {
      await this.releaseSchedulerLocks(current.id);
      const existingWorkItem = await this.getWorkItem(current.workItemId);
      if (!existingWorkItem) throw new Error(`Work item ${current.workItemId} not found`);
      return { attempt: current, workItem: existingWorkItem };
    }
    if (current.status === "queued" || current.status === "preparing") {
      await this.startScheduledAttempt(input.attemptId);
    }
    if (input.status === "cancelled") {
      await this.transitionAttempt(input.attemptId, "cancelling");
      await this.transitionAttempt(input.attemptId, "cancelled");
    } else {
      await this.transitionAttempt(input.attemptId, input.status);
    }
    const item = await this.getWorkItem(current.workItemId);
    if (!item) throw new Error(`Work item ${current.workItemId} not found`);

    const retryable = input.status === "failed" || input.status === "timed_out";
    const canRetry = retryable && current.attemptNumber < item.maxAttempts;
    if (input.status === "succeeded") {
      await this.updateWorkItemStatus(item.id, "completed");
    } else if (canRetry) {
      const retryAfter = new Date(
        Date.now() + Math.max(0, input.retryDelayMs ?? 1_000),
      ).toISOString();
      await this.updateWorkItemStatus(item.id, "ready", { retryAfter, blockedReason: null });
    } else if (input.status === "cancelled") {
      await this.updateWorkItemStatus(item.id, "cancelled", {
        blockedReason: input.error ?? "cancelled",
      });
    } else {
      await this.updateWorkItemStatus(item.id, "failed", {
        blockedReason: input.error ?? `${input.status} without retry eligibility`,
      });
    }
    await this.releaseSchedulerLocks(input.attemptId);
    const completedAttempt = await this.getAttempt(input.attemptId);
    const completedWorkItem = await this.getWorkItem(item.id);
    if (!completedAttempt || !completedWorkItem) throw new Error("Scheduled outcome disappeared");
    return { attempt: completedAttempt, workItem: completedWorkItem };
  }

  private async acquireSchedulerSlots(input: {
    organizationId: string;
    projectId: string;
    attemptId: string;
    organizationConcurrency: number;
    projectConcurrency: number;
  }): Promise<ResourceLock[] | null> {
    const leaseExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const acquired: ResourceLock[] = [];
    const acquire = async (
      resourceType: ResourceLock["resourceType"],
      resourceId: string,
      count: number,
    ): Promise<boolean> => {
      for (let slot = 0; slot < Math.max(1, count); slot++) {
        const lock = await this.acquireResourceLock({
          organizationId: input.organizationId,
          resourceType,
          resourceId: `${resourceId}:${slot}`,
          ownerAttemptId: input.attemptId,
          leaseExpiresAt,
        });
        if (lock) {
          acquired.push(lock);
          return true;
        }
      }
      return false;
    };
    if (
      !(await acquire(
        "organization_slot",
        `organization:${input.organizationId}`,
        input.organizationConcurrency,
      )) ||
      !(await acquire("project_slot", `project:${input.projectId}`, input.projectConcurrency))
    ) {
      await this.releaseSchedulerLocks(input.attemptId);
      return null;
    }
    return acquired;
  }

  private async releaseSchedulerLocks(ownerAttemptId: string): Promise<void> {
    await this.db
      .update(resourceLocks)
      .set({ releasedAt: now() })
      .where(
        and(
          eq(resourceLocks.ownerAttemptId, ownerAttemptId),
          inArray(resourceLocks.resourceType, ["organization_slot", "project_slot"]),
          isNull(resourceLocks.releasedAt),
        ),
      );
  }

  async getGoalProgress(goalId: string): Promise<{
    goalId: string;
    total: number;
    completed: number;
    active: number;
    proposed: number;
    ready: number;
    blocked: number;
    failed: number;
    cancelled: number;
    percent: number;
    blockedItems: Array<{ id: string; title: string; reason: string }>;
  }> {
    const goalsRows = await this.db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    const goal = goalsRows[0];
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    const items = await this.listWorkItems(goal.organizationId, goalId);
    const completed = items.filter((item) => item.status === "completed").length;
    const active = items.filter((item) => ["claimed", "in_progress"].includes(item.status)).length;
    const proposed = items.filter((item) => item.status === "proposed").length;
    const ready = items.filter((item) => item.status === "ready").length;
    const blocked = items.filter((item) => item.status === "blocked").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const cancelled = items.filter((item) => item.status === "cancelled").length;
    return {
      goalId,
      total: items.length,
      completed,
      active,
      proposed,
      ready,
      blocked,
      failed,
      cancelled,
      percent: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
      blockedItems: items
        .filter((item) => item.status === "blocked")
        .map((item) => ({
          id: item.id,
          title: item.title,
          reason: item.blockedReason ?? "blocked by scheduler",
        })),
    };
  }

  async createHarnessSession(input: CreateHarnessSessionInput) {
    const id = input.id ?? makeId("sess");
    const row = {
      id,
      organizationId: input.organizationId,
      wakeupId: "manual",
      agentId: input.agentId,
      adapter: input.adapter,
      runtimeJson: JSON.stringify(input.runtime ?? {}),
      prompt: input.prompt,
      configJson: JSON.stringify(input.config ?? {}),
      status: "running",
      sessionId: null,
      sessionParamsJson: null,
      sessionDisplayId: id.slice(0, 12),
      resultJson: null,
      usageJson: null,
      costUsd: null,
      errorFamily: null,
      errorCode: null,
      errorMessage: null,
      pendingQuestionJson: null,
      startedAt: now(),
      finishedAt: null,
      durationMs: null,
      parentSessionId: null,
    } satisfies typeof harnessSessions.$inferInsert;
    await this.db.insert(harnessSessions).values(row as never);
    return row;
  }

  async linkHarnessSession(attemptId: string, harnessSessionId: string): Promise<AgentAttempt> {
    await this.db
      .update(agentAttempts)
      .set({ harnessSessionId })
      .where(eq(agentAttempts.id, attemptId));
    const attempt = await this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Agent attempt ${attemptId} not found`);
    return attempt;
  }

  async getHarnessSession(harnessSessionId: string) {
    const rows = await this.db
      .select()
      .from(harnessSessions)
      .where(eq(harnessSessions.id, harnessSessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  async appendHarnessSessionEvent(input: {
    sessionId: string;
    ts?: string;
    kind: string;
    payload: Record<string, unknown>;
    seq: number;
  }): Promise<void> {
    await this.db.insert(harnessSessionEvents).values({
      sessionId: input.sessionId,
      ts: input.ts ?? now(),
      kind: input.kind,
      payloadJson: JSON.stringify(input.payload),
      seq: input.seq,
    });
  }

  async completeHarnessSession(
    sessionId: string,
    result: AdapterExecutionResult,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
  ): Promise<void> {
    const finishedAt = now();
    const current = await this.getHarnessSession(sessionId);
    const startedAtMs = current?.startedAt ? Date.parse(current.startedAt) : Date.now();
    const normalized = {
      sessionId: result.sessionId ?? sessionId,
      sessionParams: result.sessionParams,
      sessionDisplayId: result.sessionDisplayId,
      status,
      exitCode: result.exitCode,
      usage: result.usage,
      costUsd: result.costUsd,
      errorFamily: result.errorFamily,
      errorCode: result.errorCode,
      summary: result.summary,
      logRef: sessionId,
    };
    await this.db
      .update(harnessSessions)
      .set({
        status,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - startedAtMs),
        sessionId: result.sessionId ?? null,
        sessionParamsJson: result.sessionParams ? JSON.stringify(result.sessionParams) : null,
        sessionDisplayId: result.sessionDisplayId ?? null,
        resultJson: JSON.stringify(normalized),
        usageJson: result.usage ? JSON.stringify(result.usage) : null,
        costUsd: result.costUsd ?? null,
        errorFamily: result.errorFamily ?? null,
        errorCode: result.errorCode ?? null,
        errorMessage:
          status === "succeeded" ? null : (result.errorMessage ?? result.summary ?? null),
      } as never)
      .where(eq(harnessSessions.id, sessionId));
  }

  async claimWorkItem(workItemId: string, attemptId: string): Promise<boolean> {
    const changed = await this.db
      .update(executionWorkItems)
      .set({ status: "claimed", claimedByAttemptId: attemptId, claimedAt: now(), updatedAt: now() })
      .where(
        and(
          eq(executionWorkItems.id, workItemId),
          inArray(executionWorkItems.status, ["proposed", "ready"]),
        ),
      )
      .returning({ id: executionWorkItems.id });
    return changed.length === 1;
  }

  async transitionAttempt(attemptId: string, nextStatus: AttemptStatus) {
    const rows = await this.db
      .select()
      .from(agentAttempts)
      .where(eq(agentAttempts.id, attemptId))
      .limit(1);
    const current = rows[0];
    if (!current) throw new Error(`Agent attempt ${attemptId} not found`);
    assertValidAttemptTransition(current.status as AttemptStatus, nextStatus);

    const timestamp = now();
    const update: Partial<typeof agentAttempts.$inferInsert> = { status: nextStatus };
    if (nextStatus === "running") update.startedAt = timestamp;
    if (["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(nextStatus)) {
      update.finishedAt = timestamp;
    }
    await this.db.update(agentAttempts).set(update).where(eq(agentAttempts.id, attemptId));
    return { ...current, ...update };
  }

  async getAttempt(attemptId: string): Promise<AgentAttempt | null> {
    const rows = await this.db
      .select()
      .from(agentAttempts)
      .where(eq(agentAttempts.id, attemptId))
      .limit(1);
    return rows[0] ? agentAttemptSchema.parse(rows[0]) : null;
  }

  async reconcileLostAttempts(cutoff: string): Promise<number> {
    const candidates = await this.db
      .select()
      .from(agentAttempts)
      .where(inArray(agentAttempts.status, ["preparing", "running"]));
    const stale = candidates.filter(
      (attempt) => (attempt.startedAt ?? attempt.createdAt) <= cutoff,
    );
    for (const attempt of stale) {
      await this.db
        .update(agentAttempts)
        .set({ status: "lost", finishedAt: now() })
        .where(eq(agentAttempts.id, attempt.id));
    }
    return stale.length;
  }

  async cancelAttempt(attemptId: string): Promise<AgentAttempt> {
    const current = await this.getAttempt(attemptId);
    if (!current) throw new Error(`Agent attempt ${attemptId} not found`);
    if (["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(current.status)) {
      return current;
    }
    if (current.status === "queued") await this.transitionAttempt(attemptId, "cancelled");
    else if (current.status === "preparing" || current.status === "running") {
      await this.transitionAttempt(attemptId, "cancelling");
      await this.transitionAttempt(attemptId, "cancelled");
    } else if (current.status === "cancelling") {
      await this.transitionAttempt(attemptId, "cancelled");
    }
    const cancelled = await this.getAttempt(attemptId);
    if (!cancelled) throw new Error(`Agent attempt ${attemptId} disappeared during cancellation`);
    return cancelled;
  }

  async acquireResourceLock(input: AcquireResourceLockInput): Promise<ResourceLock | null> {
    const row = {
      id: input.id ?? makeId("lock"),
      organizationId: input.organizationId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ownerAttemptId: input.ownerAttemptId,
      acquiredAt: now(),
      leaseExpiresAt: input.leaseExpiresAt,
      releasedAt: null,
    } satisfies typeof resourceLocks.$inferInsert;
    try {
      // The partial unique index is the authority for active ownership. The
      // insert, not a preceding read, decides which concurrent caller wins.
      await this.db.insert(resourceLocks).values(row);
    } catch (error) {
      if (isActiveResourceLockConflict(error)) return null;
      throw error;
    }
    return resourceLockSchema.parse(row);
  }

  async findResourceLock(
    organizationId: string,
    resourceType: ResourceLock["resourceType"],
    resourceId: string,
  ): Promise<ResourceLock | null> {
    const rows = await this.db
      .select()
      .from(resourceLocks)
      .where(
        and(
          eq(resourceLocks.organizationId, organizationId),
          eq(resourceLocks.resourceType, resourceType),
          eq(resourceLocks.resourceId, resourceId),
          isNull(resourceLocks.releasedAt),
        ),
      )
      .limit(1);
    return rows[0] ? resourceLockSchema.parse(rows[0]) : null;
  }

  async releaseResourceLock(lockId: string): Promise<ResourceLock | null> {
    await this.db
      .update(resourceLocks)
      .set({ releasedAt: now() })
      .where(and(eq(resourceLocks.id, lockId), isNull(resourceLocks.releasedAt)));
    const rows = await this.db
      .select()
      .from(resourceLocks)
      .where(eq(resourceLocks.id, lockId))
      .limit(1);
    return rows[0] ? resourceLockSchema.parse(rows[0]) : null;
  }

  async reconcileExpiredLocks(at = now()): Promise<number> {
    const expired = await this.db
      .select({ id: resourceLocks.id })
      .from(resourceLocks)
      .where(and(lte(resourceLocks.leaseExpiresAt, at), isNull(resourceLocks.releasedAt)));
    for (const lock of expired) await this.releaseResourceLock(lock.id);
    return expired.length;
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    const row = {
      id: input.id ?? makeId("workspace"),
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      repositoryId: input.repositoryId,
      path: input.path,
      branchName: input.branchName,
      baseCommitSha: input.baseCommitSha,
      status: input.status ?? "pending",
      createdAt: now(),
      releasedAt: null,
    } satisfies typeof executionWorkspaces.$inferInsert;
    await this.db.insert(executionWorkspaces).values(row);
    return row;
  }

  async getWorkspace(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateWorkspaceStatus(
    workspaceId: string,
    status: ExecutionWorkspace["status"],
  ): Promise<ExecutionWorkspace> {
    const releasedAt = status === "released" ? now() : null;
    await this.db
      .update(executionWorkspaces)
      .set({ status, releasedAt })
      .where(eq(executionWorkspaces.id, workspaceId));
    const updated = await this.getWorkspace(workspaceId);
    if (!updated) throw new Error(`Execution workspace ${workspaceId} not found`);
    return executionWorkspaceSchema.parse(updated);
  }

  async createPlan(input: CreatePlanInput) {
    const row = {
      id: input.id ?? makeId("plan"),
      organizationId: input.organizationId,
      definitionRevisionId: input.definitionRevisionId,
      workItemId: input.workItemId,
      attemptId: input.attemptId,
      sourceSnapshotJson: JSON.stringify(input.sourceSnapshot),
      targetJson: JSON.stringify(input.target),
      harness: input.harness,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs ?? null,
      runtimeConfigJson: JSON.stringify(input.runtimeConfig ?? {}),
      createdAt: now(),
    } satisfies typeof executionPlans.$inferInsert;
    await this.db.insert(executionPlans).values(row);
    const {
      sourceSnapshotJson: _sourceSnapshotJson,
      targetJson: _targetJson,
      runtimeConfigJson: _runtimeConfigJson,
      ...plan
    } = row;
    return executionPlanSchema.parse({
      ...plan,
      sourceSnapshot: input.sourceSnapshot,
      target: input.target,
      runtimeConfig: input.runtimeConfig ?? {},
    });
  }

  async appendEvent(input: AppendEventInput): Promise<ExecutionEvent> {
    const row = {
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      ts: input.ts ?? now(),
      type: input.type,
      payloadJson: JSON.stringify(input.payload),
      seq: input.seq,
    } satisfies typeof executionEvents.$inferInsert;
    await this.db.insert(executionEvents).values(row);
    const rows = await this.db
      .select()
      .from(executionEvents)
      .where(
        and(eq(executionEvents.attemptId, input.attemptId), eq(executionEvents.seq, input.seq)),
      )
      .limit(1);
    const created = rows[0];
    if (!created)
      throw new Error(`Execution event ${input.attemptId}/${input.seq} was not persisted`);
    const { payloadJson, ...event } = created;
    return executionEventSchema.parse({ ...event, payload: JSON.parse(payloadJson) });
  }

  async listEvents(attemptId: string): Promise<ExecutionEvent[]> {
    const rows = await this.db
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.attemptId, attemptId))
      .orderBy(asc(executionEvents.seq));
    return rows.map((row) => {
      const { payloadJson, ...event } = row;
      return executionEventSchema.parse({ ...event, payload: JSON.parse(payloadJson) });
    });
  }

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    const row = {
      id: input.id ?? makeId("artifact"),
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      kind: input.kind,
      path: input.path,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      createdAt: input.createdAt ?? now(),
    } satisfies typeof artifacts.$inferInsert;
    await this.db.insert(artifacts).values(row);
    return row as Artifact;
  }

  async listArtifacts(attemptId: string): Promise<Artifact[]> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.attemptId, attemptId))
      .orderBy(asc(artifacts.createdAt));
    return rows as Artifact[];
  }
}

function isActiveResourceLockConflict(error: unknown): boolean {
  const message = String((error as Error | null)?.message ?? error);
  return /unique constraint failed:\s*resource_locks\.(organization_id|resource_type|resource_id)/i.test(
    message,
  );
}

function parseWorkItem(row: typeof executionWorkItems.$inferSelect): ExecutionWorkItem {
  const {
    claimedByAttemptId: _claimedByAttemptId,
    claimedAt: _claimedAt,
    metadataJson,
    ...workItem
  } = row;
  return executionWorkItemSchema.parse({ ...workItem, metadata: JSON.parse(metadataJson) });
}

function isActiveAttemptStatus(status: AgentAttempt["status"]): boolean {
  return ["queued", "preparing", "running", "cancelling"].includes(status);
}

function isTerminalAttemptStatus(status: AgentAttempt["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(status);
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}
