import { createHash, randomUUID } from "node:crypto";
import { type CompanyHealth, companyHealthSchema } from "@aaspai/contracts";
import type {
  AgentAttempt,
  Artifact,
  AttemptRole,
  AttemptStatus,
  DefinitionRevision,
  ExecutionEvent,
  ExecutionRawOutput,
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
  definitionRevisionSchema,
  executionEventSchema,
  executionPlanSchema,
  executionRawOutputSchema,
  executionWorkItemDependencySchema,
  executionWorkItemSchema,
  executionWorkspaceSchema,
  goalSchema,
  loopOutputSchema,
  projectSchema,
  repositorySchema,
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
import type { ExecutionContext } from "@aaspai/contracts/operator";
import type { ResolvedAgentProfile } from "@aaspai/contracts/profile";
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
  executionExternalActions,
  executionGovernanceEvents,
  executionPlans,
  executionRawOutputs,
  executionVerifications,
  executionWorkItemDependencies,
  executionWorkItems,
  executionWorkspaces,
  goals,
  gt,
  gte,
  sessionEvents as harnessSessionEvents,
  sessions as harnessSessions,
  inArray,
  isNull,
  loopOutputs,
  lte,
  milestones,
  notExists,
  or,
  processBindings,
  projectAssignments,
  projects,
  repositories,
  resourceLocks,
  type SqliteDb,
  wakeups,
  workflowRuns,
} from "@aaspai/db";

const ATTEMPT_LEASE_MS = 60 * 60_000;
const SCHEDULER_LOCK_TYPES: ResourceLock["resourceType"][] = [
  "organization_slot",
  "project_slot",
  "repository_slot",
  "agent_slot",
  "branch",
];

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
  repositoryIds?: string[];
  workKind?: ExecutionWorkItem["workKind"];
  deliveryMode?: ExecutionWorkItem["deliveryMode"];
  workflowRunId?: string | null;
  milestoneId?: string | null;
  processBindingId?: string | null;
  parentWorkItemId?: string | null;
  assignedAgentId?: string | null;
  alignmentRationale?: string;
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
  repositoryConcurrency?: number;
  agentConcurrency?: number;
  parentAttemptId?: string | null;
}

export interface CreateWorkflowRunInput {
  id?: string;
  organizationId: string;
  goalId: string;
  definitionRevisionId: string;
  processDefinitionHash?: string | null;
  stateVersion?: number;
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
  wakeupId?: string;
  parentSessionId?: string;
}

export interface HarnessSessionStart {
  durableSessionId?: string;
  wakeupId?: string;
  parentSessionId?: string;
  resumeSessionId?: string;
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
  agentId?: string;
  idempotencyKey?: string;
  prompt: string;
  timeoutMs?: number | null;
  harnessConfig?: Record<string, unknown>;
  workspacePolicy?: {
    restore?: "none" | "changes" | "all";
    cleanup?: "always" | "retain_on_failure";
  };
  runtimeConfig?: Record<string, unknown>;
  profile?: ResolvedAgentProfile;
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

  get database(): SqliteDb {
    return this.db;
  }

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

