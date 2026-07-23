import { describe, expect, it, vi } from "vitest";
import type { GitCommandRunner } from "../src/contract";
import { validateBranchName } from "../src/contract";
import {
  LocalGitHubPullRequestProvider,
  LocalGitRepository,
  type PullRequestCommandRunner,
} from "../src/local";

function runner(outputs: Record<string, string>): GitCommandRunner {
  return {
    run: vi.fn(async (args) => ({
      stdout: outputs[args.join(" ")] ?? "",
      stderr: "",
      exitCode: 0,
    })),
  };
}

describe("local Git capability", () => {
  it("rejects unsafe branch names", () => {
    expect(() => validateBranchName("feature/ok")).not.toThrow();
    expect(() => validateBranchName("feature/../main")).toThrow();
    expect(() => validateBranchName("feature bad")).toThrow();
    expect(() => validateBranchName("feature/codex")).not.toThrow();
  });

  it("inspects a repository and reports a clean status", async () => {
    const git = new LocalGitRepository(
      runner({
        "rev-parse --show-toplevel": "F:/repo\n",
        "rev-parse --abbrev-ref HEAD": "main\n",
        "remote get-url origin": "git@github.com:org/repo.git\n",
        "rev-parse --verify HEAD^{commit}": "0123456789abcdef\n",
        "status --porcelain=v1": "",
      }),
    );

    await expect(git.inspect("F:/repo")).resolves.toEqual({
      root: "F:/repo",
      branch: "main",
      headSha: "0123456789abcdef",
      remoteUrl: "git@github.com:org/repo.git",
    });
    await expect(git.status("F:/repo")).resolves.toEqual({ dirty: false, entries: [] });
  });

  it("creates an isolated worktree and commits only when changes exist", async () => {
    const fake = runner({
      "status --porcelain=v1": " M src/app.ts\n",
      "rev-parse --verify HEAD^{commit}": "abcdef0123456789\n",
    });
    const git = new LocalGitRepository(fake);

    await git.createWorktree("F:/repo", "F:/worktrees/work_1", "work/work_1", "0123456789abcdef");
    await expect(git.commit("F:/worktrees/work_1", "feat: implement work item")).resolves.toBe(
      "abcdef0123456789",
    );
    expect(fake.run).toHaveBeenCalledWith(
      ["worktree", "add", "-b", "work/work_1", "F:/worktrees/work_1", "0123456789abcdef"],
      { cwd: "F:/repo" },
    );
  });

  it("creates a detached worktree for a pinned revision", async () => {
    const fake = runner({});
    const git = new LocalGitRepository(fake);

    await git.createDetachedWorktree("F:/definitions", "F:/workspace/definitions/rev", "abcdef1");

    expect(fake.run).toHaveBeenCalledWith(
      ["worktree", "add", "--detach", "F:/workspace/definitions/rev", "abcdef1"],
      { cwd: "F:/definitions" },
    );
  });

  it("creates GitHub pull requests through the CLI provider", async () => {
    const fake: PullRequestCommandRunner = {
      run: vi.fn(async () => ({
        stdout: "https://github.com/org/repo/pull/12\n",
        stderr: "",
      })),
    };
    const provider = new LocalGitHubPullRequestProvider(fake);

    await expect(
      provider.create({
        repository: "git@github.com:org/repo.git",
        head: "autonomy/proposal",
        base: "main",
        title: "Governance change",
        body: "Approved change",
      }),
    ).resolves.toEqual({
      number: 12,
      url: "https://github.com/org/repo/pull/12",
      state: "open",
      head: "autonomy/proposal",
      base: "main",
    });
    expect(fake.run).toHaveBeenCalledWith([
      "pr",
      "create",
      "--repo",
      "org/repo",
      "--head",
      "autonomy/proposal",
      "--base",
      "main",
      "--title",
      "Governance change",
      "--body",
      "Approved change",
    ]);
  });
});
