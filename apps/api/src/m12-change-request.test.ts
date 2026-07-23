import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { getDefaultDb, repositories, runMigrations } from "@aaspai/db";
import type { PullRequest, PullRequestInput } from "@aaspai/git";
import { LocalGitRepository } from "@aaspai/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const execFileAsync = promisify(execFile);
const testRoot = resolve("workspace", "m12", "api-change-request");
const testDb = join(testRoot, "state.db");
const principal = authPrincipalSchema.parse({
  protocolVersion: 1,
  userId: "user_org_api_m12",
  organizationId: "org_api_m12",
  apiKeyId: "key_org_api_m12",
  roles: ["member"],
  scopes: ["read", "write"],
  authMethod: "api_key",
});
const verifier = new InMemoryAuthVerifier([
  { token: "api-m12-write", principal },
  { token: "api-m12-read", principal: { ...principal, scopes: ["read"] } },
]);

describe("autonomy change request API", () => {
  let repositoryPath: string;

  beforeAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
    repositoryPath = await createRepository();
    const remotePath = join(testRoot, "definitions-remote.git");
    await git(testRoot, ["init", "--bare", remotePath]);
    await git(repositoryPath, ["remote", "add", "origin", remotePath]);
    await git(repositoryPath, ["push", "--set-upstream", "origin", "main"]);
    await getDefaultDb().db.insert(repositories).values({
      id: "repo_api_definitions",
      organizationId: "org_api_m12",
      projectId: null,
      purpose: "company_definitions",
      provider: "github",
      localPath: repositoryPath,
      remoteUrl: "https://github.com/aaspai/definitions.git",
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    await getDefaultDb().close();
    delete process.env.AASPAI_DB;
    await rm(testRoot, { recursive: true, force: true });
  });

  it("publishes an approved proposal and lists it through authenticated routes", async () => {
    const provider = new FakePullRequestProvider();
    const app = createApiApp({
      authVerifier: verifier,
      git: new LocalGitRepository(),
      pullRequestProvider: provider,
    });
    const proposalResponse = await app.request("/v1/company/autonomy-proposals", {
      method: "POST",
      headers: { authorization: "Bearer api-m12-write", "content-type": "application/json" },
      body: JSON.stringify({
        targetType: "agent",
        targetId: "agent/ceo",
        fromLevel: "L1",
        toLevel: "L2",
        rationale: "The API test has verified evidence.",
      }),
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = (await proposalResponse.json()) as { data: { id: string } };
    const decisionResponse = await app.request(
      `/v1/company/autonomy-proposals/${encodeURIComponent(proposal.data.id)}/decision`,
      {
        method: "POST",
        headers: { authorization: "Bearer api-m12-write", "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", reason: "Ship as a PR" }),
      },
    );
    expect(decisionResponse.status).toBe(200);

    const requestResponse = await app.request(
      `/v1/company/autonomy-proposals/${encodeURIComponent(proposal.data.id)}/change-request`,
      {
        method: "POST",
        headers: { authorization: "Bearer api-m12-write", "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId: "repo_api_definitions",
          workspaceRoot: join(testRoot, "workspaces"),
        }),
      },
    );
    expect(requestResponse.status).toBe(201);
    const request = (await requestResponse.json()) as {
      data: { status: string; pullRequestNumber: number };
    };
    expect(request.data).toMatchObject({ status: "published", pullRequestNumber: 7 });

    const listed = await app.request("/v1/company/autonomy-change-requests", {
      headers: { authorization: "Bearer api-m12-read" },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { data: Array<{ status: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.status).toBe("published");
    await expect(readFile(join(repositoryPath, "agents/ceo/AGENT.md"), "utf8")).resolves.toContain(
      "autonomyLevel: L1",
    );
  }, 20_000);
});

async function createRepository(): Promise<string> {
  const repositoryPath = join(testRoot, "definitions");
  await mkdir(repositoryPath, { recursive: true });
  await git(testRoot, ["init", repositoryPath]);
  await git(repositoryPath, ["config", "user.email", "test@aaspai.local"]);
  await git(repositoryPath, ["config", "user.name", "Aaspai Test"]);
  await git(repositoryPath, ["branch", "-M", "main"]);
  await mkdir(join(repositoryPath, "agents", "ceo"), { recursive: true });
  await writeFile(
    join(repositoryPath, "agents", "ceo", "AGENT.md"),
    "---\nid: agent/ceo\ntype: Agent\nautonomyLevel: L1\n---\n",
  );
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, ["commit", "-m", "fixture"]);
  return repositoryPath;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

class FakePullRequestProvider {
  async create(input: PullRequestInput): Promise<PullRequest> {
    return {
      number: 7,
      url: "https://github.com/aaspai/definitions/pull/7",
      state: "open",
      head: input.head,
      base: input.base,
    };
  }

  async get(_repository: string, _number: number): Promise<PullRequest> {
    return {
      number: 7,
      url: "https://github.com/aaspai/definitions/pull/7",
      state: "open",
      head: "autonomy/test",
      base: "main",
    };
  }
}
