import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportTelemetry } from "../src/export.js";
import { newEventId, nowIso, type TelemetryRepository } from "../src/index.js";
import { createTelemetryTestContext, TEST_ORGANIZATION, TEST_SESSION } from "../src/test-utils.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];
const dirs: string[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  const dir = mkdtempSync(join(tmpdir(), "aaspai-export-"));
  dirs.push(dir);
  return { ...context, dir };
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function seed(repo: TelemetryRepository, org: string) {
  const now = nowIso();
  repo.insertLogs([
    {
      id: newEventId("tlog"),
      organizationId: org,
      observedAt: now,
      receivedAt: now,
      provider: "claude-code",
      sourceKind: "otlp",
      eventName: "transcript.message",
      body: "export me",
      severityText: "INFO",
      severityNumber: 9,
      sessionId: TEST_SESSION,
      attributes: { "session.id": TEST_SESSION },
      dedupKey: `export:log:${org}`,
      rawAvailable: true,
      raw: { line: "export me" },
    },
  ]);
  repo.insertSpans([
    {
      id: newEventId("tsp"),
      organizationId: org,
      observedAt: now,
      receivedAt: now,
      provider: "codex_cli_rs",
      sourceKind: "otlp",
      traceId: `trace-export-${org}`,
      spanId: "span-parent",
      name: "root",
      status: "ok",
      startTime: now,
      endTime: now,
      rawAvailable: false,
    },
    {
      id: newEventId("tsp"),
      organizationId: org,
      observedAt: now,
      receivedAt: now,
      provider: "codex_cli_rs",
      sourceKind: "otlp",
      traceId: `trace-export-${org}`,
      spanId: "span-child",
      parentSpanId: "span-parent",
      name: "child",
      status: "ok",
      startTime: now,
      endTime: now,
      rawAvailable: false,
    },
  ]);
  repo.insertMetrics([
    {
      id: newEventId("tmet"),
      organizationId: org,
      observedAt: now,
      receivedAt: now,
      provider: "claude-code",
      sourceKind: "otlp",
      name: "claude_code.token.usage",
      metricType: "sum",
      value: 100,
      attributes: { type: "input" },
      dedupKey: `export:metric:${org}`,
      rawAvailable: false,
    },
  ]);
}

describe("export (OBS-T230..242)", () => {
  it("exports logs, spans, metrics with a manifest (T230/231/205)", async () => {
    const { repo, dir } = await setup();
    seed(repo, TEST_ORGANIZATION);
    const summary = await exportTelemetry(repo, {
      organizationId: TEST_ORGANIZATION,
      outputDir: dir,
      includeSessions: true,
    });
    expect(summary.counts.logs).toBe(1);
    expect(summary.counts.spans).toBe(2);
    expect(summary.counts.metrics).toBe(1);
    expect(existsSync(join(dir, "logs.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);

    const logsJsonl = readFileSync(join(dir, "logs.jsonl"), "utf8");
    expect(logsJsonl).toContain("export me");

    const manifest = JSON.parse(readFileSync(summary.manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.organizationId).toBe(TEST_ORGANIZATION);
    expect(manifest.files.length).toBeGreaterThan(0);
    // checksums present
    for (const f of manifest.files) {
      expect(f.checksumSha256).toBeDefined();
    }
  });

  it("preserves trace parent/child relationships (T231)", async () => {
    const { repo, dir } = await setup();
    seed(repo, TEST_ORGANIZATION);
    await exportTelemetry(repo, { organizationId: TEST_ORGANIZATION, outputDir: dir });
    const traces = readFileSync(join(dir, "traces.jsonl"), "utf8");
    expect(traces).toContain("span-parent");
    expect(traces).toContain("span-child");
    expect(traces).toContain("parentSpanId");
  });

  it("creates a valid ZIP bundle with a manifest (T235)", async () => {
    const { repo, dir } = await setup();
    seed(repo, TEST_ORGANIZATION);
    const summary = await exportTelemetry(repo, {
      organizationId: TEST_ORGANIZATION,
      outputDir: dir,
      createZip: true,
    });
    const zip = summary.files.find((f) => f.name.endsWith(".zip"));
    expect(zip).toBeDefined();
    const zipBytes = readFileSync(join(dir, zip!.name));
    // ZIP local file header magic
    expect(zipBytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("does not include another tenant (T237)", async () => {
    const { repo, dir } = await setup();
    seed(repo, TEST_ORGANIZATION);
    // A second org's data must not leak.
    seed(repo, "org_other");
    const summary = await exportTelemetry(repo, {
      organizationId: TEST_ORGANIZATION,
      outputDir: dir,
      includeSessions: true,
    });
    expect(summary.counts.logs).toBe(1);
    const logsJsonl = readFileSync(join(dir, "logs.jsonl"), "utf8");
    expect(logsJsonl).not.toContain('"organizationId":"org_other"');
  });

  it("redacts secrets in exported payloads (T238)", async () => {
    const { repo, hub, dir } = await setup();
    // Seed through the ingest path so redaction-before-persist applies.
    const { ingestOtlpRequest } = await import("../src/ingest.js");
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1750000000000000000",
                  body: { stringValue: "redact me" },
                  attributes: [
                    { key: "Authorization", value: { stringValue: "Bearer sk-secretvalue12345" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    ingestOtlpRequest(repo, hub, {
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
    await exportTelemetry(repo, { organizationId: TEST_ORGANIZATION, outputDir: dir });
    const logs = readFileSync(join(dir, "logs.jsonl"), "utf8");
    expect(logs).not.toContain("sk-secretvalue12345");
  });
});
