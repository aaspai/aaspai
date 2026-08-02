import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const root = resolve("workspace", "strategic-api");
const previousDb = process.env.AASPAI_DB;
const principal = authPrincipalSchema.parse({
  protocolVersion: 1,
  userId: "founder",
  organizationId: "org_api",
  apiKeyId: "key_api",
  roles: ["owner"],
  scopes: ["read", "write"],
  authMethod: "api_key",
});
const verifier = new InMemoryAuthVerifier([{ token: "write", principal }]);

describe("strategic command API", () => {
  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
    runMigrations(getDefaultDb());
  });
  afterAll(async () => {
    await closeDefaultDb();
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });

  it("accepts typed setup and exposes the same strategic summary", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const setup = await app.request("/v1/company/setup", {
      method: "POST",
      headers: { authorization: "Bearer write", "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "api-setup",
        description: "A measured company",
        ceoAgentId: "agent/ceo",
        operatorAgentId: "agent/operator",
        objectives: [{ title: "Acquire customers", successCriteria: ["10 customers"] }],
      }),
    });
    expect(setup.status).toBe(201);
    const summary = await app.request("/v1/company/strategic-summary", {
      headers: { authorization: "Bearer write" },
    });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      data: { profile: { lifecycleStatus: "draft" }, objectives: [{ title: "Acquire customers" }] },
    });
  });
});
