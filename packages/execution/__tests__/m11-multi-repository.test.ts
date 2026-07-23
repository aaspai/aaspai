import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
import type { GitRepository } from "@aaspai/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DependencyScheduler } from "../src/scheduler";
import { ExecutionStore } from "../src/store";
import { LocalExecutionWorkspaceManager } from "../src/workspace-manager";

describe("M11 multi-repository execution", () => {
  let testDirectory: string;
  let close: () => Promise<void>;
  let store: ExecutionStore;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m11", randomUUID());
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    const handle = createDb();
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
    close = handle.close;
  });

  afterEach(async () => {
    await close();
    delete process.env.AASPAI_DB;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("normalizes repository sets and reserves every repository and agent slot", async () => {
    const fixture = await createFixture(store);
    const [repoOne, repoTwo] = fixture.repositories;
    if (!repoOne || !repoTwo) throw new Error("M11 fixture requires two repositories");
    const first = await store.createWorkItem({
      ...fixture.lineage,
      repositoryId: repoOne.id,
      repositoryIds: fixture.repositories.map((repository) => repository.id),
      branchName: "work/shared",
      title: "Change both repositories",
      idempotencyKey: "m11-first",
    });
    const second = await store.createWorkItem({
      ...fixture.lineage,
      repositoryId: repoTwo.id,
      repositoryIds: [repoTwo.id],
      title: "Change the second repository",
      idempotencyKey: "m11-second",
    });

    await expect(store.getWorkItem(first.id)).resolves.toMatchObject({
      repositoryId: repoOne.id,
      repositoryIds: fixture.repositories.map((repository) => repository.id),
    });

    const scheduler = new DependencyScheduler(store, {
      maxOrganizationConcurrency: 4,
      maxProjectConcurrency: 4,
      maxRepositoryConcurrency: 1,
      maxAgentConcurrency: 1,
    });
    const input = {
      organizationId: fixture.organizationId,
      goalId: fixture.goal.id,
      workflowRunId: fixture.run.id,
      agentId: "agent/m11",
      harness: "dry_run_local",
      maxDispatch: 2,
    };
    const firstTick = await scheduler.tick(input);
    expect(firstTick.dispatched).toHaveLength(1);
    expect(firstTick.dispatched[0]?.workItem.id).toBe(first.id);
    expect(
      await store.findResourceLock(
        fixture.organizationId,
        "repository_slot",
        `repository:${repoOne.id}:0`,
      ),
    ).not.toBeNull();
    expect(
      await store.findResourceLock(
        fixture.organizationId,
        "repository_slot",
        `repository:${repoTwo.id}:0`,
      ),
    ).not.toBeNull();
    expect(
      await store.findResourceLock(fixture.organizationId, "agent_slot", "agent:agent/m11:0"),
    ).not.toBeNull();

    const secondTick = await scheduler.tick(input);
    expect(secondTick.dispatched).toHaveLength(0);
    expect(secondTick.progress.active).toBe(1);
    await expect(store.getWorkItem(second.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("prepares one worktree per repository and rolls back partial preparation", async () => {
    const createWorktree = vi.fn(async () => undefined);
    const removeWorktree = vi.fn(async () => undefined);
    const git = { createWorktree, removeWorktree } as unknown as GitRepository;
    const manager = new LocalExecutionWorkspaceManager(git, store, () =>
      path.join(testDirectory, "repo"),
    );
    const workspaces = await manager.prepareMany({
      organizationId: "org_m11",
      attemptId: "attempt_many",
      workspaceRoot: path.join(testDirectory, "workspaces"),
      branchName: "work/many",
      repositories: [
        { repositoryId: "repo_one", repositoryPath: "repo-one", baseCommitSha: "abcdef1" },
        { repositoryId: "repo_two", repositoryPath: "repo-two", baseCommitSha: "abcdef2" },
      ],
    });
    expect(workspaces).toHaveLength(2);
    expect(workspaces[0]?.path).not.toBe(workspaces[1]?.path);
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).not.toHaveBeenCalled();

    const failingCreate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second repository unavailable"));
    const failingGit = {
      createWorktree: failingCreate,
      removeWorktree,
    } as unknown as GitRepository;
    const failingManager = new LocalExecutionWorkspaceManager(failingGit, store, () =>
      path.join(testDirectory, "repo"),
    );
    await expect(
      failingManager.prepareMany({
        organizationId: "org_m11",
        attemptId: "attempt_rollback",
        workspaceRoot: path.join(testDirectory, "rollback"),
        repositories: [
          { repositoryId: "repo_one", repositoryPath: "repo-one", baseCommitSha: "abcdef1" },
          { repositoryId: "repo_two", repositoryPath: "repo-two", baseCommitSha: "abcdef2" },
        ],
      }),
    ).rejects.toThrow("second repository unavailable");
    expect(removeWorktree).toHaveBeenCalled();
  });
});

async function createFixture(store: ExecutionStore) {
  const organizationId = "org_m11";
  const goal = await store.createGoal({ organizationId, title: "M11 goal" });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "M11 project",
  });
  const repositories = await Promise.all(
    ["one", "two"].map((name) =>
      store.createRepository({
        organizationId,
        projectId: project.id,
        purpose: "project",
        provider: "local",
        localPath: `workspace/m11/${name}`,
      }),
    ),
  );
  const [repositoryOne, repositoryTwo] = repositories;
  if (!repositoryOne || !repositoryTwo) throw new Error("M11 fixture requires two repositories");
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repositoryOne.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "m11-fixture",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    idempotencyKey: `run:${randomUUID()}`,
  });
  return {
    organizationId,
    goal,
    project,
    repositories: [repositoryOne, repositoryTwo],
    run,
    lineage: {
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      definitionRevisionId: revision.id,
    },
  };
}
