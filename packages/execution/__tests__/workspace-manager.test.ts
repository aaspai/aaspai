import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import type { GitRepository } from "@aaspai/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionStore } from "../src/store";
import { LocalExecutionWorkspaceManager } from "../src/workspace-manager";

describe("LocalExecutionWorkspaceManager", () => {
  let handle: DbHandle;
  let store: ExecutionStore;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `workspace-manager-${randomUUID()}`);
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

  it("records a ready worktree and releases it through the Git capability", async () => {
    const createWorktree = vi.fn(async () => undefined);
    const removeWorktree = vi.fn(async () => undefined);
    const git = {
      createWorktree,
      removeWorktree,
    } as unknown as GitRepository;
    const manager = new LocalExecutionWorkspaceManager(git, store, async (repositoryId) => {
      expect(repositoryId).toBe("repo_app");
      return path.join(testDirectory, "project-repository");
    });

    const workspace = await manager.prepare({
      organizationId: "org_test",
      attemptId: "attempt_1",
      repositoryId: "repo_app",
      repositoryPath: path.join(testDirectory, "project-repository"),
      baseCommitSha: "abcdef1",
      workspaceRoot: path.join(testDirectory, "workspace-root"),
    });

    expect(workspace.status).toBe("ready");
    expect(workspace.path).toBe(
      path.join(testDirectory, "workspace-root", "execution", "attempt_1"),
    );
    expect(createWorktree).toHaveBeenCalledWith(
      path.join(testDirectory, "project-repository"),
      workspace.path,
      "work/attempt_1",
      "abcdef1",
    );

    const released = await manager.release(workspace.id);
    expect(released.status).toBe("released");
    expect(removeWorktree).toHaveBeenCalledWith(
      path.join(testDirectory, "project-repository"),
      workspace.path,
    );
  });

  it("uses a disposable directory without invoking Git", async () => {
    const git = {
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
    } as unknown as GitRepository;
    const manager = new LocalExecutionWorkspaceManager(git, store, () => "unused");
    const workspace = await manager.prepareDisposable({
      organizationId: "org_test",
      attemptId: "attempt_general",
      repositoryId: "repo_lineage",
      workspaceRoot: path.join(testDirectory, "workspace-root"),
    });

    await expect(access(workspace.path)).resolves.toBeUndefined();
    expect(git.createWorktree).not.toHaveBeenCalled();
    await manager.releaseDisposable(workspace.id);
    await expect(access(workspace.path)).rejects.toThrow();
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not allow a worktree to escape the workspace root", async () => {
    const git = {} as GitRepository;
    const manager = new LocalExecutionWorkspaceManager(git, store, () => "unused");

    await expect(
      manager.prepare({
        organizationId: "org_test",
        attemptId: "../outside",
        repositoryId: "repo_app",
        repositoryPath: "repo",
        baseCommitSha: "abcdef1",
        workspaceRoot: path.join(testDirectory, "workspace-root"),
      }),
    ).rejects.toThrow("Invalid branch name");
  });
});
