import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { GitRepository } from "@aaspai/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitPinnedDefinitionWorkspace } from "../src/pinned-workspace";

describe("GitPinnedDefinitionWorkspace", () => {
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `pinned-definitions-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("mounts a resolved commit and closes the detached worktree", async () => {
    const resolveCommit = vi.fn(async () => "0123456789abcdef");
    const createDetachedWorktree = vi.fn(async () => undefined);
    const removeWorktree = vi.fn(async () => undefined);
    const git = {
      resolveCommit,
      createDetachedWorktree,
      removeWorktree,
    } as unknown as GitRepository;
    const workspace = new GitPinnedDefinitionWorkspace(git);

    const mount = await workspace.open({
      repositoryPath: "workspace/company-definitions",
      commitSha: "main",
      workspaceRoot: testDirectory,
    });

    expect(mount.commitSha).toBe("0123456789abcdef");
    expect(mount.path.startsWith(path.join(testDirectory, "definitions"))).toBe(true);
    expect(createDetachedWorktree).toHaveBeenCalledWith(
      "workspace/company-definitions",
      mount.path,
      "0123456789abcdef",
    );

    await mount.close();
    await mount.close();
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith("workspace/company-definitions", mount.path);
  });
});
