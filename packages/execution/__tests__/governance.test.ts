import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
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
      async () => "succeeded",
    );

    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({
      status: "awaiting_verification",
    });
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
    await expect(store.claimDelivery(item.id)).resolves.toMatchObject({
      deliveryStatus: "delivering",
    });
    await expect(store.claimDelivery(item.id)).resolves.toBeNull();
    await expect(
      store.completeDelivery({
        workItemId: item.id,
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
  });

  it("rejects forged verification without a completed checker or owned evidence", async () => {
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "Forgery guard",
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
    await expect(store.claimExternalAction(input)).resolves.toMatchObject({ created: true });
    await expect(store.claimExternalAction(input)).resolves.toMatchObject({ created: false });
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
