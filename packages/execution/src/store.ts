import { randomUUID } from "node:crypto";
import type {
  AgentAttempt,
  Artifact,
  AttemptRole,
  AttemptStatus,
  ExecutionEvent,
  ExecutionWorkItem,
  ExecutionWorkItemDependency,
  ExecutionWorkspace,
  Goal,
  LoopOutput,
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
  loopOutputSchema,
  resourceLockSchema,
  workflowRunSchema,
} from "@aaspai/contracts/execution";
import type {
  ApprovalStatus,
  ExecutionApproval,
  ExecutionGovernance,
  ExecutionGovernanceEvent,
  ExecutionGovernanceInput,
  ExecutionVerification,
  VerificationStatus,
} from "@aaspai/contracts/governance";
import {
  executionApprovalSchema,
  executionGovernanceEventSchema,
  executionGovernanceSchema,
  executionVerificationSchema,
} from "@aaspai/contracts/governance";
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
  executionApprovals,
  executionBudgetReservations,
  executionEvents,
  executionGovernanceEvents,
  executionPlans,
  executionVerifications,
  executionWorkItemDependencies,
  executionWorkItems,
  executionWorkspaces,
  goals,
  sessionEvents as harnessSessionEvents,
  sessions as harnessSessions,
  inArray,
  isNull,
  loopOutputs,
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
  workflowRunId?: string | null;
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
  governance?: ExecutionGovernanceInput;
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
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  status?: WorkflowRun["status"];
}

export interface CreateLoopOutputInput {
  id?: string;
  organizationId: string;
  loopId: string;
  workflowRunId: string;
  kind: LoopOutput["kind"];
  sourceRef: string;
  title: string;
  body: string;
  severity?: LoopOutput["severity"];
  workItemId?: string | null;
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
  role?: AttemptRole;
  parentAttemptId?: string | null;
  verificationId?: string | null;
}

