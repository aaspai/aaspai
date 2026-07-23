import { randomUUID } from "node:crypto";
import type {
  AgentAttempt,
  AttemptStatus,
  ExecutionWorkItem,
  ExecutionWorkspace,
  Goal,
  Project,
  Repository,
  SourceSnapshot,
  WorkflowRun,
} from "@aaspai/contracts/execution";
import { assertValidAttemptTransition } from "@aaspai/contracts/execution";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import {
  agentAttempts,
  and,
  definitionRevisions,
  eq,
  executionPlans,
  executionWorkItems,
  executionWorkspaces,
  goals,
  inArray,
  projects,
  repositories,
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
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  status?: ExecutionWorkItem["status"];
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
      idempotencyKey: input.idempotencyKey,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: now(),
      updatedAt: now(),
    } satisfies typeof executionWorkItems.$inferInsert;
    await this.db.insert(executionWorkItems).values(row);
    return row;
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

  async createAttempt(input: CreateAttemptInput) {
    const row = {
      id: input.id ?? makeId("attempt"),
      organizationId: input.organizationId,
      workflowRunId: input.workflowRunId,
      workItemId: input.workItemId,
      agentId: input.agentId,
      harness: input.harness,
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
    return row;
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}
