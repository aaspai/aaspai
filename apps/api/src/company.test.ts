import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m10", "api-company");
const testDb = join(testRoot, "state.db");
const previousDb = process.env.AASPAI_DB;
const principal = (organizationId: string, scopes: ("read" | "write")[]) =>
  authPrincipalSchema.parse({
    protocolVersion: 1,
    userId: `user_${organizationId}`,
    organizationId,
    apiKeyId: `key_${organizationId}`,
    roles: ["member"],
    scopes,
    authMethod: "api_key",
  });
const verifier = new InMemoryAuthVerifier([
  { token: "write-company", principal: principal("org_company", ["read", "write"]) },
  { token: "read-company", principal: principal("org_company", ["read"]) },
]);

describe("company operations API", () => {
  beforeAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
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

  it("keeps company operations authenticated and organization-scoped", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const denied = await app.request("/v1/company/operations", {
      headers: { authorization: "Bearer read-company" },
    });
    expect(denied.status).toBe(200);
    const created = await app.request("/v1/company/departments", {
      method: "POST",
      headers: { authorization: "Bearer write-company", "content-type": "application/json" },
      body: JSON.stringify({ name: "Operations" }),
    });
    expect(created.status).toBe(201);
    const exported = await app.request("/v1/company/export", {
      headers: { authorization: "Bearer read-company" },
    });
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as { data: { kind: string; departments: unknown[] } };
    expect(body.data.kind).toBe("aaspai.company");
    expect(body.data.departments).toHaveLength(1);
  });

  it("allows read-only validation but blocks import mutation", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const bundle = {
      kind: "aaspai.company",
      protocolVersion: 1,
      exportedAt: new Date().toISOString(),
      departments: [],
      members: [],
      serviceAgents: [],
      autonomyProposals: [],
    };
    const validation = await app.request("/v1/company/import/validate", {
      method: "POST",
      headers: { authorization: "Bearer read-company", "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    expect(validation.status).toBe(200);
    const apply = await app.request("/v1/company/import/apply", {
      method: "POST",
      headers: { authorization: "Bearer read-company", "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    expect(apply.status).toBe(403);
  });

  it("exposes scoped authority and routing decisions", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const agent = await app.request("/v1/company/service-agents", {
      method: "POST",
      headers: { authorization: "Bearer write-company", "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "agent/security",
        metadata: { capabilities: ["security"] },
      }),
    });
    expect(agent.status).toBe(201);
    const edge = await app.request("/v1/company/authority-edges", {
      method: "POST",
      headers: { authorization: "Bearer write-company", "content-type": "application/json" },
      body: JSON.stringify({
        fromAgentId: "agent/ceo",
        toAgentId: "agent/security",
        relation: "manages",
      }),
    });
    expect(edge.status).toBe(201);
    const routed = await app.request("/v1/company/routes/preview", {
      method: "POST",
      headers: { authorization: "Bearer read-company", "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "route/api-security",
        capability: "security",
        title: "API security review",
        description: "Review the API boundary.",
      }),
    });
    expect(routed.status).toBe(200);
    const routedBody = (await routed.json()) as {
      data: { status: string; selectedAgentId: string };
    };
    expect(routedBody.data).toMatchObject({ status: "routed", selectedAgentId: "agent/security" });
  });
});
