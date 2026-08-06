import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDb, type DbHandle, runMigrations } from "@aaspai/db";
import {
  type LogInsert,
  type MetricInsert,
  newEventId,
  type SpanInsert,
  TelemetryRepository,
} from "./src/index.js";

/**
 * Observer performance benchmark (plan §13).
 *
 * Repeatable corpus: 100k logs, 10k spans across 1k traces, 10k metric
 * points, 1k sessions, 10k transcript messages. Measures ingestion
 * throughput, p50/p95 ingest latency, and p50/p95 query latency for
 * logs, traces, metrics, and sessions.
 *
 * Run: yarn workspace @aaspai/telemetry run benchmark
 * Report: .aaspai/telemetry-benchmark.json
 */

const ORG = "org_bench";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function summarize(name: string, samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    count: sorted.length,
    meanMs: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3),
    p50Ms: +percentile(sorted, 50).toFixed(3),
    p95Ms: +percentile(sorted, 95).toFixed(3),
    maxMs: +percentile(sorted, 100).toFixed(3),
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aaspai-bench-"));
  const dbPath = join(dir, "bench.db");
  process.env.AASPAI_DB = `sqlite:${dbPath}`;
  const handle: DbHandle = createDb();
  runMigrations(handle);
  const repo = new TelemetryRepository(handle);
  const reports: Record<string, unknown>[] = [];

  // ---- generate corpus ----
  const logs: LogInsert[] = [];
  for (let i = 0; i < 100_000; i++) {
    const session = `sess_${i % 1_000}`;
    logs.push({
      id: newEventId("tlog"),
      organizationId: ORG,
      observedAt: new Date(1_750_000_000_000 + i * 100).toISOString(),
      receivedAt: new Date(1_750_000_000_100 + i * 100).toISOString(),
      provider: i % 3 === 0 ? "claude-code" : i % 3 === 1 ? "codex_cli_rs" : "gemini_cli",
      sourceKind: "backfill",
      serviceName: "bench",
      eventName: "transcript.message",
      body: `benchmark log line ${i} with some searchable content`,
      severityText: i % 50 === 0 ? "ERROR" : "INFO",
      severityNumber: i % 50 === 0 ? 17 : 9,
      sessionId: session,
      attributes: { "message.role": i % 2 === 0 ? "user" : "assistant", session_id: session },
      dedupKey: `bench:log:${i}`,
      rawAvailable: false,
    });
  }
  const spans: SpanInsert[] = [];
  for (let t = 0; t < 1_000; t++) {
    const trace = `trace_${t.toString(16).padStart(8, "0")}`;
    for (let s = 0; s < 10; s++) {
      spans.push({
        id: newEventId("tsp"),
        organizationId: ORG,
        observedAt: new Date(1_750_000_000_000 + t * 1000 + s * 100).toISOString(),
        receivedAt: new Date(1_750_000_000_100 + t * 1000 + s * 100).toISOString(),
        provider: "codex_cli_rs",
        sourceKind: "backfill",
        serviceName: "bench",
        traceId: trace,
        spanId: `${trace.slice(0, 8)}_${s.toString(16).padStart(4, "0")}`,
        parentSpanId:
          s === 0 ? undefined : `${trace.slice(0, 8)}_${(s - 1).toString(16).padStart(4, "0")}`,
        name: s === 0 ? "root" : `span-${s}`,
        status: "ok",
        startTime: new Date(1_750_000_000_000 + t * 1000 + s * 100).toISOString(),
        endTime: new Date(1_750_000_000_100 + t * 1000 + s * 100).toISOString(),
        durationNs: 100_000_000,
        rawAvailable: false,
      });
    }
  }
  const metrics: MetricInsert[] = [];
  for (let i = 0; i < 10_000; i++) {
    metrics.push({
      id: newEventId("tmet"),
      organizationId: ORG,
      observedAt: new Date(1_750_000_000_000 + i * 1000).toISOString(),
      receivedAt: new Date(1_750_000_000_100 + i * 1000).toISOString(),
      provider: "claude-code",
      sourceKind: "backfill",
      serviceName: "bench",
      name: i % 2 === 0 ? "claude_code.token.usage" : "claude_code.cost.usage",
      metricType: "sum",
      sessionId: `sess_${i % 1_000}`,
      model: "claude-sonnet-4-5",
      value: i % 2 === 0 ? 1000 : 0.01,
      attributes: { type: i % 4 === 0 ? "input" : "output", model: "claude-sonnet-4-5" },
      dedupKey: `bench:metric:${i}`,
      rawAvailable: false,
    });
  }

  // ---- ingest throughput ----
  const ingestStart = performance.now();
  repo.insertLogs(logs);
  const logInsertMs = performance.now() - ingestStart;
  const ingestPerLogMs = (logInsertMs / logs.length) * 1000;
  reports.push({
    ingest: {
      logs: logs.length,
      spans: spans.length,
      metrics: metrics.length,
      logInsertTotalMs: +logInsertMs.toFixed(1),
      logInsertPerLogMs: +ingestPerLogMs.toFixed(3),
      spanInsertPerSpanMs: +(measure(() => repo.insertSpans(spans)) / spans.length).toFixed(3),
      metricInsertPerMetricMs: +(
        measure(() => repo.insertMetrics(metrics)) / metrics.length
      ).toFixed(3),
    },
  });

  // ---- query latency (50 warm + 200 sampled) ----
  const logLatency: number[] = [];
  for (let i = 0; i < 250; i++) {
    const q = { organizationId: ORG, limit: 50 };
    if (i < 50) void repo.queryLogs(q);
    else {
      const ms = measure(() =>
        repo.queryLogs({
          ...q,
          search: i % 3 === 0 ? "searchable" : undefined,
          provider: i % 3 === 0 ? "claude-code" : undefined,
        }),
      );
      logLatency.push(ms);
    }
  }
  reports.push({ queryLogs: summarize("queryLogs", logLatency) });

  const traceLatency: number[] = [];
  for (let i = 0; i < 100; i++) {
    const ms = measure(() => repo.queryTraces({ organizationId: ORG, limit: 20 }));
    traceLatency.push(ms);
  }
  reports.push({ queryTraces: summarize("queryTraces", traceLatency) });

  const metricLatency: number[] = [];
  for (let i = 0; i < 100; i++) {
    const ms = measure(() =>
      repo.getMetricSeries({
        organizationId: ORG,
        name: "claude_code.token.usage",
        intervalSec: 300,
      }),
    );
    metricLatency.push(ms);
  }
  reports.push({ queryMetrics: summarize("queryMetrics", metricLatency) });

  const sessionLatency: number[] = [];
  for (let i = 0; i < 100; i++) {
    const ms = measure(() => repo.querySessions({ organizationId: ORG, limit: 50 }));
    sessionLatency.push(ms);
  }
  reports.push({ querySessions: summarize("querySessions", sessionLatency) });

  const spanLatency: number[] = [];
  for (let i = 0; i < 50; i++) {
    const ms = measure(() =>
      repo.getTraceSpans(`trace_${(i % 1000).toString(16).padStart(8, "0")}`, ORG),
    );
    spanLatency.push(ms);
  }
  reports.push({ traceDetail: summarize("traceDetail", spanLatency) });

  const exportStart = performance.now();
  const all = repo.queryAllInRange({ organizationId: ORG });
  reports.push({
    export: {
      rows: all.logs.length + all.spans.length + all.metrics.length,
      ms: +(performance.now() - exportStart).toFixed(1),
    },
  });

  await handle.close();
  rmSync(dir, { recursive: true, force: true });

  const outputDir = resolve(process.cwd(), ".aaspai");
  mkdirSync(outputDir, { recursive: true });
  const reportPath = join(outputDir, "telemetry-benchmark.json");
  const report = {
    generatedAt: new Date().toISOString(),
    org: ORG,
    corpus: { logs: 100_000, spans: 10_000, traces: 1_000, metrics: 10_000, sessions: 1_000 },
    ...reports,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
}

function measure(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
