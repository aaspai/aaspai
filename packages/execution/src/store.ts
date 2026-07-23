import { randomUUID } from "node:crypto";
import type {
  AgentAttempt,
  Artifact,
  AttemptStatus,
  ExecutionEvent,
  ExecutionWorkItem,
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
  executionWorkItemSchema,
  executionWorkspaceSchema,
  resourceLockSchema,
  workflowRunSchema,
} from "@aaspai/contracts/execution";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import {
  agentAttempts,
  and,
  artifacts,
  asc,
  definitionRevisions,
  eq,
  executionEvents,
  executionPlans,
  executionWorkItems,
  executionWorkspaces,
  goals,
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

  async getWorkItem(workItemId: string): Promise<ExecutionWorkItem | null> {
    const rows = await this.db
      .select()
      .from(executionWorkItems)
      .where(eq(executionWorkItems.id, workItemId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const {
      claimedByAttemptId: _claimedByAttemptId,
      claimedAt: _claimedAt,
      metadataJson,
      ...workItem
    } = row;
    return executionWorkItemSchema.parse({ ...workItem, metadata: JSON.parse(metadataJson) });
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
    const active = await this.db
      .select()
      .from(resourceLocks)
      .where(
        and(
          eq(resourceLocks.organizationId, input.organizationId),
          eq(resourceLocks.resourceType, input.resourceType),
          eq(resourceLocks.resourceId, input.resourceId),
          isNull(resourceLocks.releasedAt),
        ),
      )
      .limit(1);
    if (active[0]) return null;
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
    await this.db.insert(resourceLocks).values(row);
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

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}
