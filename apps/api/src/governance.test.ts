import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m3", "api-governance");
const testDb = join(testRoot, "state.db");
const organizationId = "org_api_governance";
const verifier = new InMemoryAuthVerifier([
  {
    token: "governance-write",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "human_reviewer",
      organizationId,
      apiKeyId: "key_governance",
      roles: ["member"],
      scopes: ["read", "write"],
      authMethod: "api_key",
    }),
  },
]);

describe("execution governance API", () => {
  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("exposes checker and approval transitions with organization authorization", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "API governed change",
      idempotencyKey: "api-governed-change",
      governance: {
        verification: { required: true, minEvidence: 1 },
        approval: { required: true, actorType: "human" },
      },
    });
    const app = createApiApp({ authVerifier: verifier });
    const schedule = await app.request(`/v1/execution/workflows/${fixture.run.id}/schedule`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({ agentId: "maker", harness: "dry_run_local" }),
    });
    expect(schedule.status).toBe(202);
    const scheduleBody = (await schedule.json()) as {
      data: { dispatched: Array<{ attempt: { id: string } }> };
    };
    const attempt = scheduleBody.data.dispatched[0]?.attempt;
    if (!attempt) throw new Error("scheduler did not dispatch governed work");
    await store.completeScheduledAttempt({ attemptId: attempt.id, status: "succeeded" });
    const verification = await store.getVerificationForWorkItem(item.id);
    expect(verification).not.toBeNull();

    const checkerResponse = await app.request(
      `/v1/execution/verifications/${verification?.id}/checker-attempts`,
      {
        method: "POST",
        headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
        body: JSON.stringify({ agentId: "checker", harness: "dry_run_local" }),
      },
    );
    expect(checkerResponse.status).toBe(201);
    const checker = (await checkerResponse.json()) as { data: { id: string } };
    const submit = await app.request(`/v1/execution/verifications/${verification?.id}/submit`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({
        checkerAttemptId: checker.data.id,
        status: "passed",
        summary: "verified",
        evidenceIds: ["test-result"],
      }),
    });
    expect(submit.status).toBe(200);
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    const decision = await app.request(`/v1/execution/approvals/${approval?.id}/decision`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: "reviewed" }),
    });
    expect(decision.status).toBe(200);
    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({ status: "completed" });
  });
});

async function createFixture(store: ExecutionStore) {
  const goal = await store.createGoal({ organizationId, title: "API governance goal" });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "API governance project",
  });
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: "workspace/m3/api-governance/project",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "api-governance-fixture",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    idempotencyKey: "api-governance-run",
  });
  return {
    run,
    lineage: {
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
    },
  };
}
