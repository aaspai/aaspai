import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m11", "api");
const testDb = join(testRoot, "state.db");
const verifier = new InMemoryAuthVerifier([
  {
    token: "m11-write",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "user_m11",
      organizationId: "org_m11_api",
      apiKeyId: "key_m11",
      roles: ["member"],
      scopes: ["read", "write"],
      authMethod: "api_key",
    }),
  },
]);

describe("M11 scheduling API", () => {
  beforeAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    delete process.env.AASPAI_DB;
    await rm(testRoot, { recursive: true, force: true });
  });

  it("accepts and returns a normalized multi-repository WorkItem", async () => {
    const response = await createApiApp({ authVerifier: verifier }).request(
      "/v1/execution/work-items",
      {
        method: "POST",
        headers: {
          authorization: "Bearer m11-write",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          goalId: "goal_m11_api",
          projectId: "project_m11_api",
          repositoryId: "repo_primary",
          repositoryIds: ["repo_primary", "repo_secondary"],
          title: "Coordinate repositories",
          idempotencyKey: "m11-api-work",
        }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        repositoryId: "repo_primary",
        repositoryIds: ["repo_primary", "repo_secondary"],
      },
    });
  });
});
