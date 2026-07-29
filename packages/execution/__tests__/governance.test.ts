import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, eq, executionExternalActions, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyScheduler } from "../src/scheduler";
import { ExecutionStore, evaluateExecutionPolicy } from "../src/store";

describe("execution governance", () => {
  let store: ExecutionStore;
  let close: () => Promise<void>;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m3", `governance-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    const handle = createDbForTest(path.join(testDirectory, "state.db"));
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
    close = handle.close;
  });

  afterEach(async () => {
    await close();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("keeps maker output pending until checker evidence and approval complete", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Governed change",
      deliveryMode: "pull_request",
      idempotencyKey: `governed:${randomUUID()}`,
      governance: {
        verification: { required: true, minEvidence: 1 },
        approval: { required: true, actorType: "human" },
      },
    });
    const scheduler = new DependencyScheduler(store, { retryDelayMs: 0 });
    await scheduler.run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async ({ attempt }) => {
        await store.recordDeliveryCommit(item.id, attempt.id, "1".repeat(40));
        return "succeeded";
      },
    );

    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({
      status: "awaiting_verification",
    });
    await expect(
      store.recordDeliveryCommit(item.id, "not-the-maker", "7".repeat(40)),
    ).rejects.toThrow("maker attempt");
    await expect(store.getWorkflowRun(fixture.runInput.workflowRunId)).resolves.toMatchObject({
      status: "running",
    });
    const maker = (await store.listAttemptsForWorkItem(item.id)).find(
      (attempt) => attempt.role === "maker",
    );
    await expect(
      store.recordDeliveryCommit(item.id, maker?.id ?? "missing", "7".repeat(40)),
    ).rejects.toThrow("immutable");
    const verification = await store.getVerificationForWorkItem(item.id);
    expect(verification?.status).toBe("pending");
    await expect(
      store.createCheckerAttempt({
        verificationId: verification?.id ?? "missing",
        agentId: "maker",
        harness: "dry_run_local",
      }),
    ).rejects.toThrow(/independent/);
    const checker = await store.createCheckerAttempt({
      verificationId: verification?.id ?? "missing",
      agentId: "checker",
      harness: "dry_run_local",
    });
    await store.startCheckerAttempt(checker.id);
    await store.transitionAttempt(checker.id, "succeeded");
    await store.createArtifact({
      id: "artifact_test_result",
      organizationId: fixture.lineage.organizationId,
      attemptId: checker.id,
      kind: "test_result",
      path: "test-result.json",
      mediaType: "application/json",
      sizeBytes: 2,
      sha256: "0".repeat(64),
    });
    const verified = await store.submitVerification({
      verificationId: verification?.id ?? "missing",
      checkerAttemptId: checker.id,
      status: "passed",
      summary: "All acceptance criteria passed",
      evidenceIds: ["artifact_test_result"],
    });
    expect(verified.workItem.status).toBe("awaiting_approval");
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    expect(approval?.status).toBe("requested");

    const decided = await store.decideApproval({
      approvalId: approval?.id ?? "missing",
      actorId: "human_reviewer",
      actorType: "human",
      status: "approved",
      reason: "Evidence reviewed",
    });
    expect(decided.workItem).toMatchObject({
      status: "completed",
      deliveryStatus: "ready",
    });
    await expect(store.getWorkflowRun(fixture.runInput.workflowRunId)).resolves.toMatchObject({
      status: "succeeded",
    });
    const expiredClaim = await store.claimDelivery(item.id, -1);
    expect(expiredClaim).toMatchObject({
      deliveryStatus: "delivering",
    });
    const deliveryClaim = await store.claimDelivery(item.id);
    expect(deliveryClaim?.deliveryClaimOwner).not.toBe(expiredClaim?.deliveryClaimOwner);
    await expect(store.claimDelivery(item.id)).resolves.toBeNull();
    await expect(
      store.completeDelivery({
        workItemId: item.id,
        ownerId: expiredClaim?.deliveryClaimOwner ?? "missing",
        status: "delivered",
      }),
    ).rejects.toThrow("actively claimed");
    await expect(
      store.completeDelivery({
        workItemId: item.id,
        ownerId: deliveryClaim?.deliveryClaimOwner ?? "missing",
        status: "delivered",
        ref: "https://example.test/pull/1",
      }),
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveryRef: "https://example.test/pull/1",
    });
  });

  it("blocks a maker result when independent verification fails", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Rejected change",
      deliveryMode: "none",
      idempotencyKey: `rejected:${randomUUID()}`,
      governance: { verification: { required: true } },
    });
    await new DependencyScheduler(store, { retryDelayMs: 0 }).run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async () => "succeeded",
    );
    const verification = await store.getVerificationForWorkItem(item.id);
    const checker = await store.createCheckerAttempt({
      verificationId: verification?.id ?? "missing",
      agentId: "checker",
      harness: "dry_run_local",
    });
    await store.startCheckerAttempt(checker.id);
    await store.transitionAttempt(checker.id, "failed");
    await store.submitVerification({
      verificationId: verification?.id ?? "missing",
      checkerAttemptId: checker.id,
      status: "failed",
      summary: "Required test failed",
    });
    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "verification failed: Required test failed",
    });
    await expect(store.getWorkflowRun(fixture.runInput.workflowRunId)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("rejects forged verification without a completed checker or owned evidence", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Forgery guard",
      deliveryMode: "none",
      idempotencyKey: `forgery:${randomUUID()}`,
      governance: { verification: { required: true, minEvidence: 1 } },
    });
    await new DependencyScheduler(store, { retryDelayMs: 0 }).run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async () => "succeeded",
    );
    const verification = await store.getVerificationForWorkItem(item.id);
    const checker = await store.createCheckerAttempt({
      verificationId: verification?.id ?? "missing",
      agentId: "checker",
      harness: "dry_run_local",
    });

    await expect(
      store.submitVerification({
        verificationId: verification?.id ?? "missing",
        checkerAttemptId: checker.id,
        status: "passed",
        summary: "forged",
        evidenceIds: ["not-an-artifact"],
      }),
    ).rejects.toThrow("must finish");

    await store.startCheckerAttempt(checker.id);
    await store.transitionAttempt(checker.id, "succeeded");
    await expect(
      store.submitVerification({
        verificationId: verification?.id ?? "missing",
        checkerAttemptId: checker.id,
        status: "passed",
        summary: "forged",
        evidenceIds: ["not-an-artifact"],
      }),
    ).rejects.toThrow("must belong");
  });

  it("denies policy actions visibly and prevents dispatch", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Denied change",
      deliveryMode: "none",
      idempotencyKey: `denied:${randomUUID()}`,
      governance: { policy: { actions: { execute: { allowed: false } } } },
    });
    const result = await new DependencyScheduler(store).tick({
      ...fixture.runInput,
      agentId: "maker",
      harness: "dry_run_local",
    });
    expect(result.dispatched).toHaveLength(0);
    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({ status: "blocked" });
    await expect(store.listGovernanceEvents(fixture.organizationId, item.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ decision: "denied", action: "execute" })]),
    );
  });

  it("stops retries when a hierarchical run budget is exhausted", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Budgeted change",
      deliveryMode: "none",
      maxAttempts: 2,
      idempotencyKey: `budgeted:${randomUUID()}`,
      governance: { budget: { limits: [{ scope: "organization", runs: 1 }] } },
    });
    let executions = 0;
    await new DependencyScheduler(store, { retryDelayMs: 0 }).run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async () => {
        executions++;
        return "failed";
      },
    );
    expect(executions).toBe(1);
    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({
      status: "blocked",
      blockedReason: "budget exhausted; no new attempt was started",
    });
  });

  it("rejects duplicate budget scopes", async () => {
    const fixture = await createFixture(store);
    await expect(
      store.createWorkItem({
        ...fixture.lineage,
        title: "Ambiguous budget",
        deliveryMode: "none",
        idempotencyKey: `duplicate-budget:${randomUUID()}`,
        governance: {
          budget: {
            limits: [
              { scope: "organization", runs: 1 },
              { scope: "organization", tokens: 10 },
            ],
          },
        },
      }),
    ).rejects.toThrow("Budget limits must use unique scopes");
  });

  it("blocks completion when actual usage exceeds the reserved hard budget", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Actual usage overage",
      deliveryMode: "none",
      idempotencyKey: `actual-overage:${randomUUID()}`,
      governance: { budget: { limits: [{ scope: "attempt", tokens: 10 }] } },
    });
    const dispatched = await store.dispatchWorkItem({
      ...fixture.runInput,
      workItemId: item.id,
      agentId: "maker",
      harness: "dry_run_local",
      organizationConcurrency: 1,
      projectConcurrency: 1,
      repositoryConcurrency: 1,
      agentConcurrency: 1,
    });
    expect(dispatched?.created).toBe(true);
    const completed = await store.completeScheduledAttempt({
      attemptId: dispatched?.attempt.id ?? "missing",
      status: "succeeded",
      usage: { tokens: 11 },
    });
    expect(completed.workItem).toMatchObject({
      status: "blocked",
      blockedReason: expect.stringContaining("actual budget exceeded"),
    });
  });

  it("deduplicates durable external side effects", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      workKind: "external_action",
      deliveryMode: "none",
      title: "Post notification",
      idempotencyKey: `external:${randomUUID()}`,
    });
    const input = {
      organizationId: fixture.organizationId,
      workItemId: item.id,
      connector: "slack",
      operation: "post_message",
      payload: { channel: "ops" },
      idempotencyKey: "notification-1",
    };
    const [first, second] = await Promise.all([
      store.claimExternalAction(input),
      store.claimExternalAction(input),
    ]);
    const acquired = [first, second].find((claim) => claim.disposition === "acquired");
    expect([first.disposition, second.disposition].sort()).toEqual(["acquired", "in_progress"]);
    if (!acquired?.ownerId) throw new Error("External action was not exclusively claimed");
    await store.completeExternalAction(acquired.action.id, acquired.ownerId, {
      status: "succeeded",
      result: { ok: true },
    });
    await expect(store.claimExternalAction(input)).resolves.toMatchObject({
      created: false,
      disposition: "replay",
    });
    await expect(
      store.claimExternalAction({ ...input, operation: "delete_message" }),
    ).rejects.toThrow("Idempotency key is already bound");
  });

  it("recovers expired external-action leases without accepting the old owner", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      workKind: "external_action",
      deliveryMode: "none",
      title: "Recover notification",
      idempotencyKey: `external-recovery:${randomUUID()}`,
    });
    const input = {
      organizationId: fixture.organizationId,
      workItemId: item.id,
      connector: "slack",
      operation: "post_message",
      payload: { channel: "ops" },
      idempotencyKey: "notification-recovery",
    };
    const first = await store.claimExternalAction(input);
    await store.database
      .update(executionExternalActions)
      .set({ leaseExpiresAt: new Date(0).toISOString() })
      .where(eq(executionExternalActions.id, first.action.id));
    const recovered = await store.claimExternalAction(input);
    expect(recovered.disposition).toBe("acquired");
    await expect(
      store.completeExternalAction(first.action.id, first.ownerId ?? "missing", {
        status: "succeeded",
        result: {},
      }),
    ).rejects.toThrow("no longer owned");
    await expect(
      store.completeExternalAction(recovered.action.id, recovered.ownerId ?? "missing", {
        status: "succeeded",
        result: {},
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("allows exactly one concurrent approval decision", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      deliveryMode: "none",
      title: "Concurrent approval",
      idempotencyKey: `approval-race:${randomUUID()}`,
      governance: { approval: { required: true, actorType: "human" } },
    });
    await new DependencyScheduler(store).run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async () => "succeeded",
    );
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    if (!approval) throw new Error("Approval was not created");
    const outcomes = await Promise.allSettled([
      store.decideApproval({
        approvalId: approval.id,
        actorId: "reviewer_one",
        actorType: "human",
        status: "approved",
      }),
      store.decideApproval({
        approvalId: approval.id,
        actorId: "reviewer_two",
        actorType: "human",
        status: "rejected",
      }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const events = await store.listGovernanceEvents(fixture.organizationId, item.id);
    expect(events.filter((event) => event.action.startsWith("approval."))).toHaveLength(1);
  });

  it("requires persisted artifact evidence and rejects invalid delivery combinations", async () => {
    const fixture = await createFixture(store);
    await expect(
      store.createWorkItem({
        ...fixture.lineage,
        workKind: "general",
        deliveryMode: "commit",
        title: "Invalid delivery",
        idempotencyKey: `invalid-delivery:${randomUUID()}`,
      }),
    ).rejects.toThrow("general work cannot use commit delivery");
    const item = await store.createWorkItem({
      ...fixture.lineage,
      workKind: "general",
      deliveryMode: "artifact",
      title: "Artifact delivery",
      idempotencyKey: `artifact-delivery:${randomUUID()}`,
      governance: { approval: { required: true, actorType: "human" } },
    });
    await new DependencyScheduler(store).run(
      { ...fixture.runInput, agentId: "maker", harness: "dry_run_local" },
      async () => "succeeded",
    );
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    const maker = (await store.listAttemptsForWorkItem(item.id)).find(
      (attempt) => attempt.role === "maker",
    );
    if (!approval || !maker) throw new Error("Governed artifact fixture was not created");
    const decision = {
      approvalId: approval.id,
      actorId: "human_reviewer",
      actorType: "human" as const,
      status: "approved" as const,
    };
    await expect(store.decideApproval(decision)).rejects.toThrow("persisted artifact");
    await store.createArtifact({
      organizationId: fixture.organizationId,
      attemptId: maker.id,
      kind: "other",
      path: "report.md",
      mediaType: "text/markdown",
      sizeBytes: 4,
      sha256: "1".repeat(64),
    });
    await expect(store.decideApproval(decision)).resolves.toMatchObject({
      workItem: { status: "completed", deliveryStatus: "delivered" },
    });
  });
});

