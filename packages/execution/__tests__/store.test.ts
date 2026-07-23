import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionStore } from "../src/store";

describe("ExecutionStore", () => {
  let handle: DbHandle;
  let store: ExecutionStore;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `execution-store-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.AASPAI_DB;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("persists the goal-to-attempt lineage and enforces idempotent work creation", async () => {
    const organizationId = "org_test";
    const goal = await store.createGoal({ organizationId, title: "Ship the product" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Application",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: "workspace/projects/application",
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: "company",
      contentHash: "sha256:definitions",
    });
    const workItem = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      title: "Implement the first slice",
      definitionRevisionId: revision.id,
      idempotencyKey: "work:first-slice",
      metadata: { priority: "high" },
    });
    const sameWorkItem = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      title: "Duplicate request",
      idempotencyKey: "work:first-slice",
    });
    await expect(store.getWorkItem(workItem.id)).resolves.toMatchObject({
      id: workItem.id,
      metadata: { priority: "high" },
    });
    const run = await store.createWorkflowRun({
      organizationId,
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "run:first-slice",
    });
    const attempt = await store.createAttempt({
      organizationId,
      workflowRunId: run.id,
      workItemId: workItem.id,
      agentId: "agent_ceo",
      harness: "codex",
    });

    expect(sameWorkItem.id).toBe(workItem.id);
    expect(JSON.parse(workItem.metadataJson)).toEqual({ priority: "high" });
    expect(await store.claimWorkItem(workItem.id, attempt.id)).toBe(true);
    expect(await store.claimWorkItem(workItem.id, attempt.id)).toBe(false);

    expect((await store.transitionAttempt(attempt.id, "preparing")).status).toBe("preparing");
    expect((await store.transitionAttempt(attempt.id, "running")).startedAt).toEqual(
      expect.any(String),
    );
    const completed = await store.transitionAttempt(attempt.id, "succeeded");
    expect(completed.status).toBe("succeeded");
    expect(completed.finishedAt).toEqual(expect.any(String));

    const artifact = await store.createArtifact({
      organizationId,
      attemptId: attempt.id,
      kind: "result",
      path: "workspace/artifacts/result.json",
      mediaType: "application/json",
      sizeBytes: 42,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    await expect(store.listArtifacts(attempt.id)).resolves.toEqual([artifact]);
  });

  it("rejects invalid attempt transitions", async () => {
    const goal = await store.createGoal({ organizationId: "org_test", title: "Test" });
    const project = await store.createProject({
      organizationId: "org_test",
      goalId: goal.id,
      title: "Project",
    });
    const repository = await store.createRepository({
      organizationId: "org_test",
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: "workspace/projects/test",
    });
    const revision = await store.createDefinitionRevision({
      organizationId: "org_test",
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: "company",
      contentHash: "hash",
    });
    const workItem = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      title: "Work",
      idempotencyKey: "work:invalid-transition",
    });
    const run = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "run:invalid-transition",
    });
    const attempt = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: run.id,
      workItemId: workItem.id,
      agentId: "agent_test",
      harness: "dry_run",
    });

    await expect(store.transitionAttempt(attempt.id, "succeeded")).rejects.toThrow(
      "Invalid agent attempt transition",
    );
  });
});
