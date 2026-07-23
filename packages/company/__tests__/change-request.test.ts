import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDb, type DbHandle, repositories, runMigrations } from "@aaspai/db";
import type { PullRequest, PullRequestInput } from "@aaspai/git";
import { LocalGitRepository } from "@aaspai/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanyOperationsError, CompanyOperationsService } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("Git-backed autonomy change requests", () => {
  let handle: DbHandle;
  let testDirectory: string;
  let previousDb: string | undefined;

  beforeEach(async () => {
    testDirectory = resolve("workspace", "m12", `company-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    previousDb = process.env.AASPAI_DB;
    process.env.AASPAI_DB = `sqlite:${join(testDirectory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
  });

  afterEach(async () => {
    await handle.close();
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("turns an approved proposal into one isolated commit and pull request", async () => {
    const organizationId = `org_m12_${randomUUID()}`;
    const repositoryId = `repo_definitions_${randomUUID()}`;
    const repositoryPath = await createRepository(
      "definitions",
      "agents/ceo/AGENT.md",
      "---\nid: agent/ceo\ntype: Agent\nautonomyLevel: L1\n---\n\n# CEO\n",
    );
    const remotePath = join(testDirectory, "definitions-remote.git");
    await git(testDirectory, ["init", "--bare", remotePath]);
    await git(repositoryPath, ["remote", "add", "origin", remotePath]);
    await git(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
    await handle.db.insert(repositories).values({
      id: repositoryId,
      organizationId,
      projectId: null,
      purpose: "company_definitions",
      provider: "github",
      localPath: repositoryPath,
      remoteUrl: "https://github.com/aaspai/definitions.git",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = new FakePullRequestProvider();
    const service = new CompanyOperationsService(handle.db, {
      git: new LocalGitRepository(),
      pullRequests: provider,
    });
    const proposal = await service.createAutonomyProposal({
      organizationId,
      targetType: "agent",
      targetId: "agent/ceo",
      fromLevel: "L1",
      toLevel: "L2",
      rationale: "Verified operation can take the next bounded autonomy level.",
      proposedBy: "user/owner",
    });
    await service.decideAutonomyProposal(
      organizationId,
      proposal.id,
      "approved",
      "user/owner",
      "Approved",
    );

    const request = await service.createAutonomyChangeRequest({
      organizationId,
      proposalId: proposal.id,
      repositoryId,
      workspaceRoot: join(testDirectory, "workspaces"),
      createdBy: "user/owner",
    });

    expect(request.status).toBe("published");
    expect(request.targetPath).toBe("agents/ceo/AGENT.md");
    expect(request.pullRequestNumber).toBe(42);
    expect(provider.created[0]).toMatchObject({
      repository: "https://github.com/aaspai/definitions.git",
      base: "main",
      head: request.branchName,
    });
    await expect(readFile(join(repositoryPath, "agents/ceo/AGENT.md"), "utf8")).resolves.toContain(
      "autonomyLevel: L1",
    );
    await expect(
      gitOutput(repositoryPath, ["show", `${request.branchName}:agents/ceo/AGENT.md`]),
    ).resolves.toContain("autonomyLevel: L2");
    await expect(
      readFile(
        join(testDirectory, "workspaces", "autonomy", proposal.id.replaceAll("/", "-")),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(
      service.createAutonomyChangeRequest({
        organizationId,
        proposalId: proposal.id,
        repositoryId,
        workspaceRoot: join(testDirectory, "workspaces"),
        createdBy: "user/owner",
      }),
    ).resolves.toEqual(request);
  }, 20_000);

  it("requires approval and records a failed request when the definition drifted", async () => {
    const organizationId = `org_m12_drift_${randomUUID()}`;
    const repositoryId = `repo_drifted_${randomUUID()}`;
    const repositoryPath = await createRepository(
      "definitions",
      "loops/research/LOOP.md",
      "---\nid: loop/research\ntype: LoopPattern\nautonomyLevel: L3\n---\n",
    );
    await handle.db.insert(repositories).values({
      id: repositoryId,
      organizationId,
      projectId: null,
      purpose: "company_definitions",
      provider: "local",
      localPath: repositoryPath,
      remoteUrl: null,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const service = new CompanyOperationsService(handle.db, {
      git: new LocalGitRepository(),
      pullRequests: new FakePullRequestProvider(),
    });
    const proposal = await service.createAutonomyProposal({
      organizationId,
      targetType: "loop",
      targetId: "loop/research",
      fromLevel: "L1",
      toLevel: "L2",
      rationale: "Test drift handling.",
      proposedBy: "user/owner",
    });
    await service.decideAutonomyProposal(
      organizationId,
      proposal.id,
      "approved",
      "user/owner",
      "Approved",
    );
    await expect(
      service.createAutonomyChangeRequest({
        organizationId,
        proposalId: proposal.id,
        repositoryId,
        workspaceRoot: join(testDirectory, "workspaces"),
        createdBy: "user/owner",
      }),
    ).rejects.toBeInstanceOf(CompanyOperationsError);
    await expect(service.listAutonomyChangeRequests(organizationId)).resolves.toMatchObject([
      { status: "failed", error: expect.stringContaining("expected L1") },
    ]);
  });

  async function createRepository(name: string, file: string, contents: string): Promise<string> {
    const repositoryPath = join(testDirectory, name);
    await git(testDirectory, ["init", repositoryPath]);
    await git(repositoryPath, ["config", "user.email", "test@aaspai.local"]);
    await git(repositoryPath, ["config", "user.name", "Aaspai Test"]);
    await git(repositoryPath, ["branch", "-M", "main"]);
    await mkdir(join(repositoryPath, file, ".."), { recursive: true });
    await writeFile(join(repositoryPath, file), contents);
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "fixture"]);
    return repositoryPath;
  }

  async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd, windowsHide: true });
  }

  async function gitOutput(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
    return result.stdout;
  }
});

class FakePullRequestProvider {
  readonly created: PullRequestInput[] = [];

  async create(input: PullRequestInput): Promise<PullRequest> {
    this.created.push(input);
    return {
      number: 42,
      url: "https://github.com/aaspai/definitions/pull/42",
      state: "open",
      head: input.head,
      base: input.base,
    };
  }

  async get(_repository: string, _number: number): Promise<PullRequest> {
    return {
      number: 42,
      url: "https://github.com/aaspai/definitions/pull/42",
      state: "open",
      head: "autonomy/test",
      base: "main",
    };
  }
}
