import { afterEach, describe, expect, it } from "vitest";
import { backfillFromControlPlane } from "../src/backfill.js";
import { newEventId, toIso } from "../src/canonical.js";
import { projectSession } from "../src/projection.js";
import type { TelemetryRepository } from "../src/repository.js";
import { createTelemetryTestContext, TEST_ORGANIZATION, TEST_SESSION } from "../src/test-utils.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
});

function logRow(
  repo: TelemetryRepository,
  overrides: Partial<Parameters<typeof repo.insertLogs>[0][number]> = {},
) {
  return {
    id: newEventId("tlog"),
    organizationId: TEST_ORGANIZATION,
    observedAt: "2026-08-01T10:00:00.000Z",
    receivedAt: "2026-08-01T10:00:00.100Z",
    provider: "claude-code",
    sourceKind: "otlp",
    serviceName: "claude-code",
    eventName: "transcript.message",
    body: "hello",
    severityText: "INFO",
    severityNumber: 9,
    sessionId: TEST_SESSION,
    attributes: { "event.name": "transcript.message" },
    rawAvailable: false,
    ...overrides,
  };
}

describe("telemetry repository", () => {
  it("inserts and queries logs with tenant scoping", async () => {
    const { repo } = await setup();
    repo.insertLogs([
      logRow(repo),
      logRow(repo, {
        id: newEventId("tlog"),
        body: "second",
        observedAt: "2026-08-01T10:00:01.000Z",
      }),
      logRow(repo, { id: newEventId("tlog"), organizationId: "org_other", body: "other tenant" }),
    ]);
    const result = repo.queryLogs({ organizationId: TEST_ORGANIZATION, limit: 10 });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.body).sort()).toEqual(["hello", "second"]);
  });

  it("orders deterministically and paginates by cursor", async () => {
    const { repo } = await setup();
    const rows = Array.from({ length: 5 }, (_, i) =>
      logRow(repo, {
        id: newEventId("tlog"),
        body: `log-${i}`,
        observedAt: `2026-08-01T10:00:0${i}.000Z`,
      }),
    );
    repo.insertLogs(rows);
    const page1 = repo.queryLogs({ organizationId: TEST_ORGANIZATION, limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = repo.queryLogs({
      organizationId: TEST_ORGANIZATION,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.rows).toHaveLength(2);
    const bodies = [...page1.rows, ...page2.rows].map((r) => r.body);
    expect(new Set(bodies).size).toBe(4);
  });

  it("deduplicates spans by (org, traceId, spanId)", async () => {
    const { repo } = await setup();
    const span = {
      id: newEventId("tsp"),
      organizationId: TEST_ORGANIZATION,
      observedAt: "2026-08-01T10:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.100Z",
      provider: "claude-code",
      sourceKind: "otlp",
      traceId: "abc123",
      spanId: "def456",
      name: "test-span",
      status: "ok" as const,
      startTime: "2026-08-01T10:00:00.000Z",
    };
    const first = repo.insertSpans([span]);
    const second = repo.insertSpans([span]);
    expect(first.inserted).toBe(1);
    expect(second.skipped).toBe(1);
    expect(repo.getTraceSpans("abc123", TEST_ORGANIZATION)).toHaveLength(1);
  });

  it("supports search across body and attributes", async () => {
    const { repo } = await setup();
    repo.insertLogs([logRow(repo, { id: newEventId("tlog"), body: "connection timeout to db" })]);
    const result = repo.queryLogs({ organizationId: TEST_ORGANIZATION, search: "timeout" });
    expect(result.rows).toHaveLength(1);
  });

  it("projects sessions and builds transcripts", async () => {
    const { repo } = await setup();
    const logs = [
      logRow(repo, {
        id: newEventId("tlog"),
        eventName: "transcript.message",
        body: "user ask",
        attributes: { "message.role": "user", "session.id": TEST_SESSION },
      }),
      logRow(repo, {
        id: newEventId("tlog"),
        eventName: "transcript.message",
        body: "Tool call: edit",
        toolName: "edit",
        attributes: { "message.role": "tool_use", "tool.name": "edit", "session.id": TEST_SESSION },
      }),
    ];
    repo.insertLogs(logs);
    const projection = projectSession({
      organizationId: TEST_ORGANIZATION,
      sessionId: TEST_SESSION,
      provider: "claude-code",
      logs,
    });
    expect(projection.messageCount).toBe(2);
    expect(projection.toolCallCount).toBe(1);
    repo.upsertSessionSummary({
      id: "tsess_x",
      organizationId: TEST_ORGANIZATION,
      provider: "claude-code",
      sessionId: TEST_SESSION,
      firstSeenAt: projection.firstSeenAt,
      lastSeenAt: projection.lastSeenAt,
      messageCount: projection.messageCount,
      toolCallCount: projection.toolCallCount,
    });
    repo.insertTranscriptMessages(projection.transcript);
    const detail = repo.getSessionDetail(TEST_SESSION, TEST_ORGANIZATION);
    expect(detail?.summary).toBeDefined();
    expect(detail?.messages).toHaveLength(2);
  });

  it("scopes import state to the tenant (OBS-T173/174)", async () => {
    const { repo } = await setup();
    const now = toIso(new Date())!;
    repo.setImportState({
      organizationId: TEST_ORGANIZATION,
      source: "claude-code",
      filePath: "/home/a/session.jsonl",
      fileHash: "abc",
      importedAt: now,
      recordCount: 10,
      byteOffset: 500,
      messageCount: 10,
      status: "current",
    });
    repo.setImportState({
      organizationId: "org_other",
      source: "claude-code",
      filePath: "/home/a/session.jsonl",
      fileHash: "def",
      importedAt: now,
      recordCount: 5,
      byteOffset: 250,
      messageCount: 5,
      status: "current",
    });
    // Same (source, file) for two orgs must not collide.
    const mine = repo.getImportState(TEST_ORGANIZATION, "claude-code", "/home/a/session.jsonl");
    expect(mine?.recordCount).toBe(10);
    const theirs = repo.getImportState("org_other", "claude-code", "/home/a/session.jsonl");
    expect(theirs?.recordCount).toBe(5);
    // Listing is org-scoped.
    expect(repo.listImportState(TEST_ORGANIZATION)).toHaveLength(1);
    expect(repo.listImportState("org_other")).toHaveLength(1);
    expect(repo.listImportState("org_third")).toHaveLength(0);
  });

  it("backfills session events idempotently", async () => {
    const { repo, handle } = await setup();
    // Seed a session + session_event row in the control plane tables.
    const now = toIso(new Date())!;
    const raw = (
      handle as unknown as { raw: { prepare(sql: string): { run(...args: unknown[]): void } } }
    ).raw;
    raw
      .prepare(
        "INSERT INTO sessions (id, organization_id, wakeup_id, agent_id, adapter, runtime_json, prompt, config_json, status, started_at) VALUES (?, ?, 'wake_x', 'agent_x', 'dry_run_local', '{}', 'hi', '{}', 'succeeded', ?)",
      )
      .run(TEST_SESSION, TEST_ORGANIZATION, now);
    raw
      .prepare(
        "INSERT INTO session_events (session_id, ts, kind, payload_json, seq) VALUES (?, ?, 'assistant', ?, 1)",
      )
      .run(TEST_SESSION, now, JSON.stringify({ stream: "stdout", text: "hello from session" }));

    const first = backfillFromControlPlane(repo, { organizationId: TEST_ORGANIZATION });
    expect(first.insertedLogs).toBeGreaterThanOrEqual(1);
    const second = backfillFromControlPlane(repo, { organizationId: TEST_ORGANIZATION });
    expect(second.insertedLogs).toBe(0);

    const dry = backfillFromControlPlane(repo, { organizationId: TEST_ORGANIZATION, dryRun: true });
    expect(dry.dryRun).toBe(true);
  });
});
