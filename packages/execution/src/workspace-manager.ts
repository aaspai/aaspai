import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { GitRepository } from "@aaspai/git";
import { validateBranchName } from "@aaspai/git";
import type { ExecutionStore } from "./store.js";

export interface PrepareLocalWorkspaceInput {
  organizationId: string;
  attemptId: string;
  repositoryId: string;
  repositoryPath: string;
  baseCommitSha: string;
  workspaceRoot: string;
  branchName?: string;
}

export type RepositoryPathResolver = (repositoryId: string) => string | Promise<string>;

/**
 * Materializes one attempt into a dedicated Git worktree.
 *
 * The worktree lives below the caller-owned workspace root. The company
 * definition repository and the project repository therefore remain separate
 * inputs, while the agent receives only the project worktree as its cwd.
 */
export class LocalExecutionWorkspaceManager {
  constructor(
    private readonly git: GitRepository,
    private readonly store: ExecutionStore,
    private readonly repositoryPathFor: RepositoryPathResolver,
  ) {}

  async prepare(input: PrepareLocalWorkspaceInput): Promise<ExecutionWorkspace> {
    const branchName = validateBranchName(input.branchName ?? `work/${input.attemptId}`);
    const workspacePath = this.pathFor(input.workspaceRoot, input.attemptId);
    await mkdir(input.workspaceRoot, { recursive: true });

    const workspace = await this.store.createWorkspace({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      repositoryId: input.repositoryId,
      path: workspacePath,
      branchName,
      baseCommitSha: input.baseCommitSha,
      status: "creating",
    });
    const resourceId = `${input.repositoryId}:${branchName}`;
    const existing = await this.store.findResourceLock(input.organizationId, "branch", resourceId);
    const lock =
      existing?.ownerAttemptId === input.attemptId
        ? existing
        : await this.store.acquireResourceLock({
            organizationId: input.organizationId,
            resourceType: "branch",
            resourceId,
            ownerAttemptId: input.attemptId,
            leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          });
    if (!lock) {
      await this.store.updateWorkspaceStatus(workspace.id, "failed");
      throw new Error(`Execution branch is already locked: ${branchName}`);
    }

    try {
      await this.git.createWorktree(
        input.repositoryPath,
        workspacePath,
        branchName,
        input.baseCommitSha,
      );
      return await this.store.updateWorkspaceStatus(workspace.id, "ready");
    } catch (error) {
      await this.store.releaseResourceLock(lock.id);
      await this.store.updateWorkspaceStatus(workspace.id, "failed");
      throw error;
    }
  }

  async release(workspaceId: string): Promise<ExecutionWorkspace> {
    const workspace = await this.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Execution workspace ${workspaceId} not found`);
    if (workspace.status === "released") return workspace as ExecutionWorkspace;

    await this.store.updateWorkspaceStatus(workspaceId, "releasing");
    try {
      const repositoryPath = await this.repositoryPathFor(workspace.repositoryId);
      await this.git.removeWorktree(repositoryPath, workspace.path);
      const lock = await this.store.findResourceLock(
        workspace.organizationId,
        "branch",
        `${workspace.repositoryId}:${workspace.branchName}`,
      );
      if (lock) await this.store.releaseResourceLock(lock.id);
      return await this.store.updateWorkspaceStatus(workspaceId, "released");
    } catch (error) {
      await this.store.updateWorkspaceStatus(workspaceId, "failed");
      throw error;
    }
  }

  private pathFor(root: string, attemptId: string): string {
    const absoluteRoot = resolve(root);
    const candidate = resolve(absoluteRoot, "execution", attemptId);
    const child = relative(absoluteRoot, candidate);
    if (!child || child.startsWith("..")) {
      throw new Error("Execution workspace root must contain the attempt worktree");
    }
    return candidate;
  }
}
