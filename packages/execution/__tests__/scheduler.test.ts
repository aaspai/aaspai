import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DependencyScheduler } from "../src/scheduler";
import { ExecutionStore } from "../src/store";

describe("DependencyScheduler", () => {
  let store: ExecutionStore;
  let close: () => Promise<void>;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m2", `scheduler-${randomUUID()}`);
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

  it("rejects cycles and executes a dependency chain without manual dispatch", async () => {
    const fixture = await createFixture(store);
    const first = await createItem(store, fixture, "First", "first");
    const second = await createItem(store, fixture, "Second", "second");
    const third = await createItem(store, fixture, "Third", "third");
    await store.addWorkItemDependency(fixture.organizationId, second.id, first.id);
    await store.addWorkItemDependency(fixture.organizationId, third.id, second.id);
    await expect(
      store.addWorkItemDependency(fixture.organizationId, first.id, third.id),
    ).rejects.toThrow("cycle");

    const executed: string[] = [];
    const result = await new DependencyScheduler(store, {
      maxOrganizationConcurrency: 2,
      maxProjectConcurrency: 2,
      retryDelayMs: 0,
    }).run(
      {
        organizationId: fixture.organizationId,
        goalId: fixture.goal.id,
        workflowRunId: fixture.run.id,
        agentId: "agent_scheduler",
        harness: "dry_run_local",
      },
      async ({ workItem }) => {
        executed.push(workItem.title);
        return "succeeded";
      },
    );

    expect(executed).toEqual(["First", "Second", "Third"]);
    expect(result.progress).toMatchObject({ total: 3, completed: 3, percent: 100 });
    await expect(store.getWorkItem(third.id)).resolves.toMatchObject({ status: "completed" });
    await expect(store.getWorkflowRun(fixture.run.id)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("retries a failed item and then releases its dependent", async () => {
    const fixture = await createFixture(store);
    const flaky = await createItem(store, fixture, "Flaky", "flaky", { maxAttempts: 2 });
    const dependent = await createItem(store, fixture, "Dependent", "dependent");
    await store.addWorkItemDependency(fixture.organizationId, dependent.id, flaky.id);

    let attempts = 0;
    const result = await new DependencyScheduler(store, {
      maxOrganizationConcurrency: 1,
      maxProjectConcurrency: 1,
      retryDelayMs: 0,
    }).run(
      {
        organizationId: fixture.organizationId,
        goalId: fixture.goal.id,
        workflowRunId: fixture.run.id,
        agentId: "agent_scheduler",
        harness: "dry_run_local",
      },
      async () => {
        attempts++;
        return attempts === 1 ? "failed" : "succeeded";
      },
    );

    expect(attempts).toBe(3);
    expect(result.progress).toMatchObject({ total: 2, completed: 2, percent: 100 });
    await expect(store.getWorkItem(dependent.id)).resolves.toMatchObject({ status: "completed" });
  });

  it("blocks a dependent with an explanation after retry exhaustion", async () => {
    const fixture = await createFixture(store);
    const failed = await createItem(store, fixture, "Failed", "failed");
    const dependent = await createItem(store, fixture, "Blocked", "blocked");
    await store.addWorkItemDependency(fixture.organizationId, dependent.id, failed.id);

    const result = await new DependencyScheduler(store, {
      maxOrganizationConcurrency: 1,
      maxProjectConcurrency: 1,
      retryDelayMs: 0,
    }).run(
      {
        organizationId: fixture.organizationId,
        goalId: fixture.goal.id,
        workflowRunId: fixture.run.id,
        agentId: "agent_scheduler",
        harness: "dry_run_local",
      },
      async () => "failed",
    );

    expect(result.progress).toMatchObject({ total: 2, failed: 1, blocked: 1 });
    await expect(store.getWorkflowRun(fixture.run.id)).resolves.toMatchObject({ status: "failed" });
    await expect(store.getWorkItem(dependent.id)).resolves.toMatchObject({
      status: "blocked",
      blockedReason: `blocked by ${failed.id}`,
    });
  });

  it("bounds dispatch and keeps duplicate ticks idempotent", async () => {
    const fixture = await createFixture(store);
    const one = await createItem(store, fixture, "One", "one");
    const two = await createItem(store, fixture, "Two", "two");
    const scheduler = new DependencyScheduler(store, {
      maxOrganizationConcurrency: 1,
      maxProjectConcurrency: 1,
    });
    const input = {
      organizationId: fixture.organizationId,
      goalId: fixture.goal.id,
      workflowRunId: fixture.run.id,
      agentId: "agent_scheduler",
      harness: "dry_run_local",
      maxDispatch: 2,
    };
    const first = await scheduler.tick(input);
    const second = await scheduler.tick(input);

    expect(first.dispatched).toHaveLength(1);
    expect([one.id, two.id]).toContain(first.dispatched[0]?.workItem.id);
    expect(second.dispatched).toHaveLength(0);
    const attempts = [
      ...(await store.listAttemptsForWorkItem(one.id)),
      ...(await store.listAttemptsForWorkItem(two.id)),
    ];
    expect(attempts).toHaveLength(1);
  });
});

async function createFixture(store: ExecutionStore) {
  const organizationId = "org_scheduler";
  const goal = await store.createGoal({ organizationId, title: "Scheduler goal" });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "Scheduler project",
  });
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: "workspace/m2/project",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "scheduler-fixture",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    idempotencyKey: `run:${randomUUID()}`,
  });
  return { organizationId, goal, project, repository, revision, run };
}

async function createItem(
  store: ExecutionStore,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  title: string,
  key: string,
  options: { maxAttempts?: number } = {},
) {
  return store.createWorkItem({
    organizationId: fixture.organizationId,
    goalId: fixture.goal.id,
    projectId: fixture.project.id,
    repositoryId: fixture.repository.id,
    title,
    idempotencyKey: `${key}:${randomUUID()}`,
    maxAttempts: options.maxAttempts,
  });
}

function createDbForTest(filePath: string) {
  process.env.AASPAI_DB = `sqlite:${filePath}`;
  return createDb();
}
