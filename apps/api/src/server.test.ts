import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m1", "api-auth");
const testDb = join(testRoot, "state.db");
const previousDb = process.env.AASPAI_DB;

function principal(
  organizationId: string,
  scopes: ("read" | "write")[],
): ReturnType<typeof authPrincipalSchema.parse> {
  return authPrincipalSchema.parse({
    protocolVersion: 1,
    userId: `user_${organizationId}`,
    organizationId,
    apiKeyId: `key_${organizationId}`,
    roles: ["member"],
    scopes,
    authMethod: "api_key",
  });
}

const verifier = new InMemoryAuthVerifier([
  { token: "write-org-a", principal: principal("org_a", ["write"]) },
  { token: "read-org-a", principal: principal("org_a", ["read"]) },
  { token: "write-org-b", principal: principal("org_b", ["write"]) },
]);

describe("execution API authorization", () => {
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

  it("fails closed when execution authentication is not configured", async () => {
    const response = await createApiApp().request("/v1/execution/work-items/missing");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "auth_unconfigured" });
  });

  it("derives the work-item organization from the authenticated principal", async () => {
    const response = await createApiApp({ authVerifier: verifier }).request(
      "/v1/execution/work-items",
      {
        method: "POST",
        headers: {
          authorization: "Bearer write-org-a",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          goalId: "goal_api",
          projectId: "project_api",
          repositoryId: "repo_api",
          title: "Authorized work",
          idempotencyKey: "api-auth-work",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { organizationId: "org_a" } });
  });

  it("rejects an organization override and cross-organization reads", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const override = await app.request("/v1/execution/work-items", {
      method: "POST",
      headers: {
        authorization: "Bearer write-org-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: "org_b",
        goalId: "goal_api",
        projectId: "project_api",
        repositoryId: "repo_api",
        title: "Cross-company work",
        idempotencyKey: "api-auth-override",
      }),
    });
    expect(override.status).toBe(403);

    const created = await app.request("/v1/execution/work-items", {
      method: "POST",
      headers: {
        authorization: "Bearer write-org-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        goalId: "goal_api",
        projectId: "project_api",
        repositoryId: "repo_api",
        title: "Cross-company read fixture",
        idempotencyKey: "api-auth-cross-read",
      }),
    });
    const createdBody = (await created.json()) as { data?: { id?: string } };
    const crossCompany = await app.request(
      `/v1/execution/work-items/${createdBody.data?.id ?? "missing"}`,
      {
        headers: { authorization: "Bearer write-org-b" },
      },
    );
    expect(crossCompany.status).toBe(403);
  });

  it("enforces read and write scopes", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const readAttempt = await app.request("/v1/execution/work-items/missing", {
      headers: { authorization: "Bearer read-org-a" },
    });
    expect(readAttempt.status).toBe(404);

    const writeAttempt = await app.request("/v1/execution/work-items", {
      method: "POST",
      headers: {
        authorization: "Bearer read-org-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        goalId: "goal_api",
        projectId: "project_api",
        repositoryId: "repo_api",
        title: "Should be denied",
        idempotencyKey: "api-auth-read-only",
      }),
    });
    expect(writeAttempt.status).toBe(403);
  });

  it("returns company-scoped operational health", async () => {
    const organizationId = "org_health_api";
    const store = new ExecutionStore(getDefaultDb().db);
    const goal = await store.createGoal({ organizationId, title: "API health goal" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "API health project",
    });
    await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: "repo_health_api",
      title: "Blocked API work",
      status: "blocked",
      idempotencyKey: "api-health-blocked",
    });
    const healthVerifier = new InMemoryAuthVerifier([
      { token: "read-health", principal: principal(organizationId, ["read"]) },
    ]);

    const response = await createApiApp({ authVerifier: healthVerifier }).request(
      "/v1/execution/company/health",
      { headers: { authorization: "Bearer read-health" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        organizationId,
        status: "at_risk",
        totalGoals: 1,
        totalProjects: 1,
        blockedWork: 1,
        signals: [expect.objectContaining({ code: "blocked_work" })],
      },
    });
  });
});
