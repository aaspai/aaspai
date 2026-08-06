import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, getDefaultDb, runMigrations } from "@aaspai/db";
import { TelemetryRepository } from "@aaspai/telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "observer-api-test");
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

describe("telemetry API", () => {
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    mkdirSync(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
    app = createApiApp({ authVerifier: verifier });
  });

  afterAll(async () => {
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await closeDefaultDb();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function post(
    path: string,
    body: unknown,
    token: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function get(path: string, token: string): Promise<Response> {
    return app.request(path, { headers: { authorization: `Bearer ${token}` } });
  }
  it("rejects unauthenticated queries", async () => {
    const res = await app.request("/v1/telemetry/logs");
    expect(res.status).toBe(401);
  });

  it("ingests OTLP logs and queries them back", async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
          },
          scopeLogs: [
            {
              scope: { name: "claude" },
              logRecords: [
                {
                  timeUnixNano: "1750000000000000000",
                  body: { stringValue: "api test log" },
                  attributes: [{ key: "session.id", value: { stringValue: "sess_api1" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await post("/v1/telemetry/logs", payload, "write-org-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partialSuccess: { rejectedLogRecords: number } };
    expect(body.partialSuccess.rejectedLogRecords).toBe(0);

    const query = await get("/v1/telemetry/logs", "read-org-a");
    expect(query.status).toBe(200);
    const data = (await query.json()) as {
      data: Array<{ body: string; sessionId: string }>;
      total: number;
    };
    expect(data.total).toBe(1);
    expect(data.data[0]?.body).toBe("api test log");
    expect(data.data[0]?.sessionId).toBe("sess_api1");
  });

  it("enforces tenant isolation on queries", async () => {
    const query = await get("/v1/telemetry/logs", "write-org-b");
    const data = (await query.json()) as { data: unknown[]; total: number };
    expect(data.total).toBe(0);
  });

  it("rejects malformed OTLP and records an ingestion error", async () => {
    const res = await post("/v1/telemetry/logs", "{not json", "write-org-a", {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200); // OTLP keeps the request accepted; error is durable
    const repo = new TelemetryRepository(getDefaultDb());
    const errors = repo.queryIngestErrors({ organizationId: "org_a" });
    expect(errors.rows.length).toBeGreaterThan(0);
  });

  it("supports dashboard CRUD + widgets", async () => {
    const created = await post(
      "/v1/telemetry/dashboards",
      { name: "Observer", isDefault: true },
      "write-org-a",
    );
    expect(created.status).toBe(201);
    const dash = (await created.json()) as { data: { id: string } };
    const dashId = dash.data.id;

    const list = await get("/v1/telemetry/dashboards", "read-org-a");
    expect(list.status).toBe(200);

    const widget = await post(
      `/v1/telemetry/dashboards/${dashId}/widgets`,
      {
        widgetType: "metric_chart",
        title: "Cost",
        gridColumn: 1,
        gridRow: 1,
        config: { metricName: "claude_code.cost.usage" },
      },
      "write-org-a",
    );
    expect(widget.status).toBe(201);

    const positions = await app.request(`/v1/telemetry/dashboards/${dashId}/widgets/positions`, {
      method: "PUT",
      headers: { authorization: "Bearer write-org-a", "content-type": "application/json" },
      body: JSON.stringify({
        positions: [
          {
            id: ((await widget.json()) as { data: { id: string } }).data.id,
            gridColumn: 2,
            gridRow: 2,
          },
        ],
      }),
    });
    expect(positions.status).toBe(200);

    const del = await app.request(`/v1/telemetry/dashboards/${dashId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer write-org-a" },
    });
    expect(del.status).toBe(200);
  });

  it("deletes data with confirmation and records audit", async () => {
    const res = await app.request("/v1/telemetry/data", {
      method: "DELETE",
      headers: { authorization: "Bearer write-org-a", "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["logs"], confirm: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { auditRecorded: boolean } };
    expect(body.data.auditRecorded).toBe(true);
  });

  it("rejects delete without confirmation", async () => {
    const res = await app.request("/v1/telemetry/data", {
      method: "DELETE",
      headers: { authorization: "Bearer write-org-a", "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["logs"] }),
    });
    expect(res.status).toBe(400);
  });

  it("exposes stats and services", async () => {
    const stats = await get("/v1/telemetry/stats", "read-org-a");
    expect(stats.status).toBe(200);
    const services = await get("/v1/telemetry/services", "read-org-a");
    expect(services.status).toBe(200);
  });

  it("replays persisted live events on SSE reconnect (OBS-T209/212)", async () => {
    // Ingest a log -> persists a live event.
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1750000000000000000",
                  body: { stringValue: "replay me" },
                  attributes: [{ key: "session.id", value: { stringValue: "sess_replay" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    await post("/v1/telemetry/logs", payload, "write-org-a");

    // First connect: no last-event-id -> must receive the replayed event.
    const first = await app.request("/v1/telemetry/stream", {
      headers: { authorization: "Bearer read-org-a" },
    });
    const firstText = await readSse(first, 400);
    expect(firstText).toContain("replay me");

    // Extract the LAST event id from the first stream and reconnect with it.
    const ids = [...firstText.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1]));
    const lastId = String(Math.max(0, ...ids));
    const second = await app.request("/v1/telemetry/stream", {
      headers: { authorization: "Bearer read-org-a", "last-event-id": lastId },
    });
    const secondText = await readSse(second, 600);
    expect(secondText).not.toContain("replay me");
  });

  it("ingests a native log line via the bridge and makes it replayable", async () => {
    const repo = new TelemetryRepository(getDefaultDb());
    repo.appendLiveEvent("org_a", "log", { body: "bridge event", sessionId: "sess_bridge" });
    const replayed = repo.queryLiveEvents("org_a", 0);
    expect(replayed.length).toBeGreaterThan(0);
    const last = replayed[replayed.length - 1];
    expect(last?.payload).toMatchObject({ body: "bridge event" });
  });
});

/** Read an SSE response for up to `ms` and return the accumulated text. */
async function readSse(response: Response, ms: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 50),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return text;
}
