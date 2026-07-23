import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitCommandError,
  GitCommandResult,
  GitCommandRunner,
  GitRepository,
  GitRepositoryInfo,
  GitStatus,
} from "../contract/index.js";
import { validateBranchName } from "../contract/index.js";

const execFileAsync = promisify(execFile);

export class LocalGitCommandError extends Error implements GitCommandError {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: readonly string[], exitCode: number | null, stderr: string) {
    super(`Git command failed (${command.join(" ")}): ${stderr.trim() || "unknown error"}`);
    this.name = "LocalGitCommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class LocalGitCommandRunner implements GitCommandRunner {
  async run(args: readonly string[], options: { cwd?: string } = {}): Promise<GitCommandResult> {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; code?: number | string };
      throw new LocalGitCommandError(
        args,
        typeof detail.code === "number" ? detail.code : null,
        detail.stderr ?? detail.stdout ?? String(error),
      );
    }
  }
}

export class LocalGitRepository implements GitRepository {
  constructor(private readonly runner: GitCommandRunner = new LocalGitCommandRunner()) {}

  async inspect(path: string): Promise<GitRepositoryInfo> {
    const root = await this.output(["rev-parse", "--show-toplevel"], path);
    const branchResult = await this.runner.run(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: path,
    });
    const remoteResult = await this.runner
      .run(["remote", "get-url", "origin"], { cwd: path })
      .catch(() => ({ stdout: "", stderr: "", exitCode: 1 }));
    return {
      root,
      branch: branchResult.stdout.trim() === "HEAD" ? null : branchResult.stdout.trim(),
      headSha: await this.resolveCommit(path),
      remoteUrl: remoteResult.stdout.trim() || null,
    };
  }

  async status(path: string): Promise<GitStatus> {
    const output = await this.output(["status", "--porcelain=v1"], path);
    const entries = output ? output.split(/\r?\n/).filter(Boolean) : [];
    return { dirty: entries.length > 0, entries };
  }

  async resolveCommit(path: string, ref = "HEAD"): Promise<string> {
    return await this.output(["rev-parse", "--verify", `${ref}^{commit}`], path);
  }

  async createBranch(path: string, branchName: string, baseCommit: string): Promise<void> {
    validateBranchName(branchName);
    await this.runner.run(["branch", branchName, baseCommit], { cwd: path });
  }

  async createWorktree(
    path: string,
    worktreePath: string,
    branchName: string,
    baseCommit: string,
  ): Promise<void> {
    validateBranchName(branchName);
    await this.runner.run(["worktree", "add", "-b", branchName, worktreePath, baseCommit], {
      cwd: path,
    });
  }

  async removeWorktree(path: string, worktreePath: string): Promise<void> {
    await this.runner.run(["worktree", "remove", "--force", worktreePath], { cwd: path });
  }

  async commit(path: string, message: string): Promise<string | null> {
    if (!(await this.status(path)).dirty) return null;
    await this.runner.run(["add", "--all"], { cwd: path });
    await this.runner.run(["commit", "--message", message], { cwd: path });
    return await this.resolveCommit(path);
  }

  async diff(path: string): Promise<string> {
    return await this.output(["diff", "HEAD"], path);
  }

  async push(path: string, remote: string, branchName: string): Promise<void> {
    validateBranchName(branchName);
    await this.runner.run(["push", "--set-upstream", remote, branchName], { cwd: path });
  }

  private async output(args: readonly string[], cwd: string): Promise<string> {
    const result = await this.runner.run(args, { cwd });
    return result.stdout.trim();
  }
}
