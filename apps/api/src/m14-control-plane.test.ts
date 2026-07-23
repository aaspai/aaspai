import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import {
  closeDefaultDb,
  getDefaultDb,
  runMigrations,
  sessionEvents,
  sessions,
  wakeups,
} from "@aaspai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m14", "control-plane");
const testDb = join(testRoot, "state.db");
const previousDb = process.env.AASPAI_DB;

function principal(organizationId: string, scopes: ("read" | "write")[]) {
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
  { token: "read-a", principal: principal("org_a", ["read"]) },
  { token: "write-a", principal: principal("org_a", ["write"]) },
  { token: "read-b", principal: principal("org_b", ["read"]) },
  { token: "write-b", principal: principal("org_b", ["write"]) },
]);

describe("M14 control-plane boundaries", () => {
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

  it("fails closed on legacy sessions and loops", async () => {
    const app = createApiApp();
    expect((await app.request("/v1/sessions")).status).toBe(503);
    expect((await app.request("/v1/loops")).status).toBe(503);
    expect((await app.request("/v1/loops/example/fire", { method: "POST" })).status).toBe(503);
  });

  it("uses the authenticated organization for legacy session writes and reads", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const queued = await app.request("/v1/sessions", {
      method: "POST",
      headers: { authorization: "Bearer write-a", "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent_a", prompt: "hello" }),
    });
    expect(queued.status).toBe(202);
    const queuedBody = (await queued.json()) as { data: { sessionId: string } };

    const handle = getDefaultDb();
    const wakeup = (
      await handle.db.select().from(wakeups).where(eq(wakeups.organizationId, "org_a")).limit(1)
    )[0]!;
    await handle.db.insert(sessions).values({
      id: queuedBody.data.sessionId,
      organizationId: "org_a",
      wakeupId: wakeup.id,
      agentId: "agent_a",
      adapter: "dry_run_local",
      runtimeJson: "{}",
      prompt: "hello",
      configJson: "{}",
      status: "succeeded",
      startedAt: new Date().toISOString(),
    });
    await handle.db.insert(sessionEvents).values({
      sessionId: queuedBody.data.sessionId,
      ts: new Date().toISOString(),
      kind: "result",
      payloadJson: "{}",
      seq: 1,
    });

    const visible = await app.request("/v1/sessions", {
      headers: { authorization: "Bearer read-a" },
    });
    expect(visible.status).toBe(200);
    await expect(visible.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ organizationId: "org_a" })],
    });

    const crossCompany = await app.request(`/v1/sessions/${queuedBody.data.sessionId}`, {
      headers: { authorization: "Bearer read-b" },
    });
    expect(crossCompany.status).toBe(404);
    const crossEvents = await app.request(`/v1/sessions/${queuedBody.data.sessionId}/events`, {
      headers: { authorization: "Bearer read-b" },
    });
    expect(crossEvents.status).toBe(404);
  });

  it("exposes the same normalized capability shape through the API", async () => {
    const app = createApiApp({ authVerifier: verifier });
    const response = await app.request("/v1/providers/capabilities", {
      headers: { authorization: "Bearer read-a" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        adapters: Array<{ capabilities?: { execute: boolean } }>;
        runtimes: Array<{ capabilities?: { execute: boolean } }>;
      };
    };
    expect(body.data.adapters.length).toBeGreaterThan(0);
    expect(body.data.runtimes.length).toBeGreaterThan(0);
    expect(
      body.data.adapters.every((item) => typeof item.capabilities?.execute === "boolean"),
    ).toBe(true);
    expect(
      body.data.runtimes.every((item) => typeof item.capabilities?.execute === "boolean"),
    ).toBe(true);
  });
});
