import { describe, expect, it } from "vitest";
import {
  TELEMETRY_SCHEMA_VERSION,
  telemetryDashboardSchema,
  telemetryDeletionResultSchema,
  telemetryExportManifestSchema,
  telemetryLogEventSchema,
  telemetryMetricSchema,
  telemetryQueryFilterSchema,
  telemetrySpanSchema,
} from "../src/telemetry.js";

/**
 * Contract validation tests (OBS-T001..T012).
 */

function logInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: "tlog_x",
    provider: "claude-code",
    sourceKind: "otlp",
    observedAt: "2026-08-01T10:00:00.000Z",
    receivedAt: "2026-08-01T10:00:00.100Z",
    organizationId: "org_a",
    body: "hello",
    severityText: "INFO",
    severityNumber: 9,
    parseStatus: "ok",
    rawAvailable: false,
    ...overrides,
  };
}

describe("telemetry contracts (OBS-T001..T012)", () => {
  it("accepts a valid normalized log (T001)", () => {
    expect(telemetryLogEventSchema.safeParse(logInput()).success).toBe(true);
  });

  it("accepts a valid span with parent (T002)", () => {
    const span = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "tsp_x",
      provider: "codex_cli_rs",
      sourceKind: "otlp",
      observedAt: "2026-08-01T10:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.100Z",
      organizationId: "org_a",
      traceId: "trace1",
      spanId: "span1",
      parentSpanId: "span0",
      name: "root",
      status: "ok",
      startTime: "2026-08-01T10:00:00.000Z",
      endTime: "2026-08-01T10:00:01.000Z",
      rawAvailable: false,
    };
    expect(telemetrySpanSchema.safeParse(span).success).toBe(true);
  });

  it("accepts an orphan span (T003)", () => {
    const span = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "tsp_x",
      provider: "codex_cli_rs",
      sourceKind: "otlp",
      observedAt: "2026-08-01T10:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.100Z",
      organizationId: "org_a",
      traceId: "trace1",
      spanId: "span1",
      name: "orphan",
      status: "unset",
      startTime: "2026-08-01T10:00:00.000Z",
      rawAvailable: false,
    };
    const parsed = telemetrySpanSchema.safeParse(span);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.parentSpanId).toBeUndefined();
  });

  it("accepts gauge, sum, and histogram metrics (T004)", () => {
    const base = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: "tmet_x",
      provider: "gemini_cli",
      sourceKind: "otlp",
      observedAt: "2026-08-01T10:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.100Z",
      organizationId: "org_a",
      name: "latency",
      rawAvailable: false,
    };
    expect(
      telemetryMetricSchema.safeParse({ ...base, metricType: "gauge", value: 1.5 }).success,
    ).toBe(true);
    expect(telemetryMetricSchema.safeParse({ ...base, metricType: "sum", value: 5 }).success).toBe(
      true,
    );
    expect(
      telemetryMetricSchema.safeParse({
        ...base,
        metricType: "histogram",
        count: 5,
        sum: 40,
        bucketCounts: [1, 2, 2],
        explicitBounds: [1, 5],
      }).success,
    ).toBe(true);
  });

  it("treats missing optional provider fields as absent, not defaults (T005)", () => {
    const parsed = telemetryLogEventSchema.safeParse(logInput());
    expect(parsed.success && parsed.data.model).toBeUndefined();
    expect(parsed.success && parsed.data.sessionId).toBeUndefined();
  });

  it("rejects oversized body (T006)", () => {
    const parsed = telemetryLogEventSchema.safeParse(logInput({ body: "x".repeat(20_000) }));
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid timestamps and status (T007)", () => {
    expect(telemetryLogEventSchema.safeParse(logInput({ observedAt: "not-a-time" })).success).toBe(
      false,
    );
    expect(telemetryLogEventSchema.safeParse(logInput({ severityNumber: -1 })).success).toBe(false);
  });

  it("rejects unknown fields (strict envelope) (T008)", () => {
    expect(telemetryLogEventSchema.safeParse(logInput({ totallyUnknown: true })).success).toBe(
      false,
    );
  });

  it("rejects unsafe query filters (T010)", () => {
    const ok = telemetryQueryFilterSchema.safeParse({
      organizationId: "org_a",
      limit: 50,
    });
    expect(ok.success).toBe(true);
    const bad = telemetryQueryFilterSchema.safeParse({
      organizationId: "org_a",
      limit: 5_000,
    });
    expect(bad.success).toBe(false);
    const badCursor = telemetryQueryFilterSchema.safeParse({
      organizationId: "org_a",
      cursor: "x".repeat(1_000),
    });
    expect(badCursor.success).toBe(false);
  });

  it("validates export manifests (T011)", () => {
    const manifest = {
      exportId: "exp_1",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      organizationId: "org_a",
      generatedAt: "2026-08-01T10:00:00.000Z",
      sources: ["otlp", "import"],
      files: [{ name: "logs.jsonl", checksumSha256: "abc" }],
      redactionApplied: true,
    };
    expect(telemetryExportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(telemetryExportManifestSchema.safeParse({ ...manifest, files: [] }).success).toBe(true);
  });

  it("validates deletion results (T012)", () => {
    const deletion = {
      organizationId: "org_a",
      scopes: ["logs", "traces"],
      logsDeleted: 5,
      spansDeleted: 0,
      metricsDeleted: 0,
      sessionsDeleted: 0,
      auditRecorded: true,
    };
    expect(telemetryDeletionResultSchema.safeParse(deletion).success).toBe(true);
    expect(telemetryDeletionResultSchema.safeParse({ ...deletion, scopes: ["nope"] }).success).toBe(
      false,
    );
  });

  it("validates dashboards (T012 dashboard contract)", () => {
    const dashboard = {
      id: "dash_1",
      organizationId: "org_a",
      name: "Observer",
      isDefault: true,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      widgets: [
        {
          id: "twid_1",
          dashboardId: "dash_1",
          widgetType: "metric_chart",
          title: "Cost",
          gridColumn: 1,
          gridRow: 1,
          createdAt: "2026-08-01T10:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    };
    const parsed = telemetryDashboardSchema.safeParse(dashboard);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.widgets).toHaveLength(1);
  });
});