describe("execution path policy", () => {
  it("denies actual changed paths and file-count overruns", () => {
    const governance = {
      risk: "low" as const,
      verification: {
        required: false,
        checkerAgentId: null,
        checkerHarness: null,
        minEvidence: 0,
        acceptanceCriteria: [],
      },
      approval: { required: false, actorType: "human" as const, expiresAfterMs: null },
      budget: { limits: [], soft: 0.8 },
      policy: {
        denylist: [".env", "payments/**"],
        allowlist: [],
        maxFilesChanged: 2,
        actions: {},
      },
    };

    expect(evaluateExecutionPolicy(governance, { paths: ["payments/card.ts"] })).toMatchObject({
      ok: false,
    });
    expect(evaluateExecutionPolicy(governance, { paths: ["a.ts", "b.ts", "c.ts"] })).toMatchObject({
      ok: false,
    });
  });
});

async function createFixture(store: ExecutionStore) {
  const organizationId = "org_governance";
  const goal = await store.createGoal({ organizationId, title: "Governance goal" });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "Governance project",
  });
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: "workspace/m3/project",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "governance-fixture",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    idempotencyKey: `run:${randomUUID()}`,
  });
  return {
    organizationId,
    lineage: {
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
    },
    runInput: { organizationId, goalId: goal.id, workflowRunId: run.id },
  };
}

function createDbForTest(filePath: string) {
  process.env.AASPAI_DB = `sqlite:${filePath}`;
  return createDb();
}
