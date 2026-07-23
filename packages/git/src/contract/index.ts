export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitCommandError extends Error {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
}

export interface GitCommandRunner {
  run(args: readonly string[], options?: { cwd?: string }): Promise<GitCommandResult>;
}

export interface GitRepositoryInfo {
  readonly root: string;
  readonly branch: string | null;
  readonly headSha: string;
  readonly remoteUrl: string | null;
}

export interface GitStatus {
  readonly dirty: boolean;
  readonly entries: readonly string[];
}

export interface PullRequestInput {
  readonly repository: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft?: boolean;
}

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly head: string;
  readonly base: string;
}

export interface GitRepository {
  inspect(path: string): Promise<GitRepositoryInfo>;
  status(path: string): Promise<GitStatus>;
  resolveCommit(path: string, ref?: string): Promise<string>;
  createBranch(path: string, branchName: string, baseCommit: string): Promise<void>;
  createWorktree(
    path: string,
    worktreePath: string,
    branchName: string,
    baseCommit: string,
  ): Promise<void>;
  createDetachedWorktree(path: string, worktreePath: string, commit: string): Promise<void>;
  removeWorktree(path: string, worktreePath: string): Promise<void>;
  commit(path: string, message: string): Promise<string | null>;
  diff(path: string): Promise<string>;
  push(path: string, remote: string, branchName: string): Promise<void>;
}

export interface PullRequestProvider {
  create(input: PullRequestInput): Promise<PullRequest>;
  get(repository: string, number: number): Promise<PullRequest>;
}

export function validateBranchName(branchName: string): string {
  const value = branchName.trim();
  if (!value || value !== branchName) throw new Error("Branch name must be non-empty and trimmed");
  if (value.length > 256 || value.includes("\\") || value.includes("..") || value.includes("@{")) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  const hasForbiddenCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || " ~^:?*[]".includes(character);
  });
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    hasForbiddenCharacter
  ) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  return value;
}