  async getProject(projectId: string, context?: ExecutionContext): Promise<Project | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        context
          ? and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId))
          : eq(projects.id, projectId),
      )
      .limit(1);
    return rows[0] ? projectSchema.parse(rows[0]) : null;
  }

  async getGoal(goalId: string, context?: ExecutionContext): Promise<Goal | null> {
    const rows = await this.db
      .select()
      .from(goals)
      .where(
        context
          ? and(eq(goals.id, goalId), eq(goals.organizationId, context.organizationId))
          : eq(goals.id, goalId),
      )
      .limit(1);
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

  async getRepository(id: string, context?: ExecutionContext): Promise<Repository | null> {
    const rows = await this.db
      .select()
      .from(repositories)
      .where(
        context
          ? and(eq(repositories.id, id), eq(repositories.organizationId, context.organizationId))
          : eq(repositories.id, id),
      )
      .limit(1);
    return rows[0] ? repositorySchema.parse(rows[0]) : null;
  }

  async listRepositoriesForProject(
    projectId: string,
    context?: ExecutionContext,
  ): Promise<Repository[]> {
    const rows = await this.db
      .select()
      .from(repositories)
      .where(
        context
          ? and(
              eq(repositories.projectId, projectId),
              eq(repositories.organizationId, context.organizationId),
            )
          : eq(repositories.projectId, projectId),
      );
    return rows.map((row) => repositorySchema.parse(row));
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

  async getDefinitionRevision(
    id: string,
    context?: ExecutionContext,
  ): Promise<DefinitionRevision | null> {
    const rows = await this.db
      .select()
      .from(definitionRevisions)
      .where(
        context
          ? and(
              eq(definitionRevisions.id, id),
              eq(definitionRevisions.organizationId, context.organizationId),
            )
          : eq(definitionRevisions.id, id),
      )
      .limit(1);
    return rows[0] ? definitionRevisionSchema.parse(rows[0]) : null;
  }

  async createWorkItem(input: CreateWorkItemInput) {
    const workKind = input.workKind ?? "repository";
    const deliveryMode = input.deliveryMode ?? "commit";
    const governance = executionGovernanceSchema.parse(input.governance);
    if (!isDeliveryModeAllowed(workKind, deliveryMode)) {
      throw new Error(`${workKind} work cannot use ${deliveryMode} delivery`);
    }
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

    const context = {
      organizationId: input.organizationId,
      actorId: "execution-store",
      correlationId: input.idempotencyKey,
    };
    const [goal, project, repository, revision, workflow, milestone, binding, assignment, parent] =
      await Promise.all([
        this.getGoal(input.goalId, context),
        this.getProject(input.projectId, context),
        this.getRepository(input.repositoryId, context),
        input.definitionRevisionId
          ? this.getDefinitionRevision(input.definitionRevisionId, context)
          : null,
        input.workflowRunId ? this.getWorkflowRun(input.workflowRunId) : null,
        input.milestoneId
          ? this.db
              .select({ id: milestones.id, projectId: milestones.projectId })
              .from(milestones)
              .where(
                and(
                  eq(milestones.organizationId, input.organizationId),
                  eq(milestones.id, input.milestoneId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null,
        input.processBindingId
          ? this.db
              .select({ id: processBindings.id, projectId: processBindings.projectId })
              .from(processBindings)
              .where(
                and(
                  eq(processBindings.organizationId, input.organizationId),
                  eq(processBindings.id, input.processBindingId),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null,
        input.assignedAgentId && input.processBindingId
          ? this.db
              .select({ id: projectAssignments.id })
              .from(projectAssignments)
              .where(
                and(
                  eq(projectAssignments.organizationId, input.organizationId),
                  eq(projectAssignments.projectId, input.projectId),
                  eq(projectAssignments.agentId, input.assignedAgentId),
                  eq(projectAssignments.status, "active"),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null,
        input.parentWorkItemId ? this.getWorkItem(input.parentWorkItemId, context) : null,
      ]);
    if (!goal) throw new Error("WorkItem goal not found in organization");
    if (!project || project.goalId !== goal.id)
      throw new Error("WorkItem project is not aligned to its goal");
    if (!repository || (repository.projectId && repository.projectId !== project.id))
      throw new Error("WorkItem repository is not aligned to its project");
    if (input.definitionRevisionId && !revision)
      throw new Error("WorkItem definition revision is not in its organization");
    if (
      input.workflowRunId &&
      (!workflow || workflow.organizationId !== input.organizationId || workflow.goalId !== goal.id)
    )
      throw new Error("WorkItem workflow is not aligned to its goal");
    if (input.milestoneId && (!milestone || milestone.projectId !== project.id))
      throw new Error("WorkItem milestone is not aligned to its project");
    if (input.processBindingId && (!binding || binding.projectId !== project.id))
      throw new Error("WorkItem process binding is not aligned to its project");
    if (input.assignedAgentId && input.processBindingId && !assignment)
      throw new Error("WorkItem assigned agent is not active on its project");
    if (input.parentWorkItemId && !parent)
      throw new Error("WorkItem parent is not in its organization");

    const repositoryIds = [...new Set(input.repositoryIds ?? [input.repositoryId])];
    if (!repositoryIds.includes(input.repositoryId)) repositoryIds.unshift(input.repositoryId);
    if (repositoryIds.length > 32) {
      throw new Error("A WorkItem may reference at most 32 repositories");
    }

    const row = {
      id: input.id ?? makeId("work"),
      organizationId: input.organizationId,
      goalId: input.goalId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      repositoryIdsJson: JSON.stringify(repositoryIds),
      workKind,
      deliveryMode,
      deliveryStatus: "pending",
      deliveryRef: null,
      deliveryCommitSha: null,
      deliveryClaimOwner: null,
      deliveryLeaseExpiresAt: null,
      workflowRunId: input.workflowRunId ?? null,
      milestoneId: input.milestoneId ?? null,
      processBindingId: input.processBindingId ?? null,
      parentWorkItemId: input.parentWorkItemId ?? null,
      assignedAgentId: input.assignedAgentId ?? null,
      alignmentRationale: input.alignmentRationale ?? "",
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
      governanceJson: JSON.stringify(governance),
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
    // ponytail: bounded O(n²) DAG validation; replace with a persisted closure/index if graph size matters.
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

  async listWorkItemDependencies(
    workItemId: string,
    context?: ExecutionContext,
  ): Promise<ExecutionWorkItemDependency[]> {
    const rows = await this.db
      .select()
      .from(executionWorkItemDependencies)
      .where(
        context
          ? and(
              eq(executionWorkItemDependencies.workItemId, workItemId),
              eq(executionWorkItemDependencies.organizationId, context.organizationId),
            )
          : eq(executionWorkItemDependencies.workItemId, workItemId),
      );
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

  async listWorkItemsForWorkflow(
    organizationId: string,
    workflowRunId: string,
    status?: ExecutionWorkItem["status"],
  ): Promise<ExecutionWorkItem[]> {
    const rows = await this.db
      .select()
      .from(executionWorkItems)
      .where(
        and(
          eq(executionWorkItems.organizationId, organizationId),
          eq(executionWorkItems.workflowRunId, workflowRunId),
          ...(status ? [eq(executionWorkItems.status, status)] : []),
        ),
      );
    return rows.map((row) => parseWorkItem(row));
  }

  async assignWorkItemToWorkflow(
    workItemId: string,
    workflowRunId: string,
  ): Promise<ExecutionWorkItem | null> {
    await this.db
      .update(executionWorkItems)
      .set({ workflowRunId, updatedAt: now() })
      .where(
        and(
          eq(executionWorkItems.id, workItemId),
          or(
            isNull(executionWorkItems.workflowRunId),
            eq(executionWorkItems.workflowRunId, workflowRunId),
          ),
        ),
      );
    const item = await this.getWorkItem(workItemId);
    return item?.workflowRunId === workflowRunId ? item : null;
  }

  async updateWorkItemStatus(
    workItemId: string,
    status: ExecutionWorkItem["status"],
    options: { blockedReason?: string | null; retryAfter?: string | null } = {},
    context?: ExecutionContext,
  ): Promise<ExecutionWorkItem> {
    await this.db
      .update(executionWorkItems)
      .set({
        status,
        blockedReason: options.blockedReason ?? null,
        retryAfter: options.retryAfter ?? null,
        updatedAt: now(),
      })
      .where(
        context
          ? and(
              eq(executionWorkItems.id, workItemId),
              eq(executionWorkItems.organizationId, context.organizationId),
            )
          : eq(executionWorkItems.id, workItemId),
      );
    const updated = await this.getWorkItem(workItemId, context);
    if (!updated) throw new Error(`Work item ${workItemId} not found`);
    if (updated.workflowRunId) await this.reconcileWorkflowRun(updated.workflowRunId);
    return updated;
  }

  async getWorkItem(
    workItemId: string,
    context?: ExecutionContext,
  ): Promise<ExecutionWorkItem | null> {
    const rows = await this.db
      .select()
      .from(executionWorkItems)
      .where(
        context
          ? and(
              eq(executionWorkItems.id, workItemId),
              eq(executionWorkItems.organizationId, context.organizationId),
            )
          : eq(executionWorkItems.id, workItemId),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return parseWorkItem(row);
  }

  async createWorkflowRun(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
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
    if (existing[0]) return workflowRunSchema.parse(existing[0]);
    const row = {
      id: input.id ?? makeId("run"),
      organizationId: input.organizationId,
      goalId: input.goalId,
      definitionRevisionId: input.definitionRevisionId,
      processDefinitionHash: input.processDefinitionHash ?? null,
      stateVersion: input.stateVersion ?? 0,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
    } satisfies typeof workflowRuns.$inferInsert;
    await this.db.insert(workflowRuns).values(row);
    return workflowRunSchema.parse(row);
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
    const current = await this.getWorkflowRun(runId);
    if (!current) throw new Error(`Workflow run ${runId} not found`);
    const timestamp = now();
    const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
    await this.db
      .update(workflowRuns)
      .set({
        status,
        startedAt: status === "running" || terminal ? (current.startedAt ?? timestamp) : undefined,
        finishedAt: terminal ? timestamp : null,
      })
      .where(eq(workflowRuns.id, runId));
    const updated = await this.getWorkflowRun(runId);
    if (!updated) throw new Error(`Workflow run ${runId} disappeared`);
    return updated;
  }

  async reconcileWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const run = await this.getWorkflowRun(runId);
    if (!run || ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
      return run;
    }
    const items = await this.listWorkItemsForWorkflow(run.organizationId, run.id);
    if (
      items.length === 0 ||
      items.some((item) =>
        [
          "proposed",
          "ready",
          "claimed",
          "in_progress",
          "awaiting_verification",
          "awaiting_approval",
        ].includes(item.status),
      )
    ) {
      return run;
    }
    return await this.updateWorkflowRunStatus(
      run.id,
      items.every((item) => item.status === "completed") ? "succeeded" : "failed",
    );
  }

  async createAttempt(input: CreateAttemptInput) {
    if (input.parentAttemptId) {
      const parent = await this.getAttempt(input.parentAttemptId);
      if (!parent || parent.organizationId !== input.organizationId) {
        throw new Error("Parent attempt is not in the attempt organization");
      }
    }
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
      heartbeatAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      createdAt: now(),
    } satisfies typeof agentAttempts.$inferInsert;
    await this.db.insert(agentAttempts).values(row);
    return row;
  }

  async listAttemptsForWorkItem(
    workItemId: string,
    context?: ExecutionContext,
  ): Promise<AgentAttempt[]> {
    const rows = await this.db
      .select()
      .from(agentAttempts)
      .where(
        context
          ? and(
              eq(agentAttempts.workItemId, workItemId),
              eq(agentAttempts.organizationId, context.organizationId),
            )
          : eq(agentAttempts.workItemId, workItemId),
      )
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
    const matchesDispatch = (attempt: AgentAttempt) =>
      attempt.organizationId === workItem.organizationId &&
      attempt.agentId === input.agentId &&
      attempt.harness === input.harness &&
      attempt.workflowRunId === input.workflowRunId &&
      attempt.parentAttemptId === (input.parentAttemptId ?? null);
    const workflowRun = await this.getWorkflowRun(input.workflowRunId);
    if (
      !workflowRun ||
      workflowRun.organizationId !== workItem.organizationId ||
      workflowRun.goalId !== workItem.goalId ||
      (workItem.workflowRunId !== null && workItem.workflowRunId !== workflowRun.id)
    ) {
      return null;
    }
    if (workItem.assignedAgentId && workItem.assignedAgentId !== input.agentId) return null;
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
    if (active) return matchesDispatch(active) ? { attempt: active, created: false } : null;
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
        parentAttemptId: input.parentAttemptId ?? null,
      });
      created = agentAttemptSchema.parse(row);
    } catch (error) {
      if (!/unique constraint failed/i.test(String((error as Error)?.message ?? error)))
        throw error;
      const winner = (await this.listAttemptsForWorkItem(input.workItemId)).find((attempt) =>
        isActiveAttemptStatus(attempt.status),
      );
      return winner && matchesDispatch(winner) ? { attempt: winner, created: false } : null;
    }

    const slots = await this.acquireSchedulerSlots({
      organizationId: workItem.organizationId,
      projectId: workItem.projectId,
      repositoryIds: workItem.repositoryIds ?? [workItem.repositoryId],
      agentId: input.agentId,
      branchName: workItem.branchName,
      attemptId: created.id,
      organizationConcurrency: input.organizationConcurrency ?? 1,
      projectConcurrency: input.projectConcurrency ?? 1,
      repositoryConcurrency: input.repositoryConcurrency ?? 1,
      agentConcurrency: input.agentConcurrency ?? 1,
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
      return winner && matchesDispatch(winner) ? { attempt: winner, created: false } : null;
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

  /** Settle the crash window where session evidence is terminal but its attempt is still active. */
  async reconcileTerminalHarnessAttempt(
    workItemId: string,
  ): Promise<{ attempt: AgentAttempt; workItem: ExecutionWorkItem } | null> {
    const active = (await this.listAttemptsForWorkItem(workItemId)).find(
      (attempt) =>
        ["preparing", "running", "cancelling"].includes(attempt.status) && attempt.harnessSessionId,
    );
    if (!active?.harnessSessionId) return null;
    const session = await this.getHarnessSession(active.harnessSessionId);
    if (!session || !["succeeded", "failed", "cancelled", "timed_out"].includes(session.status)) {
      return null;
    }
    return await this.completeScheduledAttempt({
      attemptId: active.id,
      status: session.status as "succeeded" | "failed" | "cancelled" | "timed_out",
      error: session.errorMessage,
      retryDelayMs: 0,
    });
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
      const existingWorkItem = await this.getWorkItem(current.workItemId);
      if (!existingWorkItem) throw new Error(`Work item ${current.workItemId} not found`);
      const budgetBreaches = await this.settleBudgetReservations(
        input.attemptId,
        existingWorkItem,
        input.usage,
      );
      await this.releaseSchedulerLocks(current.id);
      if (["claimed", "in_progress"].includes(existingWorkItem.status)) {
        if (current.status === "succeeded") {
          if (budgetBreaches.length > 0) {
            const blocked = await this.updateWorkItemStatus(existingWorkItem.id, "blocked", {
              blockedReason: budgetBreaches.join("; "),
            });
            return { attempt: current, workItem: blocked };
          }
          await this.advanceSuccessfulWorkItem(existingWorkItem, current.id);
          const advanced = await this.getWorkItem(existingWorkItem.id);
          if (!advanced) throw new Error("Successful WorkItem disappeared");
          return { attempt: current, workItem: advanced };
        }
        if (
          ["failed", "timed_out"].includes(current.status) &&
          current.attemptNumber < existingWorkItem.maxAttempts
        ) {
          const retryAfter = new Date(
            Date.now() + Math.max(0, input.retryDelayMs ?? 1_000),
          ).toISOString();
          const ready = await this.updateWorkItemStatus(existingWorkItem.id, "ready", {
            retryAfter,
            blockedReason: null,
          });
          return { attempt: current, workItem: ready };
        }
        const workItemStatus = current.status === "cancelled" ? "cancelled" : "failed";
        const settled = await this.updateWorkItemStatus(current.workItemId, workItemStatus, {
          blockedReason: input.error ?? `${current.status} without retry eligibility`,
        });
        return { attempt: current, workItem: settled };
      }
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
    const budgetBreaches = await this.settleBudgetReservations(input.attemptId, item, input.usage);
    if (input.status === "succeeded") {
      if (budgetBreaches.length > 0) {
        await this.updateWorkItemStatus(item.id, "blocked", {
          blockedReason: budgetBreaches.join("; "),
        });
      } else {
        await this.advanceSuccessfulWorkItem(item, current.id);
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
    if (maker.agentId === input.agentId)
      throw new Error("Checker agent must be independent from the maker");
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
    if (current?.role !== "checker") throw new Error(`Checker attempt ${attemptId} not found`);
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
    if (verification.status !== "pending") throw new Error("Verification is no longer pending");
    const checker = await this.getAttempt(input.checkerAttemptId);
    if (checker?.role !== "checker" || checker.verificationId !== verification.id) {
      throw new Error("Checker attempt does not belong to verification");
    }
    const currentWorkItem = await this.getWorkItem(verification.workItemId);
    if (!currentWorkItem) throw new Error(`Work item ${verification.workItemId} not found`);
    if (!isTerminalAttemptStatus(checker.status)) {
      throw new Error("Checker attempt must finish before verification is submitted");
    }
    if (input.status === "passed" && checker.status !== "succeeded") {
      throw new Error("A failed checker attempt cannot pass verification");
    }
    const evidenceIds = [...new Set(input.evidenceIds ?? [])];
    const artifacts = await this.listArtifacts(checker.id);
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
    if (evidenceIds.some((id) => !artifactIds.has(id))) {
      throw new Error("Verification evidence must belong to the checker attempt");
    }
    if (
      input.status === "passed" &&
      currentWorkItem.governance.verification.minEvidence > evidenceIds.length
    ) {
      throw new Error("Verification requires more evidence");
    }
    await this.db
      .update(executionVerifications)
      .set({
        checkerAttemptId: checker.id,
        status: input.status,
        summary: input.summary,
        evidenceIdsJson: JSON.stringify(evidenceIds),
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
        evidenceIds,
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
        await this.finalizeWorkItem(currentWorkItem.id);
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
    const decidedAt = now();
    const outcome = this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(executionApprovals)
        .where(eq(executionApprovals.id, input.approvalId))
        .limit(1)
        .get();
      if (!current) throw new Error(`Approval ${input.approvalId} not found`);
      if (current.status !== "requested") throw new Error("Approval is no longer requested");
      if (current.expiresAt && current.expiresAt <= decidedAt) {
        tx.update(executionApprovals)
          .set({ status: "expired", decidedAt })
          .where(
            and(eq(executionApprovals.id, current.id), eq(executionApprovals.status, "requested")),
          )
          .run();
        return { expired: true as const, workItemId: current.workItemId };
      }
      if (current.actorType !== input.actorType) {
        throw new Error("Approval actor type is not authorized");
      }
      const workItem = tx
        .select()
        .from(executionWorkItems)
        .where(eq(executionWorkItems.id, current.workItemId))
        .limit(1)
        .get();
      if (!workItem) throw new Error(`Work item ${current.workItemId} not found`);
      if (workItem.status !== "awaiting_approval") {
        throw new Error("Work item is not awaiting approval");
      }
      if (
        (workItem.deliveryMode === "commit" || workItem.deliveryMode === "pull_request") &&
        !workItem.deliveryCommitSha
      ) {
        throw new Error(`${workItem.deliveryMode} delivery requires maker commit evidence`);
      }
      if (workItem.deliveryMode === "artifact") {
        const persistedArtifact = workItem.claimedByAttemptId
          ? tx
              .select({ id: artifacts.id, kind: artifacts.kind })
              .from(artifacts)
              .where(eq(artifacts.attemptId, workItem.claimedByAttemptId))
              .all()
              .find((artifact) => !["result", "patch"].includes(artifact.kind))
          : null;
        if (!persistedArtifact) {
          throw new Error("Artifact delivery requires a persisted artifact");
        }
      }
      const changedApproval = tx
        .update(executionApprovals)
        .set({
          status: input.status,
          actorId: input.actorId,
          reason: input.reason ?? "",
          decidedAt,
        })
        .where(
          and(
            eq(executionApprovals.id, current.id),
            eq(executionApprovals.status, "requested"),
            eq(executionApprovals.actorType, input.actorType),
          ),
        )
        .returning({ id: executionApprovals.id })
        .all();
      if (changedApproval.length !== 1) throw new Error("Approval is no longer requested");
      const approved = input.status === "approved";
      const changedWorkItem = tx
        .update(executionWorkItems)
        .set(
          approved
            ? {
                status: "completed",
                blockedReason: null,
                deliveryStatus: workItem.deliveryMode === "pull_request" ? "ready" : "delivered",
                updatedAt: decidedAt,
              }
            : {
                status: "blocked",
                blockedReason: input.reason ?? input.status,
                updatedAt: decidedAt,
              },
        )
        .where(
          and(
            eq(executionWorkItems.id, current.workItemId),
            eq(executionWorkItems.status, "awaiting_approval"),
          ),
        )
        .returning({ id: executionWorkItems.id })
        .all();
      if (changedWorkItem.length !== 1) throw new Error("Work item is not awaiting approval");
      tx.insert(executionGovernanceEvents)
        .values({
          id: makeId("governance"),
          organizationId: current.organizationId,
          workItemId: current.workItemId,
          attemptId: null,
          action: `approval.${input.status}`,
          decision: approved ? "allowed" : "denied",
          reason: input.reason ?? input.status,
          metadataJson: JSON.stringify({
            approvalId: current.id,
            actorId: input.actorId,
            actorType: input.actorType,
          }),
          occurredAt: decidedAt,
        })
        .run();
      return { expired: false as const, workItemId: current.workItemId };
    });
    if (outcome.expired) throw new Error("Approval has expired");
    const approval = await this.getApproval(input.approvalId);
    const updatedWorkItem = await this.getWorkItem(outcome.workItemId);
    if (!approval || !updatedWorkItem) throw new Error("Approval decision disappeared");
    if (updatedWorkItem.workflowRunId)
      await this.reconcileWorkflowRun(updatedWorkItem.workflowRunId);
    return { approval, workItem: updatedWorkItem };
  }

  private async advanceSuccessfulWorkItem(
    item: ExecutionWorkItem,
    makerAttemptId: string,
  ): Promise<void> {
    if (item.governance.verification.required) {
      const verification = await this.createVerification({
        organizationId: item.organizationId,
        workItemId: item.id,
        makerAttemptId,
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
      await this.finalizeWorkItem(item.id);
    }
  }

  private async finalizeWorkItem(workItemId: string): Promise<void> {
    const item = await this.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);
    if (
      (item.deliveryMode === "commit" || item.deliveryMode === "pull_request") &&
      !item.deliveryCommitSha
    ) {
      throw new Error(`${item.deliveryMode} delivery requires maker commit evidence`);
    }
    if (item.deliveryMode === "artifact") {
      const claim = (
        await this.db
          .select({ attemptId: executionWorkItems.claimedByAttemptId })
          .from(executionWorkItems)
          .where(eq(executionWorkItems.id, item.id))
          .limit(1)
      )[0];
      const persistedArtifacts = claim?.attemptId ? await this.listArtifacts(claim.attemptId) : [];
      if (!persistedArtifacts.some((artifact) => !["result", "patch"].includes(artifact.kind))) {
        throw new Error("Artifact delivery requires a persisted artifact");
      }
    }
    const deliveryStatus = item.deliveryMode === "pull_request" ? "ready" : "delivered";
    await this.db
      .update(executionWorkItems)
      .set({
        status: "completed",
        blockedReason: null,
        deliveryStatus,
        updatedAt: now(),
      })
      .where(eq(executionWorkItems.id, workItemId));
    if (item.workflowRunId) await this.reconcileWorkflowRun(item.workflowRunId);
  }

  async recordDeliveryCommit(
    workItemId: string,
    makerAttemptId: string,
    commitSha: string,
    branchName?: string,
  ): Promise<ExecutionWorkItem> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha))
      throw new Error("Commit SHA is invalid");
    if (branchName !== undefined && (!branchName.trim() || branchName.length > 256)) {
      throw new Error("Delivery branch name is invalid");
    }
    const attempt = await this.getAttempt(makerAttemptId);
    if (!attempt || attempt.workItemId !== workItemId || attempt.role !== "maker") {
      throw new Error("Commit evidence must come from the work item's maker attempt");
    }
    const current = (
      await this.db
        .select()
        .from(executionWorkItems)
        .where(eq(executionWorkItems.id, workItemId))
        .limit(1)
    )[0];
    if (!current) throw new Error(`Work item ${workItemId} not found`);
    if (current.claimedByAttemptId !== makerAttemptId) {
      throw new Error("Commit evidence must come from the currently claimed maker attempt");
    }
    if (!["commit", "pull_request"].includes(current.deliveryMode)) {
      throw new Error("Commit evidence is not valid for this delivery mode");
    }
    if (current.deliveryCommitSha && current.deliveryCommitSha !== commitSha) {
      throw new Error("Maker commit evidence is immutable");
    }
    if (current.branchName && branchName && current.branchName !== branchName) {
      throw new Error("Maker delivery branch is immutable");
    }
    if (!current.deliveryCommitSha) {
      await this.db
        .update(executionWorkItems)
        .set({
          deliveryCommitSha: commitSha,
          branchName: current.branchName ?? branchName ?? null,
          updatedAt: now(),
        })
        .where(
          and(eq(executionWorkItems.id, workItemId), isNull(executionWorkItems.deliveryCommitSha)),
        );
    }
    const updated = await this.getWorkItem(workItemId);
    if (!updated || updated.deliveryCommitSha !== commitSha) {
      throw new Error("Maker commit evidence is immutable");
    }
    return updated;
  }

  async completeDelivery(input: {
    workItemId: string;
    ownerId: string;
    status: "delivered" | "failed";
    ref?: string | null;
    error?: string | null;
  }): Promise<ExecutionWorkItem> {
    const changed = await this.db
      .update(executionWorkItems)
      .set({
        deliveryStatus: input.status,
        deliveryRef: input.ref ?? null,
        deliveryClaimOwner: null,
        deliveryLeaseExpiresAt: null,
        blockedReason: input.status === "failed" ? (input.error ?? "delivery failed") : null,
        updatedAt: now(),
      })
      .where(
        and(
          eq(executionWorkItems.id, input.workItemId),
          eq(executionWorkItems.deliveryStatus, "delivering"),
          eq(executionWorkItems.deliveryClaimOwner, input.ownerId),
        ),
      )
      .returning({ id: executionWorkItems.id });
    if (changed.length !== 1) throw new Error("Delivery is not actively claimed");
    const item = await this.getWorkItem(input.workItemId);
    if (!item) throw new Error(`Work item ${input.workItemId} not found`);
    return item;
  }

  async claimDelivery(workItemId: string, leaseMs = 60_000): Promise<ExecutionWorkItem | null> {
    const claimedAt = now();
    const ownerId = `delivery_${randomUUID()}`;
    const changed = await this.db
      .update(executionWorkItems)
      .set({
        deliveryStatus: "delivering",
        deliveryClaimOwner: ownerId,
        deliveryLeaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(executionWorkItems.id, workItemId),
          or(
            inArray(executionWorkItems.deliveryStatus, ["ready", "failed"]),
            and(
              eq(executionWorkItems.deliveryStatus, "delivering"),
              or(
                isNull(executionWorkItems.deliveryLeaseExpiresAt),
                lte(executionWorkItems.deliveryLeaseExpiresAt, claimedAt),
              ),
            ),
          ),
        ),
      )
      .returning({ id: executionWorkItems.id });
    return changed.length === 1 ? await this.getWorkItem(workItemId) : null;
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

  async claimExternalAction(input: {
    organizationId: string;
    workItemId: string;
    connector: string;
    operation: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    leaseMs?: number;
  }): Promise<{
    action: typeof executionExternalActions.$inferSelect;
    created: boolean;
    disposition: "acquired" | "in_progress" | "replay";
    ownerId: string | null;
  }> {
    const ownerId = randomUUID();
    const claimedAt = now();
    const leaseExpiresAt = new Date(
      Date.now() + Math.max(1_000, Math.min(input.leaseMs ?? 60_000, 300_000)),
    ).toISOString();
    const fingerprint = externalActionFingerprint(input);
    const row = {
      id: makeId("external_action"),
      organizationId: input.organizationId,
      workItemId: input.workItemId,
      connector: input.connector,
      operation: input.operation,
      payloadJson: JSON.stringify(input.payload),
      fingerprint,
      idempotencyKey: input.idempotencyKey,
      status: "running",
      claimOwner: ownerId,
      leaseExpiresAt,
      resultJson: null,
      error: null,
      createdAt: claimedAt,
      completedAt: null,
    } satisfies typeof executionExternalActions.$inferInsert;
    try {
      await this.db.insert(executionExternalActions).values(row);
      return { action: row, created: true, disposition: "acquired", ownerId };
    } catch (error) {
      if (!/unique constraint failed/i.test(String(error))) throw error;
      let existing = (
        await this.db
          .select()
          .from(executionExternalActions)
          .where(
            and(
              eq(executionExternalActions.organizationId, input.organizationId),
              eq(executionExternalActions.connector, input.connector),
              eq(executionExternalActions.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw error;
      const existingFingerprint =
        existing.fingerprint ||
        externalActionFingerprint({
          organizationId: existing.organizationId,
          workItemId: existing.workItemId,
          connector: existing.connector,
          operation: existing.operation,
          payload: safeRecord(existing.payloadJson),
        });
      if (existingFingerprint !== fingerprint) {
        throw new ExternalActionConflictError(
          "Idempotency key is already bound to a different external action",
        );
      }
      if (existing.status === "succeeded") {
        return { action: existing, created: false, disposition: "replay", ownerId: null };
      }
      if (
        existing.status === "running" &&
        existing.leaseExpiresAt &&
        existing.leaseExpiresAt > claimedAt
      ) {
        return { action: existing, created: false, disposition: "in_progress", ownerId: null };
      }
      const changed = await this.db
        .update(executionExternalActions)
        .set({
          status: "running",
          fingerprint,
          claimOwner: ownerId,
          leaseExpiresAt,
          resultJson: null,
          error: null,
          completedAt: null,
        })
        .where(
          and(
            eq(executionExternalActions.id, existing.id),
            or(
              inArray(executionExternalActions.status, ["pending", "failed"]),
              and(
                eq(executionExternalActions.status, "running"),
                or(
                  isNull(executionExternalActions.leaseExpiresAt),
                  lte(executionExternalActions.leaseExpiresAt, claimedAt),
                ),
              ),
            ),
          ),
        )
        .returning()
        .all();
      if (changed[0]) {
        return {
          action: changed[0],
          created: false,
          disposition: "acquired",
          ownerId,
        };
      }
      existing = (
        await this.db
          .select()
          .from(executionExternalActions)
          .where(eq(executionExternalActions.id, existing.id))
          .limit(1)
      )[0];
      if (!existing) throw new Error("External action claim disappeared");
      return {
        action: existing,
        created: false,
        disposition: existing.status === "succeeded" ? "replay" : "in_progress",
        ownerId: null,
      };
    }
  }

  async completeExternalAction(
    id: string,
    ownerId: string,
    outcome:
      | { status: "succeeded"; result: Record<string, unknown> }
      | { status: "failed"; error: string },
  ): Promise<typeof executionExternalActions.$inferSelect> {
    const changed = await this.db
      .update(executionExternalActions)
      .set({
        status: outcome.status,
        claimOwner: null,
        leaseExpiresAt: null,
        resultJson: outcome.status === "succeeded" ? JSON.stringify(outcome.result) : null,
        error: outcome.status === "failed" ? outcome.error : null,
        completedAt: now(),
      })
      .where(
        and(
          eq(executionExternalActions.id, id),
          eq(executionExternalActions.status, "running"),
          eq(executionExternalActions.claimOwner, ownerId),
        ),
      )
      .returning()
      .all();
    if (!changed[0]) throw new Error("External action claim is no longer owned by this request");
    return changed[0];
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
          const dayStart = new Date();
          dayStart.setUTCHours(0, 0, 0, 0);
          const rows = tx
            .select()
            .from(executionBudgetReservations)
            .where(
              and(
                eq(executionBudgetReservations.organizationId, workItem.organizationId),
                eq(executionBudgetReservations.scope, limit.scope),
                eq(executionBudgetReservations.scopeId, scopeId),
                inArray(executionBudgetReservations.status, ["reserved", "settled"]),
                limit.scope === "loop"
                  ? gte(executionBudgetReservations.createdAt, dayStart.toISOString())
                  : undefined,
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
          const estimate =
            limit.scope === "attempt"
              ? { tokens: limit.tokens, costUsd: limit.costUsd }
              : budgetEstimate(workItem.metadata);
          if (
            (limit.tokens > 0 && tokens + estimate.tokens > limit.tokens) ||
            (limit.costUsd > 0 && costUsd + estimate.costUsd > limit.costUsd) ||
            (limit.runs > 0 && runs + 1 > limit.runs)
          ) {
            throw new BudgetExhaustedError(`budget exhausted for ${limit.scope}:${scopeId}`);
          }
          const projectedRatio = Math.max(
            limit.tokens > 0 ? (tokens + estimate.tokens) / limit.tokens : 0,
            limit.costUsd > 0 ? (costUsd + estimate.costUsd) / limit.costUsd : 0,
            limit.runs > 0 ? (runs + 1) / limit.runs : 0,
          );
          if (projectedRatio >= workItem.governance.budget.soft) {
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
              reservedTokens: estimate.tokens,
              reservedCostUsd: estimate.costUsd,
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
    workItem: ExecutionWorkItem,
    usage?: { tokens?: number; costUsd?: number },
  ): Promise<string[]> {
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
    const attemptReservations = await this.db
      .select()
      .from(executionBudgetReservations)
      .where(eq(executionBudgetReservations.attemptId, attemptId));
    const breaches: string[] = [];
    for (const reservation of attemptReservations) {
      const limit = workItem.governance.budget.limits.find(
        (candidate) => candidate.scope === reservation.scope,
      );
      if (!limit) continue;
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const rows = await this.db
        .select()
        .from(executionBudgetReservations)
        .where(
          and(
            eq(executionBudgetReservations.organizationId, reservation.organizationId),
            eq(executionBudgetReservations.scope, reservation.scope),
            eq(executionBudgetReservations.scopeId, reservation.scopeId),
            inArray(executionBudgetReservations.status, ["reserved", "settled"]),
            reservation.scope === "loop"
              ? gte(executionBudgetReservations.createdAt, dayStart.toISOString())
              : undefined,
          ),
        );
      const tokens = rows.reduce(
        (sum, row) => sum + (row.status === "reserved" ? row.reservedTokens : row.actualTokens),
        0,
      );
      const costUsd = rows.reduce(
        (sum, row) => sum + (row.status === "reserved" ? row.reservedCostUsd : row.actualCostUsd),
        0,
      );
      const runs = rows.reduce((sum, row) => sum + row.reservedRuns, 0);
      if (
        (limit.tokens > 0 && tokens > limit.tokens) ||
        (limit.costUsd > 0 && costUsd > limit.costUsd) ||
        (limit.runs > 0 && runs > limit.runs)
      ) {
        breaches.push(`actual budget exceeded for ${reservation.scope}:${reservation.scopeId}`);
      }
    }
    for (const reason of [...new Set(breaches)]) {
      await this.recordGovernanceEvent({
        organizationId: workItem.organizationId,
        workItemId: workItem.id,
        attemptId,
        action: "budget.settle",
        decision: "denied",
        reason,
      });
    }
    return [...new Set(breaches)];
  }

  private async acquireSchedulerSlots(input: {
    organizationId: string;
    projectId: string;
    repositoryIds: string[];
    agentId: string;
    branchName: string | null;
    attemptId: string;
    organizationConcurrency: number;
    projectConcurrency: number;
    repositoryConcurrency: number;
    agentConcurrency: number;
  }): Promise<ResourceLock[] | null> {
    const leaseExpiresAt = new Date(Date.now() + ATTEMPT_LEASE_MS).toISOString();
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
    for (const repositoryId of input.repositoryIds) {
      if (
        !(await acquire(
          "repository_slot",
          `repository:${repositoryId}`,
          input.repositoryConcurrency,
        ))
      ) {
        await this.releaseSchedulerLocks(input.attemptId);
        return null;
      }
      if (input.branchName) {
        const branchLock = await this.acquireResourceLock({
          organizationId: input.organizationId,
          resourceType: "branch",
          resourceId: `${repositoryId}:${input.branchName}`,
          ownerAttemptId: input.attemptId,
          leaseExpiresAt,
        });
        if (!branchLock) {
          await this.releaseSchedulerLocks(input.attemptId);
          return null;
        }
        acquired.push(branchLock);
      }
    }
    if (!(await acquire("agent_slot", `agent:${input.agentId}`, input.agentConcurrency))) {
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
          inArray(resourceLocks.resourceType, SCHEDULER_LOCK_TYPES),
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

  /**
   * Build the company operating read model from durable execution state.
   * This is intentionally a projection: it cannot mutate work, bypass
   * governance, or infer progress from prompts or agent claims.
   */
  async getCompanyHealth(organizationId: string): Promise<CompanyHealth> {
    const [
      goalRows,
      projectRows,
      workItemRows,
      attemptRows,
      approvalRows,
      verificationRows,
      budgetRows,
    ] = await Promise.all([
      this.db.select().from(goals).where(eq(goals.organizationId, organizationId)),
      this.db.select().from(projects).where(eq(projects.organizationId, organizationId)),
      this.db
        .select()
        .from(executionWorkItems)
        .where(eq(executionWorkItems.organizationId, organizationId)),
      this.db.select().from(agentAttempts).where(eq(agentAttempts.organizationId, organizationId)),
      this.db
        .select()
        .from(executionApprovals)
        .where(eq(executionApprovals.organizationId, organizationId)),
      this.db
        .select()
        .from(executionVerifications)
        .where(eq(executionVerifications.organizationId, organizationId)),
      this.db
        .select()
        .from(executionBudgetReservations)
        .where(eq(executionBudgetReservations.organizationId, organizationId)),
    ]);
    const workItems = workItemRows.map((row) => parseWorkItem(row));
    const generatedAt = new Date().toISOString();
    const completedWork = workItems.filter((item) => item.status === "completed").length;
    const activeWork = workItems.filter((item) =>
      ["claimed", "in_progress"].includes(item.status),
    ).length;
    const blockedWork = workItems.filter((item) => item.status === "blocked").length;
    const failedWork = workItems.filter((item) => item.status === "failed").length;
    const runningAttempts = attemptRows.filter((attempt) =>
      ["queued", "preparing", "running", "cancelling"].includes(attempt.status),
    ).length;
    const failedAttempts = attemptRows.filter((attempt) =>
      ["failed", "timed_out", "lost"].includes(attempt.status),
    ).length;
    const terminalAttempts = attemptRows.filter((attempt) =>
      ["succeeded", "failed", "timed_out", "cancelled", "lost"].includes(attempt.status),
    );
    const successfulAttempts = terminalAttempts.filter(
      (attempt) => attempt.status === "succeeded",
    ).length;
    const pendingApprovals = approvalRows.filter(
      (approval) => approval.status === "requested",
    ).length;
    const pendingVerifications = verificationRows.filter(
      (verification) => verification.status === "pending",
    ).length;
    const overdueWork = workItems.filter(
      (item) =>
        item.deadlineAt !== null &&
        item.deadlineAt < generatedAt &&
        !["completed", "cancelled"].includes(item.status),
    ).length;
    const completionPercent = percent(completedWork, workItems.length);
    const reliabilityPercent = percent(successfulAttempts, terminalAttempts.length);
    const signals: CompanyHealth["signals"] = [];
    if (blockedWork > 0) {
      signals.push({
        code: "blocked_work",
        severity: blockedWork >= 3 ? "critical" : "warning",
        title: "Blocked work needs intervention",
        detail: `${blockedWork} work item${blockedWork === 1 ? " is" : "s are"} blocked by policy, dependency, or execution state.`,
        count: blockedWork,
      });
    }
    if (failedAttempts > 0 || failedWork > 0) {
      const count = failedAttempts + failedWork;
      signals.push({
        code: "failed_attempts",
        severity: failedAttempts >= 3 ? "critical" : "warning",
        title: "Execution reliability needs attention",
        detail: `${count} failed or timed-out execution outcome${count === 1 ? "" : "s"} recorded.`,
        count,
      });
    }
    if (pendingApprovals + pendingVerifications > 0) {
      const count = pendingApprovals + pendingVerifications;
      signals.push({
        code: "pending_governance",
        severity: "warning",
        title: "Governance decisions are waiting",
        detail: `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} and ${pendingVerifications} verification${pendingVerifications === 1 ? " is" : "s are"} pending.`,
        count,
      });
    }
    if (overdueWork > 0) {
      signals.push({
        code: "overdue_work",
        severity: "critical",
        title: "Work is past its deadline",
        detail: `${overdueWork} incomplete work item${overdueWork === 1 ? " is" : "s are"} past the recorded deadline.`,
        count: overdueWork,
      });
    }

    const score = Math.max(
      0,
      Math.min(
        100,
        100 -
          Math.min(40, blockedWork * 15) -
          Math.min(25, failedAttempts * 10) -
          Math.min(15, overdueWork * 10) -
          Math.min(10, (pendingApprovals + pendingVerifications) * 3),
      ),
    );
    const status = signals.some((signal) => signal.severity === "critical")
      ? "critical"
      : signals.length > 0 || score < 80
        ? "at_risk"
        : "healthy";
    const goalsHealth = goalRows.map((goal) => {
      const items = workItems.filter((item) => item.goalId === goal.id);
      const goalProjects = projectRows.filter((project) => project.goalId === goal.id);
      const goalCompleted = items.filter((item) => item.status === "completed").length;
      return {
        id: goal.id,
        title: goal.title,
        status: goal.status,
        projectCount: goalProjects.length,
        totalWork: items.length,
        completedWork: goalCompleted,
        blockedWork: items.filter((item) => item.status === "blocked").length,
        failedWork: items.filter((item) => item.status === "failed").length,
        completionPercent: percent(goalCompleted, items.length),
      };
    });
    const projectsHealth = projectRows.map((project) => {
      const items = workItems.filter((item) => item.projectId === project.id);
      const projectCompleted = items.filter((item) => item.status === "completed").length;
      return {
        id: project.id,
        goalId: project.goalId,
        title: project.title,
        status: project.status,
        totalWork: items.length,
        completedWork: projectCompleted,
        activeWork: items.filter((item) => ["claimed", "in_progress"].includes(item.status)).length,
        blockedWork: items.filter((item) => item.status === "blocked").length,
        failedWork: items.filter((item) => item.status === "failed").length,
        completionPercent: percent(projectCompleted, items.length),
      };
    });
    return companyHealthSchema.parse({
      organizationId,
      generatedAt,
      status,
      score,
      totalGoals: goalRows.length,
      totalProjects: projectRows.length,
      totalWork: workItems.length,
      completedWork,
      activeWork,
      blockedWork,
      failedWork,
      totalAttempts: attemptRows.length,
      runningAttempts,
      failedAttempts,
      reliabilityPercent,
      completionPercent,
      pendingApprovals,
      pendingVerifications,
      overdueWork,
      actualCostUsd: budgetRows.reduce((sum, row) => sum + row.actualCostUsd, 0),
      reservedCostUsd: budgetRows.reduce((sum, row) => sum + row.reservedCostUsd, 0),
      actualTokens: budgetRows.reduce((sum, row) => sum + row.actualTokens, 0),
      reservedTokens: budgetRows.reduce((sum, row) => sum + row.reservedTokens, 0),
      signals,
      goals: goalsHealth,
      projects: projectsHealth,
    });
  }

  async resolveHarnessSessionStart(
    input: Pick<CreateHarnessSessionInput, "id" | "organizationId" | "agentId" | "adapter"> &
      Pick<HarnessSessionStart, "wakeupId" | "parentSessionId">,
  ): Promise<HarnessSessionStart> {
    if (!input.id) {
      return { wakeupId: input.wakeupId, parentSessionId: input.parentSessionId };
    }
    const existing = await this.getHarnessSession(input.id);
    if (!existing) {
      return {
        durableSessionId: input.id,
        wakeupId: input.wakeupId,
        parentSessionId: input.parentSessionId,
      };
    }
    if (
      existing.organizationId !== input.organizationId ||
      existing.agentId !== input.agentId ||
      existing.adapter !== input.adapter
    ) {
      throw new Error(`Harness session ${input.id} belongs to another execution identity`);
    }
    const [event] = await this.db
      .select({ id: harnessSessionEvents.id })
      .from(harnessSessionEvents)
      .where(eq(harnessSessionEvents.sessionId, existing.id))
      .limit(1);
    const pristine =
      existing.status === "queued" &&
      existing.startedAt === null &&
      existing.finishedAt === null &&
      existing.sessionId === null &&
      existing.sessionParamsJson === null &&
      existing.sessionDisplayId === null &&
      existing.resultJson === null &&
      existing.usageJson === null &&
      existing.costUsd === null &&
      existing.durationMs === null &&
      existing.errorFamily === null &&
      existing.errorCode === null &&
      existing.errorMessage === null &&
      existing.pendingQuestionJson === null &&
      !event;
    if (pristine) {
      return {
        durableSessionId: existing.id,
        wakeupId: existing.wakeupId,
        parentSessionId: existing.parentSessionId ?? undefined,
      };
    }
    return {
      wakeupId: existing.wakeupId,
      parentSessionId: existing.id,
      resumeSessionId: existing.sessionId ?? undefined,
    };
  }

  async createHarnessSession(input: CreateHarnessSessionInput) {
    const start = await this.resolveHarnessSessionStart(input);
    const id = start.durableSessionId ?? makeId("sess");
    const row = {
      id,
      organizationId: input.organizationId,
      wakeupId: start.wakeupId ?? "manual",
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
      parentSessionId: start.parentSessionId ?? null,
    } satisfies typeof harnessSessions.$inferInsert;
    const existing = start.durableSessionId ? await this.getHarnessSession(id) : null;
    if (existing) {
      const updated = await this.db
        .update(harnessSessions)
        .set({
          agentId: input.agentId,
          adapter: input.adapter,
          runtimeJson: row.runtimeJson,
          prompt: input.prompt,
          configJson: row.configJson,
          status: "running",
          sessionId: null,
          sessionParamsJson: null,
          sessionDisplayId: row.sessionDisplayId,
          resultJson: null,
          usageJson: null,
          costUsd: null,
          startedAt: row.startedAt,
          finishedAt: null,
          durationMs: null,
          errorFamily: null,
          errorCode: null,
          errorMessage: null,
          pendingQuestionJson: null,
        })
        .where(
          and(
            eq(harnessSessions.id, id),
            eq(harnessSessions.status, "queued"),
            isNull(harnessSessions.startedAt),
            isNull(harnessSessions.finishedAt),
            isNull(harnessSessions.sessionId),
            isNull(harnessSessions.sessionParamsJson),
            isNull(harnessSessions.sessionDisplayId),
            isNull(harnessSessions.resultJson),
            isNull(harnessSessions.usageJson),
            isNull(harnessSessions.costUsd),
            isNull(harnessSessions.durationMs),
            isNull(harnessSessions.errorFamily),
            isNull(harnessSessions.errorCode),
            isNull(harnessSessions.errorMessage),
            isNull(harnessSessions.pendingQuestionJson),
          ),
        )
        .returning({ id: harnessSessions.id });
      if (updated.length !== 1) {
        throw new Error(`Harness session ${id} changed before it could be activated`);
      }
    } else {
      await this.db.insert(harnessSessions).values(row as never);
    }
    return { ...row, inheritedProviderSessionId: start.resumeSessionId ?? null };
  }

  async linkHarnessSession(attemptId: string, harnessSessionId: string): Promise<AgentAttempt> {
    this.db.transaction((tx) => {
      const attempt = tx.select().from(agentAttempts).where(eq(agentAttempts.id, attemptId)).get();
      if (!attempt) throw new Error(`Agent attempt ${attemptId} not found`);
      const session = tx
        .select()
        .from(harnessSessions)
        .where(eq(harnessSessions.id, harnessSessionId))
        .get();
      if (!session) throw new Error(`Harness session ${harnessSessionId} not found`);
      if (
        session.organizationId !== attempt.organizationId ||
        session.agentId !== attempt.agentId ||
        session.adapter !== attempt.harness
      ) {
        throw new Error("Harness session execution identity does not match the attempt");
      }
      const owner = tx
        .select({ id: agentAttempts.id })
        .from(agentAttempts)
        .where(eq(agentAttempts.harnessSessionId, harnessSessionId))
        .limit(1)
        .get();
      if (owner && owner.id !== attemptId) {
        throw new Error(`Harness session ${harnessSessionId} is already linked to another attempt`);
      }
      if (attempt.harnessSessionId && attempt.harnessSessionId !== harnessSessionId) {
        throw new Error(`Agent attempt ${attemptId} is already linked to another harness session`);
      }
      if (!attempt.harnessSessionId) {
        tx.update(agentAttempts)
          .set({ harnessSessionId })
          .where(and(eq(agentAttempts.id, attemptId), isNull(agentAttempts.harnessSessionId)))
          .run();
      }
    });
    const attempt = await this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Agent attempt ${attemptId} disappeared`);
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

  async setHarnessSessionProviderIdentity(
    harnessSessionId: string,
    providerSessionId: string,
  ): Promise<void> {
    await this.db
      .update(harnessSessions)
      .set({
        sessionId: providerSessionId,
        sessionDisplayId: providerSessionId.slice(0, 12),
      })
      .where(
        and(
          eq(harnessSessions.id, harnessSessionId),
          or(isNull(harnessSessions.sessionId), eq(harnessSessions.sessionId, providerSessionId)),
        ),
      );
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

  async listHarnessSessionEvents(sessionId: string) {
    return await this.db
      .select()
      .from(harnessSessionEvents)
      .where(eq(harnessSessionEvents.sessionId, sessionId))
      .orderBy(asc(harnessSessionEvents.seq));
  }

  async completeHarnessSession(
    sessionId: string,
    result: AdapterExecutionResult,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
  ): Promise<void> {
    const finishedAt = now();
    const current = await this.getHarnessSession(sessionId);
    const startedAtMs = current?.startedAt ? Date.parse(current.startedAt) : Date.now();
    const providerSessionId = result.sessionId ?? current?.sessionId ?? null;
    const sessionDisplayId =
      result.sessionDisplayId ??
      current?.sessionDisplayId ??
      providerSessionId?.slice(0, 12) ??
      null;
    const normalized = {
      sessionId: providerSessionId ?? sessionId,
      sessionParams: result.sessionParams,
      sessionDisplayId,
      status,
      exitCode: result.exitCode,
      usage: result.usage,
      costUsd: result.costUsd,
      errorFamily: result.errorFamily,
      errorCode: result.errorCode,
      summary: result.summary,
      toolsInvoked: result.resultJson?.toolsInvoked ?? [],
      toolEventCount: result.resultJson?.toolEventCount ?? 0,
      logRef: sessionId,
    };
    await this.db
      .update(harnessSessions)
      .set({
        status,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - startedAtMs),
        sessionId: providerSessionId,
        sessionParamsJson: result.sessionParams ? JSON.stringify(result.sessionParams) : null,
        sessionDisplayId,
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
    const claimedAt = now();
    return this.db.transaction((tx) => {
      const workItem = tx
        .select()
        .from(executionWorkItems)
        .where(eq(executionWorkItems.id, workItemId))
        .get();
      const attempt = tx.select().from(agentAttempts).where(eq(agentAttempts.id, attemptId)).get();
      const workflowRun = attempt
        ? tx.select().from(workflowRuns).where(eq(workflowRuns.id, attempt.workflowRunId)).get()
        : null;
      if (
        !workItem ||
        !attempt ||
        !workflowRun ||
        attempt.status !== "queued" ||
        attempt.workItemId !== workItem.id ||
        attempt.organizationId !== workItem.organizationId ||
        workflowRun.organizationId !== attempt.organizationId ||
        workflowRun.goalId !== workItem.goalId ||
        (workItem.workflowRunId !== null && workItem.workflowRunId !== attempt.workflowRunId) ||
        (workItem.assignedAgentId !== null && workItem.assignedAgentId !== attempt.agentId)
      ) {
        return false;
      }
      const changed = tx
        .update(executionWorkItems)
        .set({
          status: "claimed",
          workflowRunId: attempt.workflowRunId,
          assignedAgentId: workItem.assignedAgentId ?? attempt.agentId,
          claimedByAttemptId: attemptId,
          claimedAt,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(executionWorkItems.id, workItemId),
            inArray(executionWorkItems.status, ["proposed", "ready"]),
            or(
              isNull(executionWorkItems.assignedAgentId),
              eq(executionWorkItems.assignedAgentId, attempt.agentId),
            ),
            or(
              isNull(executionWorkItems.workflowRunId),
              eq(executionWorkItems.workflowRunId, attempt.workflowRunId),
            ),
          ),
        )
        .returning({ id: executionWorkItems.id })
        .all();
      if (changed.length !== 1) return false;
      tx.update(workflowRuns)
        .set({ status: "running", startedAt: claimedAt })
        .where(and(eq(workflowRuns.id, attempt.workflowRunId), eq(workflowRuns.status, "queued")))
        .run();
      return true;
    });
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
    if (nextStatus === "running") {
      update.startedAt = timestamp;
      update.heartbeatAt = timestamp;
    }
    if (["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(nextStatus)) {
      update.finishedAt = timestamp;
    }
    const changed = await this.db
      .update(agentAttempts)
      .set(update)
      .where(and(eq(agentAttempts.id, attemptId), eq(agentAttempts.status, current.status)))
      .returning({ id: agentAttempts.id });
    if (changed.length !== 1) throw new Error("stale agent attempt transition");
    return { ...current, ...update };
  }

  /** Record executor liveness and extend the active resource leases owned by this attempt. */
  async heartbeatAttempt(attemptId: string, leaseMs = ATTEMPT_LEASE_MS): Promise<boolean> {
    const heartbeatAt = now();
    const leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
    return this.db.transaction((tx) => {
      const changed = tx
        .update(agentAttempts)
        .set({ heartbeatAt })
        .where(
          and(
            eq(agentAttempts.id, attemptId),
            inArray(agentAttempts.status, ["preparing", "running", "cancelling"]),
          ),
        )
        .returning({ id: agentAttempts.id })
        .all();
      if (changed.length !== 1) return false;
      tx.update(resourceLocks)
        .set({ leaseExpiresAt })
        .where(
          and(
            eq(resourceLocks.ownerAttemptId, attemptId),
            lte(resourceLocks.leaseExpiresAt, leaseExpiresAt),
            isNull(resourceLocks.releasedAt),
          ),
        )
        .run();
      return true;
    });
  }

  async getAttempt(attemptId: string, context?: ExecutionContext): Promise<AgentAttempt | null> {
    const rows = await this.db
      .select()
      .from(agentAttempts)
      .where(
        context
          ? and(
              eq(agentAttempts.id, attemptId),
              eq(agentAttempts.organizationId, context.organizationId),
            )
          : eq(agentAttempts.id, attemptId),
      )
      .limit(1);
    return rows[0] ? agentAttemptSchema.parse(rows[0]) : null;
  }

  private async getAttemptLastActivity(attempt: {
    heartbeatAt: string | null;
    startedAt: string | null;
    createdAt: string;
    harnessSessionId: string | null;
  }): Promise<string> {
    let lastActivity = attempt.heartbeatAt ?? attempt.startedAt ?? attempt.createdAt;
    if (attempt.harnessSessionId) {
      // ponytail: active attempts are few; replace the per-attempt lookup with
      // a grouped query if worker concurrency makes recovery measurable.
      const [latest] = await this.db
        .select({ ts: harnessSessionEvents.ts })
        .from(harnessSessionEvents)
        .where(eq(harnessSessionEvents.sessionId, attempt.harnessSessionId))
        .orderBy(desc(harnessSessionEvents.ts))
        .limit(1);
      if (latest?.ts && latest.ts > lastActivity) lastActivity = latest.ts;
    }
    return lastActivity;
  }

  private async findStaleAttempts(cutoff: string, organizationId?: string) {
    const candidates = await this.db
      .select()
      .from(agentAttempts)
      .where(
        organizationId
          ? and(
              eq(agentAttempts.organizationId, organizationId),
              inArray(agentAttempts.status, ["preparing", "running", "cancelling"]),
            )
          : inArray(agentAttempts.status, ["preparing", "running", "cancelling"]),
      );
    const stale: typeof candidates = [];
    for (const attempt of candidates) {
      const lastActivity = await this.getAttemptLastActivity(attempt);
      if (lastActivity <= cutoff) stale.push(attempt);
    }
    return stale;
  }

  async countStaleAttempts(cutoff: string, organizationId?: string): Promise<number> {
    return (await this.findStaleAttempts(cutoff, organizationId)).length;
  }

  async countStaleClaimedWakeups(cutoff: string, organizationId: string): Promise<number> {
    const candidates = await this.db
      .select()
      .from(wakeups)
      .where(and(eq(wakeups.organizationId, organizationId), eq(wakeups.status, "claimed")));
    let stale = 0;
    for (const wakeup of candidates) {
      if ((wakeup.heartbeatAt ?? wakeup.claimedAt ?? wakeup.requestedAt) > cutoff) continue;
      const workItemId = safeRecord(wakeup.payloadJson).workItemId;
      if (typeof workItemId === "string") {
        const [claim] = await this.db
          .select({ attemptId: executionWorkItems.claimedByAttemptId })
          .from(executionWorkItems)
          .where(
            and(
              eq(executionWorkItems.id, workItemId),
              eq(executionWorkItems.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (claim?.attemptId) {
          const [attempt] = await this.db
            .select()
            .from(agentAttempts)
            .where(
              and(
                eq(agentAttempts.id, claim.attemptId),
                eq(agentAttempts.organizationId, organizationId),
              ),
            )
            .limit(1);
          if (
            attempt &&
            ["preparing", "running", "cancelling"].includes(attempt.status) &&
            (await this.getAttemptLastActivity(attempt)) > cutoff
          ) {
            continue;
          }
        }
      }
      stale++;
    }
    return stale;
  }

  async reconcileLostAttempts(cutoff: string, organizationId?: string): Promise<number> {
    const candidates = await this.findStaleAttempts(cutoff, organizationId);
    let reconciled = 0;
    for (const attempt of candidates) {
      const changed = await this.db
        .update(agentAttempts)
        .set({ status: "lost", finishedAt: now() })
        .where(
          and(
            eq(agentAttempts.id, attempt.id),
            inArray(agentAttempts.status, ["preparing", "running", "cancelling"]),
            attempt.heartbeatAt
              ? eq(agentAttempts.heartbeatAt, attempt.heartbeatAt)
              : isNull(agentAttempts.heartbeatAt),
            attempt.harnessSessionId
              ? notExists(
                  this.db
                    .select({ id: harnessSessionEvents.id })
                    .from(harnessSessionEvents)
                    .where(
                      and(
                        eq(harnessSessionEvents.sessionId, attempt.harnessSessionId),
                        gt(harnessSessionEvents.ts, cutoff),
                      ),
                    ),
                )
              : undefined,
          ),
        )
        .returning({ id: agentAttempts.id });
      if (changed.length !== 1) continue;
      await this.db
        .update(resourceLocks)
        .set({ releasedAt: now() })
        .where(and(eq(resourceLocks.ownerAttemptId, attempt.id), isNull(resourceLocks.releasedAt)));
      reconciled++;
    }
    return reconciled;
  }

  async cancelAttempt(attemptId: string): Promise<AgentAttempt> {
    const current = await this.getAttempt(attemptId);
    if (!current) throw new Error(`Agent attempt ${attemptId} not found`);
    if (["succeeded", "failed", "cancelled", "timed_out", "lost"].includes(current.status)) {
      return current;
    }
    await this.requestCancelAttempt(attemptId);
    const cancelled = await this.getAttempt(attemptId);
    if (!cancelled) throw new Error(`Agent attempt ${attemptId} disappeared during cancellation`);
    return cancelled;
  }

  /** Persist intent first; the live runner moves cancelling to cancelled after process exit. */
  async requestCancelAttempt(attemptId: string): Promise<AgentAttempt> {
    const current = await this.getAttempt(attemptId);
    if (!current) throw new Error(`Agent attempt ${attemptId} not found`);
    if (isTerminalAttemptStatus(current.status)) return current;
    if (current.status === "queued") {
      await this.transitionAttempt(attemptId, "cancelled");
    } else if (current.status === "preparing" || current.status === "running") {
      await this.db
        .update(agentAttempts)
        .set({ cancelRequestedAt: now() })
        .where(eq(agentAttempts.id, attemptId));
      await this.transitionAttempt(attemptId, "cancelling");
    } else if (current.status === "cancelling") {
      await this.db
        .update(agentAttempts)
        .set({ cancelRequestedAt: current.cancelRequestedAt ?? now() })
        .where(eq(agentAttempts.id, attemptId));
    }
    const requested = await this.getAttempt(attemptId);
    if (!requested) throw new Error(`Agent attempt ${attemptId} disappeared during cancellation`);
    return requested;
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

  async reconcileExpiredLocks(at = now(), organizationId?: string): Promise<number> {
    const expired = await this.db
      .select({ id: resourceLocks.id })
      .from(resourceLocks)
      .where(
        and(
          ...(organizationId ? [eq(resourceLocks.organizationId, organizationId)] : []),
          lte(resourceLocks.leaseExpiresAt, at),
          isNull(resourceLocks.releasedAt),
        ),
      );
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
    const currentRow = await this.getWorkspace(workspaceId);
    if (!currentRow) throw new Error(`Execution workspace ${workspaceId} not found`);
    const current = executionWorkspaceSchema.parse(currentRow);
    const allowed: Record<ExecutionWorkspace["status"], readonly ExecutionWorkspace["status"][]> = {
      pending: ["creating", "failed", "ready"],
      creating: ["ready", "failed"],
      ready: ["releasing", "failed"],
      releasing: ["released", "failed"],
      released: [],
      failed: [],
    };
    if (current.status !== status && !allowed[current.status].includes(status)) {
      throw new Error(`Invalid execution workspace transition: ${current.status} -> ${status}`);
    }
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
    const attempt = await this.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Agent attempt ${input.attemptId} not found`);
    if (attempt.organizationId !== input.organizationId) {
      throw new Error("Execution plan organization does not match its attempt");
    }
    const existing = await this.db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.attemptId, input.attemptId))
      .limit(1);
    if (existing[0]) {
      const existingPlan = parsePlan(existing[0]);
      const requested = executionPlanSchema.parse({
        id: existingPlan.id,
        organizationId: input.organizationId,
        definitionRevisionId: input.definitionRevisionId,
        workItemId: input.workItemId,
        attemptId: input.attemptId,
        sourceSnapshot: input.sourceSnapshot,
        target: input.target,
        harness: input.harness,
        agentId: input.agentId ?? "unknown",
        idempotencyKey: input.idempotencyKey ?? `plan-${input.attemptId}`,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs ?? null,
        harnessConfig: input.harnessConfig ?? {},
        workspacePolicy: input.workspacePolicy ?? { restore: "changes", cleanup: "always" },
        runtimeConfig: input.runtimeConfig ?? {},
        profileHash: input.profile?.profileHash ?? "profile-unknown",
        profileSnapshot: input.profile ?? {},
        createdAt: existingPlan.createdAt,
      });
      if (JSON.stringify(existingPlan) !== JSON.stringify(requested)) {
        throw new Error(`Execution plan ${existingPlan.id} is immutable`);
      }
      return existingPlan;
    }
    const row = {
      id: input.id ?? makeId("plan"),
      organizationId: input.organizationId,
      definitionRevisionId: input.definitionRevisionId,
      workItemId: input.workItemId,
      attemptId: input.attemptId,
      sourceSnapshotJson: JSON.stringify(input.sourceSnapshot),
      targetJson: JSON.stringify(input.target),
      harness: input.harness,
      agentId: input.agentId ?? "unknown",
      idempotencyKey: input.idempotencyKey ?? `plan-${input.attemptId}`,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs ?? null,
      harnessConfigJson: JSON.stringify(input.harnessConfig ?? {}),
      workspacePolicyJson: JSON.stringify(
        input.workspacePolicy ?? { restore: "changes", cleanup: "always" },
      ),
      runtimeConfigJson: JSON.stringify(input.runtimeConfig ?? {}),
      profileHash: input.profile?.profileHash ?? "profile-unknown",
      profileSnapshotJson: JSON.stringify(input.profile ?? {}),
      createdAt: now(),
    } satisfies typeof executionPlans.$inferInsert;
    await this.db.insert(executionPlans).values(row);
    return parsePlan(row);
  }

  async getPlan(planId: string): Promise<ReturnType<typeof executionPlanSchema.parse> | null> {
    const rows = await this.db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.id, planId))
      .limit(1);
    return rows[0] ? parsePlan(rows[0]) : null;
  }

  async getPlanForAttempt(
    attemptId: string,
  ): Promise<ReturnType<typeof executionPlanSchema.parse> | null> {
    const rows = await this.db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.attemptId, attemptId))
      .limit(1);
    return rows[0] ? parsePlan(rows[0]) : null;
  }

  async appendEvent(input: AppendEventInput): Promise<ExecutionEvent> {
    const attempt = await this.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Agent attempt ${input.attemptId} not found`);
    if (attempt.organizationId !== input.organizationId) {
      throw new Error("Execution event organization does not match its attempt");
    }
    const previous = await this.db
      .select({ seq: executionEvents.seq })
      .from(executionEvents)
      .where(eq(executionEvents.attemptId, input.attemptId))
      .orderBy(desc(executionEvents.seq))
      .limit(1);
    if (previous[0] && input.seq <= previous[0].seq) {
      throw new Error(`Execution event sequence must increase: ${input.seq} <= ${previous[0].seq}`);
    }
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

  async appendNextEvent(input: Omit<AppendEventInput, "seq">): Promise<ExecutionEvent> {
    const previous = await this.db
      .select({ seq: executionEvents.seq })
      .from(executionEvents)
      .where(eq(executionEvents.attemptId, input.attemptId))
      .orderBy(desc(executionEvents.seq))
      .limit(1);
    // ponytail: attempts have one active runner; use DB-assigned sequencing if that invariant changes.
    return this.appendEvent({ ...input, seq: (previous[0]?.seq ?? 0) + 1 });
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

  async appendRawOutput(input: Omit<ExecutionRawOutput, "id">): Promise<ExecutionRawOutput> {
    const attempt = await this.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Agent attempt ${input.attemptId} not found`);
    if (attempt.organizationId !== input.organizationId) {
      throw new Error("Raw output organization does not match its attempt");
    }
    const previous = await this.db
      .select({ seq: executionRawOutputs.seq })
      .from(executionRawOutputs)
      .where(eq(executionRawOutputs.attemptId, input.attemptId))
      .orderBy(desc(executionRawOutputs.seq))
      .limit(1);
    if (previous[0] && input.seq <= previous[0].seq) {
      throw new Error(`Raw output sequence must increase: ${input.seq} <= ${previous[0].seq}`);
    }
    const row = {
      ...input,
      ts: input.ts ?? now(),
    } satisfies typeof executionRawOutputs.$inferInsert;
    await this.db.insert(executionRawOutputs).values(row);
    const created = await this.db
      .select()
      .from(executionRawOutputs)
      .where(
        and(
          eq(executionRawOutputs.attemptId, input.attemptId),
          eq(executionRawOutputs.seq, input.seq),
        ),
      )
      .limit(1);
    if (!created[0])
      throw new Error(`Raw output ${input.attemptId}/${input.seq} was not persisted`);
    return executionRawOutputSchema.parse(created[0]);
  }

  async listRawOutputs(attemptId: string): Promise<ExecutionRawOutput[]> {
    const rows = await this.db
      .select()
      .from(executionRawOutputs)
      .where(eq(executionRawOutputs.attemptId, attemptId))
      .orderBy(asc(executionRawOutputs.seq));
    return rows.map((row) => executionRawOutputSchema.parse(row));
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

export class ExternalActionConflictError extends Error {}

function parseWorkItem(row: typeof executionWorkItems.$inferSelect): ExecutionWorkItem {
  const { metadataJson, governanceJson, repositoryIdsJson, ...workItem } = row;
  const parsedRepositoryIds = JSON.parse(repositoryIdsJson) as unknown;
  const repositoryIds =
    Array.isArray(parsedRepositoryIds) && parsedRepositoryIds.length > 0
      ? parsedRepositoryIds
      : [workItem.repositoryId];
  return executionWorkItemSchema.parse({
    ...workItem,
    repositoryIds,
    metadata: JSON.parse(metadataJson),
    governance: executionGovernanceSchema.parse(JSON.parse(governanceJson)),
  });
}

function parsePlan(row: typeof executionPlans.$inferSelect) {
  const {
    sourceSnapshotJson,
    targetJson,
    harnessConfigJson,
    workspacePolicyJson,
    runtimeConfigJson,
    profileSnapshotJson,
    ...plan
  } = row;
  return executionPlanSchema.parse({
    ...plan,
    sourceSnapshot: JSON.parse(sourceSnapshotJson),
    target: JSON.parse(targetJson),
    harnessConfig: JSON.parse(harnessConfigJson),
    workspacePolicy: JSON.parse(workspacePolicyJson),
    runtimeConfig: JSON.parse(runtimeConfigJson),
    profileSnapshot: JSON.parse(profileSnapshotJson),
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

function externalActionFingerprint(input: {
  organizationId: string;
  workItemId: string;
  connector: string;
  operation: string;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        organizationId: input.organizationId,
        workItemId: input.workItemId,
        connector: input.connector,
        operation: input.operation,
        payload: input.payload,
      }),
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function safeRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
  if (scope === "loop") {
    const loopId = workItem.metadata.loopId;
    if (typeof loopId !== "string" || !loopId) throw new Error("Loop budget requires loopId");
    return loopId;
  }
  if (scope === "agent") return agentId;
  return attemptId;
}

function budgetEstimate(metadata: Record<string, unknown>): {
  tokens: number;
  costUsd: number;
} {
  const value = metadata.budgetEstimate;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { tokens: 0, costUsd: 0 };
  }
  const estimate = value as Record<string, unknown>;
  return {
    tokens:
      typeof estimate.tokens === "number" && Number.isFinite(estimate.tokens)
        ? Math.max(0, Math.floor(estimate.tokens))
        : 0,
    costUsd:
      typeof estimate.costUsd === "number" && Number.isFinite(estimate.costUsd)
        ? Math.max(0, estimate.costUsd)
        : 0,
  };
}

export function evaluateExecutionPolicy(
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

function isDeliveryModeAllowed(
  workKind: ExecutionWorkItem["workKind"],
  deliveryMode: ExecutionWorkItem["deliveryMode"],
): boolean {
  if (workKind === "external_action") return deliveryMode === "none";
  if (workKind === "general") return deliveryMode === "none" || deliveryMode === "artifact";
  return true;
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}
