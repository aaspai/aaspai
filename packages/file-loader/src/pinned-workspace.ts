import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { GitRepository } from "@aaspai/git";

export interface OpenPinnedDefinitionWorkspaceInput {
  repositoryPath: string;
  commitSha: string;
  workspaceRoot: string;
}

export interface PinnedDefinitionWorkspace {
  readonly repositoryPath: string;
  readonly commitSha: string;
  readonly path: string;
  close(): Promise<void>;
}

/**
 * Mounts company definitions at an immutable Git commit.
 *
 * This is intentionally separate from the mutable file sources. A run can
 * keep watching or editing a project worktree while its agent/loop policy is
 * read from this stable revision until the run finishes.
 */
export class GitPinnedDefinitionWorkspace {
  constructor(private readonly git: GitRepository) {}

  async open(input: OpenPinnedDefinitionWorkspaceInput): Promise<PinnedDefinitionWorkspace> {
    const commitSha = await this.git.resolveCommit(input.repositoryPath, input.commitSha);
    const root = resolve(input.workspaceRoot);
    const path = resolve(root, "definitions", `${commitSha.slice(0, 12)}-${randomUUID()}`);
    const child = relative(root, path);
    if (!child || child.startsWith("..")) {
      throw new Error("Pinned definition workspace must remain below the workspace root");
    }

    await mkdir(root, { recursive: true });
    await this.git.createDetachedWorktree(input.repositoryPath, path, commitSha);

    let closed = false;
    const git = this.git;
    return {
      repositoryPath: input.repositoryPath,
      commitSha,
      path,
      close: async () => {
        if (closed) return;
        closed = true;
        await git.removeWorktree(input.repositoryPath, path);
      },
    };
  }
}