export interface CheckerAttemptInput {
  verificationId: string;
  agentId: string;
  harness: string;
  timeoutMs?: number | null;
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
      workflowRunId: input.workflowRunId ?? null,
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
      governanceJson: JSON.stringify(input.governance ?? {}),
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
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
    } satisfies typeof workflowRuns.$inferInsert;
    await this.db.insert(workflowRuns).values(row);
    return row;
  }

  async getWorkflowRunByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowRun | null> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? workflowRunSchema.parse(rows[0]) : null;
  }

  async createLoopOutput(input: CreateLoopOutputInput): Promise<LoopOutput> {
    const existing = await this.db
      .select()
      .from(loopOutputs)
      .where(
        and(
          eq(loopOutputs.workflowRunId, input.workflowRunId),
          eq(loopOutputs.kind, input.kind),
          eq(loopOutputs.sourceRef, input.sourceRef),
        ),
      )
      .limit(1);
    if (existing[0]) return loopOutputSchema.parse(existing[0]);
    const row = {
      id: input.id ?? makeId("loop_output"),
      organizationId: input.organizationId,
      loopId: input.loopId,
      workflowRunId: input.workflowRunId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      title: input.title,
      body: input.body,
      severity: input.severity ?? null,
      workItemId: input.workItemId ?? null,
      createdAt: now(),
    } satisfies typeof loopOutputs.$inferInsert;
    try {
      await this.db.insert(loopOutputs).values(row);
    } catch (error) {
      if (!/unique constraint failed/i.test(String((error as Error)?.message ?? error)))
        throw error;
      const raced = await this.db
        .select()
        .from(loopOutputs)
        .where(
          and(
            eq(loopOutputs.workflowRunId, input.workflowRunId),
            eq(loopOutputs.kind, input.kind),
            eq(loopOutputs.sourceRef, input.sourceRef),
          ),
        )
        .limit(1);
      if (!raced[0]) throw error;
      return loopOutputSchema.parse(raced[0]);
    }
    return loopOutputSchema.parse(row);
  }

  async listLoopOutputs(organizationId: string, loopId?: string): Promise<LoopOutput[]> {
    const rows = await this.db
      .select()
      .from(loopOutputs)
      .where(
        loopId
          ? and(eq(loopOutputs.organizationId, organizationId), eq(loopOutputs.loopId, loopId))
          : eq(loopOutputs.organizationId, organizationId),
      )
      .orderBy(desc(loopOutputs.createdAt));
    return rows.map((row) => loopOutputSchema.parse(row));
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
      role: input.role ?? "maker",
      parentAttemptId: input.parentAttemptId ?? null,
      verificationId: input.verificationId ?? null,
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

    const policyDecision = evaluateExecutionPolicy(workItem.governance, workItem.metadata);
    if (!policyDecision.ok) {
      await this.recordGovernanceEvent({
        organizationId: workItem.organizationId,
        workItemId: workItem.id,
        action: "execute",
        decision: "denied",
        reason: policyDecision.reason,
      });
      await this.updateWorkItemStatus(workItem.id, "blocked", {
        blockedReason: `execution denied: ${policyDecision.reason}`,
      });
      return null;
    }

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
      repositoryId: workItem.repositoryId,
      branchName: workItem.branchName,
      attemptId: created.id,
      organizationConcurrency: input.organizationConcurrency ?? 1,
      projectConcurrency: input.projectConcurrency ?? 1,
    });
    if (!slots) {
      await this.db.delete(agentAttempts).where(eq(agentAttempts.id, created.id));
      return null;
    }

    if (!(await this.reserveBudget(workItem, created.id, input.agentId))) {
      await this.releaseSchedulerLocks(created.id);
      await this.db.delete(agentAttempts).where(eq(agentAttempts.id, created.id));
      await this.updateWorkItemStatus(workItem.id, "blocked", {
        blockedReason: "budget exhausted; no new attempt was started",
      });
      return null;
    }

    if (!(await this.claimWorkItem(input.workItemId, created.id))) {
      await this.releaseSchedulerLocks(created.id);
      await this.releaseBudgetReservations(created.id);
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
    usage?: { tokens?: number; costUsd?: number };
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
    await this.settleBudgetReservations(input.attemptId, input.usage);
    if (input.status === "succeeded") {
      if (item.governance.verification.required) {
        const verification = await this.createVerification({
          organizationId: item.organizationId,
          workItemId: item.id,
          makerAttemptId: current.id,
        });
        await this.updateWorkItemStatus(item.id, "awaiting_verification", {
          blockedReason: `checker verification required (${verification.id})`,
        });
      } else if (item.governance.approval.required) {
        const approval = await this.createApprovalRequest({
          organizationId: item.organizationId,
          workItemId: item.id,
          actorType: item.governance.approval.actorType,
          expiresAfterMs: item.governance.approval.expiresAfterMs,
        });
        await this.updateWorkItemStatus(item.id, "awaiting_approval", {
          blockedReason: `approval required (${approval.id})`,
        });
      } else {
        await this.updateWorkItemStatus(item.id, "completed");
      }
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

  async getVerification(verificationId: string): Promise<ExecutionVerification | null> {
    const rows = await this.db
      .select()
      .from(executionVerifications)
      .where(eq(executionVerifications.id, verificationId))
      .limit(1);
    return rows[0] ? parseVerification(rows[0]) : null;
  }

  async getVerificationForWorkItem(workItemId: string): Promise<ExecutionVerification | null> {
    const rows = await this.db
      .select()
      .from(executionVerifications)
      .where(eq(executionVerifications.workItemId, workItemId))
      .orderBy(desc(executionVerifications.createdAt))
      .limit(1);
    return rows[0] ? parseVerification(rows[0]) : null;
  }

  async createVerification(input: {
    organizationId: string;
    workItemId: string;
    makerAttemptId: string;
    id?: string;
  }): Promise<ExecutionVerification> {
    const existing = await this.getVerificationForWorkItem(input.workItemId);
    if (existing && existing.status === "pending") return existing;
    const row = {
      id: input.id ?? makeId("verification"),
      organizationId: input.organizationId,
      workItemId: input.workItemId,
      makerAttemptId: input.makerAttemptId,
      checkerAttemptId: null,
      status: "pending",
      summary: "",
      evidenceIdsJson: "[]",
      createdAt: now(),
      completedAt: null,
    } satisfies typeof executionVerifications.$inferInsert;
    await this.db.insert(executionVerifications).values(row);
    return parseVerification(row);
  }

  async createCheckerAttempt(input: CheckerAttemptInput): Promise<AgentAttempt> {
    const verification = await this.getVerification(input.verificationId);
    if (!verification) throw new Error(`Verification ${input.verificationId} not found`);
    if (verification.status !== "pending") throw new Error("Verification is no longer pending");
    const maker = await this.getAttempt(verification.makerAttemptId);
    if (!maker) throw new Error(`Maker attempt ${verification.makerAttemptId} not found`);
    const workItem = await this.getWorkItem(verification.workItemId);
    if (!workItem) throw new Error(`Work item ${verification.workItemId} not found`);
    if (
      workItem.governance.verification.checkerAgentId &&
      workItem.governance.verification.checkerAgentId !== input.agentId
    ) {
      throw new Error("Checker agent does not satisfy the verification plan");
    }
    if (
      workItem.governance.verification.checkerHarness &&
      workItem.governance.verification.checkerHarness !== input.harness
    ) {
      throw new Error("Checker harness does not satisfy the verification plan");
    }
    const existing = (await this.listAttemptsForWorkItem(verification.workItemId)).find(
      (attempt) => attempt.role === "checker" && attempt.verificationId === verification.id,
    );
    if (existing) return existing;
    const row = await this.createAttempt({
      organizationId: verification.organizationId,
      workflowRunId: maker.workflowRunId,
      workItemId: verification.workItemId,
      agentId: input.agentId,
      harness: input.harness,
      timeoutMs: input.timeoutMs,
      attemptNumber: 1,
      role: "checker",
      parentAttemptId: maker.id,
      verificationId: verification.id,
    });
    return agentAttemptSchema.parse(row);
  }

  async startCheckerAttempt(attemptId: string): Promise<AgentAttempt> {
    const current = await this.getAttempt(attemptId);
    if (current?.role !== "checker")
      throw new Error(`Checker attempt ${attemptId} not found`);
    if (current.status === "queued") await this.transitionAttempt(attemptId, "preparing");
    const preparing = await this.getAttempt(attemptId);
    if (preparing?.status === "preparing") await this.transitionAttempt(attemptId, "running");
    const started = await this.getAttempt(attemptId);
    if (!started) throw new Error(`Checker attempt ${attemptId} disappeared`);
    return started;
  }

  async submitVerification(input: {
    verificationId: string;
    checkerAttemptId: string;
    status: VerificationStatus;
    summary: string;
    evidenceIds?: string[];
  }): Promise<{ verification: ExecutionVerification; workItem: ExecutionWorkItem }> {
    const verification = await this.getVerification(input.verificationId);
    if (!verification) throw new Error(`Verification ${input.verificationId} not found`);
    const checker = await this.getAttempt(input.checkerAttemptId);
    if (checker?.role !== "checker" || checker.verificationId !== verification.id) {
      throw new Error("Checker attempt does not belong to verification");
    }
    const currentWorkItem = await this.getWorkItem(verification.workItemId);
    if (!currentWorkItem) throw new Error(`Work item ${verification.workItemId} not found`);
    if (
      input.status === "passed" &&
      currentWorkItem.governance.verification.minEvidence > (input.evidenceIds ?? []).length
    ) {
      throw new Error("Verification requires more evidence");
    }
    if (!isTerminalAttemptStatus(checker.status)) {
      if (checker.status === "queued" || checker.status === "preparing") {
        await this.startCheckerAttempt(checker.id);
      }
      await this.transitionAttempt(checker.id, input.status === "passed" ? "succeeded" : "failed");
    }
    await this.db
      .update(executionVerifications)
      .set({
        checkerAttemptId: checker.id,
        status: input.status,
        summary: input.summary,
        evidenceIdsJson: JSON.stringify(input.evidenceIds ?? []),
        completedAt: now(),
      })
      .where(eq(executionVerifications.id, verification.id));

    await this.recordGovernanceEvent({
      organizationId: verification.organizationId,
      workItemId: verification.workItemId,
      attemptId: checker.id,
      action: "verification.submit",
      decision: input.status === "passed" ? "allowed" : "denied",
      reason: input.summary,
      metadata: {
        verificationId: verification.id,
        status: input.status,
        evidenceIds: input.evidenceIds ?? [],
      },
    });

    if (input.status === "passed") {
      if (currentWorkItem.governance.approval.required) {
        const approval = await this.createApprovalRequest({
          organizationId: currentWorkItem.organizationId,
          workItemId: currentWorkItem.id,
          verificationId: verification.id,
          actorType: currentWorkItem.governance.approval.actorType,
          expiresAfterMs: currentWorkItem.governance.approval.expiresAfterMs,
        });
        await this.updateWorkItemStatus(currentWorkItem.id, "awaiting_approval", {
          blockedReason: `approval required (${approval.id})`,
        });
      } else {
        await this.updateWorkItemStatus(currentWorkItem.id, "completed");
      }
    } else {
      await this.updateWorkItemStatus(currentWorkItem.id, "blocked", {
        blockedReason: `verification ${input.status}: ${input.summary}`,
      });
    }
    const updated = await this.getVerification(verification.id);
    const workItem = await this.getWorkItem(currentWorkItem.id);
    if (!updated || !workItem) throw new Error("Verification result disappeared");
    return { verification: updated, workItem };
  }

  async createApprovalRequest(input: {
    organizationId: string;
    workItemId: string;
    verificationId?: string | null;
    actorType: "human" | "operator" | "supervisor";
    expiresAfterMs?: number | null;
  }): Promise<ExecutionApproval> {
    const requested = await this.listApprovalsForWorkItem(input.workItemId);
    const active = requested.find((approval) => approval.status === "requested");
    if (active) return active;
    const requestedAt = new Date();
    const expiresAt = input.expiresAfterMs
      ? new Date(requestedAt.getTime() + input.expiresAfterMs).toISOString()
      : null;
    const row = {
      id: makeId("approval"),
      organizationId: input.organizationId,
      workItemId: input.workItemId,
      verificationId: input.verificationId ?? null,
      status: "requested",
      actorType: input.actorType,
      actorId: null,
      reason: "",
      requestedAt: requestedAt.toISOString(),
      expiresAt,
      decidedAt: null,
    } satisfies typeof executionApprovals.$inferInsert;
    await this.db.insert(executionApprovals).values(row);
    return parseApproval(row);
  }

  async listApprovalsForWorkItem(workItemId: string): Promise<ExecutionApproval[]> {
    const rows = await this.db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.workItemId, workItemId))
      .orderBy(desc(executionApprovals.requestedAt));
    return rows.map(parseApproval);
  }

  async getApproval(approvalId: string): Promise<ExecutionApproval | null> {
    const rows = await this.db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.id, approvalId))
      .limit(1);
    return rows[0] ? parseApproval(rows[0]) : null;
  }

  async decideApproval(input: {
    approvalId: string;
    actorId: string;
    actorType: "human" | "operator" | "supervisor";
    status: Exclude<ApprovalStatus, "requested" | "expired" | "cancelled">;
    reason?: string;
  }): Promise<{ approval: ExecutionApproval; workItem: ExecutionWorkItem }> {
    const rows = await this.db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.id, input.approvalId))
      .limit(1);
    const current = rows[0] ? parseApproval(rows[0]) : null;
    if (!current) throw new Error(`Approval ${input.approvalId} not found`);
    if (current.status !== "requested") throw new Error("Approval is no longer requested");
    if (current.expiresAt && current.expiresAt <= now()) {
      await this.db
        .update(executionApprovals)
        .set({ status: "expired", decidedAt: now() })
        .where(eq(executionApprovals.id, current.id));
      throw new Error("Approval has expired");
    }
    if (current.actorType !== input.actorType)
      throw new Error("Approval actor type is not authorized");
    const pendingWorkItem = await this.getWorkItem(current.workItemId);
    if (!pendingWorkItem) throw new Error(`Work item ${current.workItemId} not found`);
    if (pendingWorkItem.status !== "awaiting_approval")
      throw new Error("Work item is not awaiting approval");
    await this.db
      .update(executionApprovals)
      .set({
        status: input.status,
        actorId: input.actorId,
        reason: input.reason ?? "",
        decidedAt: now(),
      })
      .where(eq(executionApprovals.id, current.id));
    const workItem = await this.getWorkItem(current.workItemId);
    if (!workItem) throw new Error(`Work item ${current.workItemId} not found`);
    if (input.status === "approved") await this.updateWorkItemStatus(workItem.id, "completed");
    else
      await this.updateWorkItemStatus(workItem.id, "blocked", {
        blockedReason: input.reason ?? input.status,
      });
    await this.recordGovernanceEvent({
      organizationId: current.organizationId,
      workItemId: current.workItemId,
      action: `approval.${input.status}`,
      decision: input.status === "approved" ? "allowed" : "denied",
      reason: input.reason ?? input.status,
      metadata: { approvalId: current.id, actorId: input.actorId, actorType: input.actorType },
    });
    const approvalRows = await this.db
      .select()
      .from(executionApprovals)
      .where(eq(executionApprovals.id, current.id))
      .limit(1);
    const approval = approvalRows[0] ? parseApproval(approvalRows[0]) : null;
    const updatedWorkItem = await this.getWorkItem(workItem.id);
    if (!approval || !updatedWorkItem) throw new Error("Approval decision disappeared");
    return { approval, workItem: updatedWorkItem };
  }

  async recordGovernanceEvent(
    input: Omit<ExecutionGovernanceEvent, "id" | "occurredAt" | "attemptId" | "metadata"> & {
      attemptId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ExecutionGovernanceEvent> {
    const row = {
      id: makeId("governance"),
      organizationId: input.organizationId,
      workItemId: input.workItemId ?? null,
      attemptId: input.attemptId ?? null,
      action: input.action,
      decision: input.decision,
      reason: input.reason,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      occurredAt: now(),
    } satisfies typeof executionGovernanceEvents.$inferInsert;
    await this.db.insert(executionGovernanceEvents).values(row);
    const { metadataJson, ...event } = row;
    return executionGovernanceEventSchema.parse({ ...event, metadata: JSON.parse(metadataJson) });
  }

  async listGovernanceEvents(
    organizationId: string,
    workItemId?: string,
  ): Promise<ExecutionGovernanceEvent[]> {
    const rows = await this.db
      .select()
      .from(executionGovernanceEvents)
      .where(
        workItemId
          ? and(
              eq(executionGovernanceEvents.organizationId, organizationId),
              eq(executionGovernanceEvents.workItemId, workItemId),
            )
          : eq(executionGovernanceEvents.organizationId, organizationId),
      )
      .orderBy(desc(executionGovernanceEvents.occurredAt));
    return rows.map((row) => {
      const { metadataJson, ...event } = row;
      return executionGovernanceEventSchema.parse({ ...event, metadata: JSON.parse(metadataJson) });
    });
  }

  private async reserveBudget(
    workItem: ExecutionWorkItem,
    attemptId: string,
    agentId: string,
  ): Promise<boolean> {
    if (workItem.governance.budget.limits.length === 0) return true;
    const warnings: string[] = [];
    try {
      this.db.transaction((tx) => {
        for (const limit of workItem.governance.budget.limits) {
          const scopeId = budgetScopeId(limit.scope, workItem, agentId, attemptId);
          const rows = tx
            .select()
            .from(executionBudgetReservations)
            .where(
              and(
                eq(executionBudgetReservations.organizationId, workItem.organizationId),
                eq(executionBudgetReservations.scope, limit.scope),
                eq(executionBudgetReservations.scopeId, scopeId),
                inArray(executionBudgetReservations.status, ["reserved", "settled"]),
              ),
            )
            .all();
          const tokens = rows.reduce(
            (sum, row) => sum + (row.status === "reserved" ? row.reservedTokens : row.actualTokens),
            0,
          );
          const costUsd = rows.reduce(
            (sum, row) =>
              sum + (row.status === "reserved" ? row.reservedCostUsd : row.actualCostUsd),
            0,
          );
          const runs = rows.reduce((sum, row) => sum + row.reservedRuns, 0);
          if (
            (limit.tokens > 0 && tokens >= limit.tokens) ||
            (limit.costUsd > 0 && costUsd >= limit.costUsd) ||
            (limit.runs > 0 && runs + 1 > limit.runs)
          ) {
            throw new BudgetExhaustedError(`budget exhausted for ${limit.scope}:${scopeId}`);
          }
          if (limit.runs > 0 && runs / limit.runs >= workItem.governance.budget.soft) {
            warnings.push(`budget soft threshold reached for ${limit.scope}:${scopeId}`);
          }
          tx.insert(executionBudgetReservations)
            .values({
              id: makeId("budget"),
              organizationId: workItem.organizationId,
              workItemId: workItem.id,
              attemptId,
              scope: limit.scope,
              scopeId,
              reservedTokens: 0,
              reservedCostUsd: 0,
              reservedRuns: 1,
              actualTokens: 0,
              actualCostUsd: 0,
              status: "reserved",
              createdAt: now(),
              settledAt: null,
            })
            .run();
        }
      });
    } catch (error) {
      if (!(error instanceof BudgetExhaustedError)) throw error;
      await this.recordGovernanceEvent({
        organizationId: workItem.organizationId,
        workItemId: workItem.id,
        attemptId,
        action: "budget.reserve",
        decision: "denied",
        reason: error.message,
      });
      return false;
    }
    for (const reason of warnings) {
      await this.recordGovernanceEvent({
        organizationId: workItem.organizationId,
        workItemId: workItem.id,
        attemptId,
        action: "budget.reserve",
        decision: "warning",
        reason,
      });
    }
    return true;
  }

  private async releaseBudgetReservations(attemptId: string): Promise<void> {
    await this.db
      .update(executionBudgetReservations)
      .set({ status: "released", settledAt: now() })
      .where(
        and(
          eq(executionBudgetReservations.attemptId, attemptId),
          eq(executionBudgetReservations.status, "reserved"),
        ),
      );
  }

  private async settleBudgetReservations(
    attemptId: string,
    usage?: { tokens?: number; costUsd?: number },
  ): Promise<void> {
    await this.db
      .update(executionBudgetReservations)
      .set({
        status: "settled",
        actualTokens: usage?.tokens ?? 0,
        actualCostUsd: usage?.costUsd ?? 0,
        settledAt: now(),
      })
      .where(
        and(
          eq(executionBudgetReservations.attemptId, attemptId),
          eq(executionBudgetReservations.status, "reserved"),
        ),
      );
  }

  private async acquireSchedulerSlots(input: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
    branchName: string | null;
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
    if (input.branchName) {
      const branchLock = await this.acquireResourceLock({
        organizationId: input.organizationId,
        resourceType: "branch",
        resourceId: `${input.repositoryId}:${input.branchName}`,
        ownerAttemptId: input.attemptId,
        leaseExpiresAt,
      });
      if (!branchLock) {
        await this.releaseSchedulerLocks(input.attemptId);
        return null;
      }
      acquired.push(branchLock);
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
          inArray(resourceLocks.resourceType, ["organization_slot", "project_slot", "branch"]),
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
    awaitingVerification: number;
    awaitingApproval: number;
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
    const awaitingVerification = items.filter(
      (item) => item.status === "awaiting_verification",
    ).length;
    const awaitingApproval = items.filter((item) => item.status === "awaiting_approval").length;
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
      awaitingVerification,
      awaitingApproval,
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

class BudgetExhaustedError extends Error {}

function parseWorkItem(row: typeof executionWorkItems.$inferSelect): ExecutionWorkItem {
  const {
    claimedByAttemptId: _claimedByAttemptId,
    claimedAt: _claimedAt,
    metadataJson,
    governanceJson,
    ...workItem
  } = row;
  return executionWorkItemSchema.parse({
    ...workItem,
    metadata: JSON.parse(metadataJson),
    governance: executionGovernanceSchema.parse(JSON.parse(governanceJson)),
  });
}

function parseVerification(row: typeof executionVerifications.$inferSelect): ExecutionVerification {
  const { evidenceIdsJson, ...verification } = row;
  return executionVerificationSchema.parse({
    ...verification,
    evidenceIds: JSON.parse(evidenceIdsJson),
  });
}

function parseApproval(row: typeof executionApprovals.$inferSelect): ExecutionApproval {
  return executionApprovalSchema.parse(row);
}

function budgetScopeId(
  scope: ExecutionGovernance["budget"]["limits"][number]["scope"],
  workItem: ExecutionWorkItem,
  agentId: string,
  attemptId: string,
): string {
  if (scope === "organization") return workItem.organizationId;
  if (scope === "goal") return workItem.goalId;
  if (scope === "project") return workItem.projectId;
  if (scope === "agent") return agentId;
  return attemptId;
}

function evaluateExecutionPolicy(
  governance: ExecutionGovernance,
  metadata: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  const action = governance.policy.actions.execute;
  if (action && !action.allowed)
    return { ok: false, reason: "execute action is disallowed by policy" };
  if (action?.requireApproval) {
    return { ok: false, reason: `execute action requires ${action.requireApproval} approval` };
  }
  const paths = Array.isArray(metadata.paths)
    ? metadata.paths.filter((path): path is string => typeof path === "string")
    : [];
  const deniedPath = paths.find((path) =>
    governance.policy.denylist.some((pattern) => matchesPath(pattern, path)),
  );
  if (deniedPath) return { ok: false, reason: `path is denied by policy: ${deniedPath}` };
  if (governance.policy.allowlist.length > 0) {
    const outsideAllowlist = paths.find(
      (path) => !governance.policy.allowlist.some((pattern) => matchesPath(pattern, path)),
    );
    if (outsideAllowlist)
      return { ok: false, reason: `path is outside policy allowlist: ${outsideAllowlist}` };
  }
  if (governance.policy.maxFilesChanged > 0 && paths.length > governance.policy.maxFilesChanged) {
    return { ok: false, reason: "change exceeds policy maxFilesChanged" };
  }
  return { ok: true };
}

function matchesPath(pattern: string, path: string): boolean {
  if (pattern === path || pattern === "**") return true;
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return false;
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
