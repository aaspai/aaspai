import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m2", "api-scheduler");
const testDb = join(testRoot, "state.db");
const previousDb = process.env.AASPAI_DB;
const organizationId = "org_api_scheduler";

const verifier = new InMemoryAuthVerifier([
  {
    token: "scheduler-write",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "user_scheduler",
      organizationId,
      apiKeyId: "key_scheduler",
      roles: ["member"],
      scopes: ["read", "write"],
      authMethod: "api_key",
    }),
  },
]);

describe("execution scheduler API", () => {
  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await rm(testRoot, { recursive: true, force: true });
  });

  it("exposes dependency edges, progress, and bounded ready dispatch", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const goal = await store.createGoal({ organizationId, title: "API scheduler goal" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "API scheduler project",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: "workspace/m2/api-scheduler/project",
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: ".",
      contentHash: "api-scheduler",
    });
    const run = await store.createWorkflowRun({
      organizationId,
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "api-scheduler-run",
    });
    const first = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      title: "First",
      idempotencyKey: "api-scheduler-first",
    });
    const second = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      title: "Second",
      idempotencyKey: "api-scheduler-second",
    });
    const app = createApiApp({ authVerifier: verifier });
    const dependency = await app.request(`/v1/execution/work-items/${second.id}/dependencies`, {
      method: "POST",
      headers: {
        authorization: "Bearer scheduler-write",
        "content-type": "application/json",
      },
      body: JSON.stringify({ dependsOnWorkItemId: first.id }),
    });
    expect(dependency.status).toBe(201);

    const progress = await app.request(`/v1/execution/goals/${goal.id}/progress`, {
      headers: { authorization: "Bearer scheduler-write" },
    });
    expect(progress.status).toBe(200);
    await expect(progress.json()).resolves.toMatchObject({
      data: { total: 2, completed: 0, percent: 0 },
    });

    const schedule = await app.request(`/v1/execution/workflows/${run.id}/schedule`, {
      method: "POST",
      headers: {
        authorization: "Bearer scheduler-write",
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "agent_scheduler", harness: "dry_run_local" }),
    });
    expect(schedule.status).toBe(202);
    await expect(schedule.json()).resolves.toMatchObject({
      data: { dispatched: [{ workItem: { id: first.id } }] },
    });
  });
});
