import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyScheduler } from "../src/scheduler";
import { ExecutionStore } from "../src/store";

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
    const checker = await store.createCheckerAttempt({
      verificationId: verification?.id ?? "missing",
      agentId: "checker",
      harness: "dry_run_local",
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
    expect(decided.workItem.status).toBe("completed");
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
