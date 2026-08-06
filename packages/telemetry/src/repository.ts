import { randomUUID } from "node:crypto";
import type { TelemetryProvider, TelemetrySourceKind } from "@aaspai/contracts";
import type { DbHandle } from "@aaspai/db";
import { runMigrations } from "@aaspai/db";
import type Database from "better-sqlite3";
import { nowIso, toIso } from "./canonical.js";

/**
 * Telemetry storage repository.
 *
 * Storage logic adapts the AI Observer reference (flat tables with JSON
 * columns, per-span dedupe, import-state cursors) to Aaspai's SQLite
 * backend. Every query is org-scoped; the caller supplies the
 * organization id from the authenticated principal, never from the
 * client.
 *
 * The repository runs migrations once on construction (idempotent).
 */

export interface LogInsert {
  id: string;
  organizationId: string;
  observedAt: string;
  receivedAt: string;
  provider: TelemetryProvider | string;
  sourceKind: TelemetrySourceKind | string;
  serviceName?: string | null;
  eventName?: string | null;
  body?: string | null;
  severityText?: string | null;
  severityNumber?: number | null;
  sessionId?: string | null;
  executionId?: string | null;
  attemptId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  model?: string | null;
  operation?: string | null;
  toolName?: string | null;
  actorId?: string | null;
  attributes?: Record<string, unknown> | null;
  resourceAttributes?: Record<string, unknown> | null;
  scopeName?: string | null;
  scopeVersion?: string | null;
  raw?: unknown;
  rawAvailable?: boolean;
  redactionMetadata?: Record<string, unknown> | null;
  dedupKey?: string | null;
  importSource?: string | null;
  importOffset?: number | null;
  importHash?: string | null;
  parseStatus?: "ok" | "error" | "unknown";
  parseError?: string | null;
  sourcePath?: string | null;
}

export interface SpanInsert {
  id: string;
  organizationId: string;
  observedAt: string;
  receivedAt: string;
  provider: TelemetryProvider | string;
  sourceKind: TelemetrySourceKind | string;
  serviceName?: string | null;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  kind?: string | null;
  status: "ok" | "error" | "unset";
  statusMessage?: string | null;
  startTime: string;
  endTime?: string | null;
  durationNs?: number | null;
  sessionId?: string | null;
  executionId?: string | null;
  attemptId?: string | null;
  model?: string | null;
  operation?: string | null;
  actorId?: string | null;
  attributes?: Record<string, unknown> | null;
  resourceAttributes?: Record<string, unknown> | null;
  scopeName?: string | null;
  scopeVersion?: string | null;
  events?: unknown[];
  links?: unknown[];
  raw?: unknown;
  rawAvailable?: boolean;
  dedupKey?: string | null;
  importSource?: string | null;
  importOffset?: number | null;
  importHash?: string | null;
}

export interface MetricInsert {
  id: string;
  organizationId: string;
  observedAt: string;
  startTime?: string | null;
  receivedAt: string;
  provider: TelemetryProvider | string;
  sourceKind: TelemetrySourceKind | string;
  serviceName?: string | null;
  name: string;
  description?: string | null;
  unit?: string | null;
  metricType: "gauge" | "sum" | "histogram" | "exponential_histogram" | "summary";
  sessionId?: string | null;
  executionId?: string | null;
  attemptId?: string | null;
  model?: string | null;
  actorId?: string | null;
  aggregationTemporality?: number | null;
  isMonotonic?: boolean | null;
  value?: number | null;
  count?: number | null;
  sum?: number | null;
  min?: number | null;
  max?: number | null;
  bucketCounts?: number[] | null;
  explicitBounds?: number[] | null;
  scale?: number | null;
  zeroCount?: number | null;
  positiveOffset?: number | null;
  positiveBucketCounts?: number[] | null;
  negativeOffset?: number | null;
  negativeBucketCounts?: number[] | null;
  quantileValues?: number[] | null;
  quantileQuantiles?: number[] | null;
  attributes?: Record<string, unknown> | null;
  resourceAttributes?: Record<string, unknown> | null;
  scopeName?: string | null;
  scopeVersion?: string | null;
  raw?: unknown;
  rawAvailable?: boolean;
  dedupKey?: string | null;
  importSource?: string | null;
  importOffset?: number | null;
  importHash?: string | null;
}

export interface SessionSummaryUpsert {
  id: string;
  organizationId: string;
  provider: TelemetryProvider | string;
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  status?: string | null;
  model?: string | null;
  userId?: string | null;
  executionIds?: string[];
  attemptIds?: string[];
  traceIds?: string[];
  messageCount?: number;
  toolCallCount?: number;
  usage?: Record<string, unknown> | null;
  costUsd?: number | null;
  costIsEstimate?: boolean;
  warnings?: string[];
}

export interface TranscriptMessageInsert {
  id: string;
  organizationId: string;
  sessionId: string;
  seq: number;
  ts: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system" | "unknown";
  kind: string;
  text?: string | null;
  toolName?: string | null;
  toolInput?: Record<string, unknown> | null;
  toolResult?: Record<string, unknown> | null;
  attributes?: Record<string, unknown> | null;
  raw?: unknown;
}

export interface ImportStateRow {
  organizationId: string;
  source: string;
  filePath: string;
  fileHash: string;
  importedAt: string;
  recordCount: number;
  byteOffset: number;
  messageCount: number;
  parserState?: Record<string, unknown> | null;
  status: "new" | "modified" | "current" | "error" | "partial";
  lastError?: string | null;
}

export interface QueryFilter {
  organizationId: string;
  provider?: string;
  serviceName?: string;
  model?: string;
  sessionId?: string;
  executionId?: string;
  attemptId?: string;
  traceId?: string;
  severity?: string;
  status?: string;
  eventType?: string;
  search?: string;
  from?: string;
  to?: string;
  userId?: string;
  cursor?: string;
  limit?: number;
  sort?: "desc" | "asc";
}

export interface QueryResult<T> {
  rows: T[];
  nextCursor?: string;
  total?: number;
}

export interface TraceOverview {
  traceId: string;
  startTime: string;
  endTime: string;
  spanCount: number;
  rootSpan: string;
  serviceName: string;
  status: "ok" | "error" | "unset";
  durationMs: number;
}

export interface MetricSeriesPoint {
  timestamp: number;
  value: number | null;
}

export interface MetricSeries {
  name: string;
  metricType: string;
  aggregate: string;
  interval: number;
  series: Array<{ label: string; points: MetricSeriesPoint[] }>;
}

const LOG_COLUMNS = [
  "id",
  "organization_id",
  "observed_at",
  "received_at",
  "provider",
  "source_kind",
  "service_name",
  "event_name",
  "body",
  "severity_text",
  "severity_number",
  "session_id",
  "execution_id",
  "attempt_id",
  "trace_id",
  "span_id",
  "model",
  "operation",
  "tool_name",
  "actor_id",
  "attributes_json",
  "resource_attributes_json",
  "scope_name",
  "scope_version",
  "raw_json",
  "raw_available",
  "redaction_metadata_json",
  "dedup_key",
  "import_source",
  "import_offset",
  "import_hash",
  "parse_status",
  "parse_error",
  "source_path",
  "schema_version",
  "created_at",
] as const;

const SPAN_COLUMNS = [
  "id",
  "organization_id",
  "observed_at",
  "received_at",
  "provider",
  "source_kind",
  "service_name",
  "trace_id",
  "span_id",
  "parent_span_id",
  "name",
  "kind",
  "status",
  "status_message",
  "start_time",
  "end_time",
  "duration_ns",
  "session_id",
  "execution_id",
  "attempt_id",
  "model",
  "operation",
  "actor_id",
  "attributes_json",
  "resource_attributes_json",
  "scope_name",
  "scope_version",
  "events_json",
  "links_json",
  "raw_json",
  "raw_available",
  "dedup_key",
  "import_source",
  "import_offset",
  "import_hash",
  "schema_version",
  "created_at",
] as const;

const METRIC_COLUMNS = [
  "id",
  "organization_id",
  "observed_at",
  "start_time",
  "received_at",
  "provider",
  "source_kind",
  "service_name",
  "name",
  "description",
  "unit",
  "metric_type",
  "session_id",
  "execution_id",
  "attempt_id",
  "model",
  "actor_id",
  "aggregation_temporality",
  "is_monotonic",
  "value",
  "count",
  "sum",
  "min",
  "max",
  "bucket_counts_json",
  "explicit_bounds_json",
  "scale",
  "zero_count",
  "positive_offset",
  "positive_bucket_counts_json",
  "negative_offset",
  "negative_bucket_counts_json",
  "quantile_values_json",
  "quantile_quantiles_json",
  "attributes_json",
  "resource_attributes_json",
  "scope_name",
  "scope_version",
  "raw_json",
  "raw_available",
  "dedup_key",
  "import_source",
  "import_offset",
  "import_hash",
  "schema_version",
  "created_at",
] as const;

function jsonString(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function num(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

function int(value: boolean | number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

export class TelemetryRepository {
  private readonly sql: Database.Database;
  private migrated = false;

  constructor(private readonly handle: DbHandle) {
    if (handle.backend !== "sqlite") {
      throw new Error("TelemetryRepository currently requires the SQLite backend");
    }
    this.sql = handle.raw as unknown as Database.Database;
  }

  private ensure(): void {
    if (this.migrated) return;
    runMigrations(this.handle);
    this.migrated = true;
  }

  /* ------------------------------------------------------------------ */
  /* Inserts                                                             */
  /* ------------------------------------------------------------------ */

  insertLogs(rows: LogInsert[]): { inserted: number } {
    if (rows.length === 0) return { inserted: 0 };
    this.ensure();
    const stmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_logs (${LOG_COLUMNS.join(", ")})
       VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`,
    );
    const tx = this.sql.transaction((all: LogInsert[]) => {
      let inserted = 0;
      for (const r of all) {
        const info = stmt.run(...this.logRow(r));
        inserted += info.changes;
      }
      return inserted;
    });
    return { inserted: tx(rows) };
  }

  insertSpans(rows: SpanInsert[]): { inserted: number; skipped: number } {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    this.ensure();
    const stmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_spans (${SPAN_COLUMNS.join(", ")})
       VALUES (${SPAN_COLUMNS.map(() => "?").join(", ")})`,
    );
    const tx = this.sql.transaction((all: SpanInsert[]) => {
      let inserted = 0;
      for (const r of all) {
        const info = stmt.run(...this.spanRow(r));
        inserted += info.changes;
      }
      return inserted;
    });
    const inserted = tx(rows);
    return { inserted, skipped: rows.length - inserted };
  }

  insertMetrics(rows: MetricInsert[]): { inserted: number } {
    if (rows.length === 0) return { inserted: 0 };
    this.ensure();
    const stmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_metrics (${METRIC_COLUMNS.join(", ")})
       VALUES (${METRIC_COLUMNS.map(() => "?").join(", ")})`,
    );
    const tx = this.sql.transaction((all: MetricInsert[]) => {
      let inserted = 0;
      for (const r of all) {
        const info = stmt.run(...this.metricRow(r));
        inserted += info.changes;
      }
      return inserted;
    });
    return { inserted: tx(rows) };
  }

  /** Atomic batch insert (reference watcher/OTLP behavior). */
  insertBatch(input: { logs?: LogInsert[]; spans?: SpanInsert[]; metrics?: MetricInsert[] }): {
    logs: number;
    spans: number;
    spansSkipped: number;
    metrics: number;
  } {
    const logs = input.logs ?? [];
    const spans = input.spans ?? [];
    const metrics = input.metrics ?? [];
    this.ensure();
    const logStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_logs (${LOG_COLUMNS.join(", ")})
       VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`,
    );
    const spanStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_spans (${SPAN_COLUMNS.join(", ")})
       VALUES (${SPAN_COLUMNS.map(() => "?").join(", ")})`,
    );
    const metricStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_metrics (${METRIC_COLUMNS.join(", ")})
       VALUES (${METRIC_COLUMNS.map(() => "?").join(", ")})`,
    );
    const tx = this.sql.transaction(() => {
      let logsInserted = 0;
      for (const r of logs) logsInserted += logStmt.run(...this.logRow(r)).changes;
      let spansInserted = 0;
      for (const r of spans) spansInserted += spanStmt.run(...this.spanRow(r)).changes;
      let metricsInserted = 0;
      for (const r of metrics) metricsInserted += metricStmt.run(...this.metricRow(r)).changes;
      return { logsInserted, spansInserted, metricsInserted };
    });
    const result = tx();
    return {
      logs: result.logsInserted,
      spans: result.spansInserted,
      spansSkipped: spans.length - result.spansInserted,
      metrics: result.metricsInserted,
    };
  }

  /**
   * Atomic watcher/import commit: inserts the batch and advances the
   * import cursor in one transaction. On failure the cursor is not
   * advanced (retry-safe), matching the reference `InsertWatcherBatch`.
   */
  commitWatchBatch(input: {
    logs?: LogInsert[];
    spans?: SpanInsert[];
    metrics?: MetricInsert[];
    state: ImportStateRow;
  }): { logs: number; spans: number; spansSkipped: number; metrics: number } {
    const logs = input.logs ?? [];
    const spans = input.spans ?? [];
    const metrics = input.metrics ?? [];
    this.ensure();
    const logStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_logs (${LOG_COLUMNS.join(", ")})
       VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})`,
    );
    const spanStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_spans (${SPAN_COLUMNS.join(", ")})
       VALUES (${SPAN_COLUMNS.map(() => "?").join(", ")})`,
    );
    const metricStmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_metrics (${METRIC_COLUMNS.join(", ")})
       VALUES (${METRIC_COLUMNS.map(() => "?").join(", ")})`,
    );
    const stateStmt = this.sql.prepare(
      `INSERT INTO telemetry_import_state (
         organization_id, source, file_path, file_hash, imported_at, record_count, byte_offset,
         message_count, parser_state_json, status, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, source, file_path) DO UPDATE SET
         file_hash = excluded.file_hash,
         imported_at = excluded.imported_at,
         record_count = excluded.record_count,
         byte_offset = excluded.byte_offset,
         message_count = excluded.message_count,
         parser_state_json = excluded.parser_state_json,
         status = excluded.status,
         last_error = excluded.last_error`,
    );
    const tx = this.sql.transaction(() => {
      let logsInserted = 0;
      for (const r of logs) logsInserted += logStmt.run(...this.logRow(r)).changes;
      let spansInserted = 0;
      for (const r of spans) spansInserted += spanStmt.run(...this.spanRow(r)).changes;
      let metricsInserted = 0;
      for (const r of metrics) metricsInserted += metricStmt.run(...this.metricRow(r)).changes;
      stateStmt.run(
        input.state.organizationId,
        input.state.source,
        input.state.filePath,
        input.state.fileHash,
        input.state.importedAt,
        input.state.recordCount,
        input.state.byteOffset,
        input.state.messageCount,
        jsonString(input.state.parserState),
        input.state.status,
        input.state.lastError ?? null,
      );
      return { logsInserted, spansInserted, metricsInserted };
    });
    const result = tx();
    return {
      logs: result.logsInserted,
      spans: result.spansInserted,
      spansSkipped: spans.length - result.spansInserted,
      metrics: result.metricsInserted,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Log queries                                                         */
  /* ------------------------------------------------------------------ */

  queryLogs(filter: QueryFilter): QueryResult<Record<string, unknown>> {
    this.ensure();
    const { where, params } = this.buildWhere(filter, "telemetry_logs", "observed_at");
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const sortDir = filter.sort === "asc" ? "ASC" : "DESC";
    const cursorClause = this.cursorClause(filter.cursor, sortDir);
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_logs
         ${where} ${cursorClause}
         ORDER BY observed_at ${sortDir}, id ${sortDir}
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    const total = filter.cursor
      ? undefined
      : (
          this.sql.prepare(`SELECT COUNT(*) AS c FROM telemetry_logs ${where}`).get(...params) as {
            c: number;
          }
        ).c;
    const parsed = rows.map((r) => this.parseRow(r));
    return { rows: parsed, total, nextCursor: this.nextCursor(parsed, limit, sortDir) };
  }

  getLog(id: string, organizationId: string): Record<string, unknown> | null {
    this.ensure();
    const row = this.sql
      .prepare("SELECT * FROM telemetry_logs WHERE id = ? AND organization_id = ? LIMIT 1")
      .get(id, organizationId) as Record<string, unknown> | undefined;
    return row ? this.parseRow(row) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Span / trace queries                                                */
  /* ------------------------------------------------------------------ */

  querySpans(filter: QueryFilter): QueryResult<Record<string, unknown>> {
    this.ensure();
    const { where, params } = this.buildWhere(filter, "telemetry_spans", "observed_at");
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const sortDir = filter.sort === "asc" ? "ASC" : "DESC";
    const cursorClause = this.cursorClause(filter.cursor, sortDir);
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_spans
         ${where} ${cursorClause}
         ORDER BY observed_at ${sortDir}, id ${sortDir}
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    const parsed = rows.map((r) => this.parseRow(r));
    return { rows: parsed, nextCursor: this.nextCursor(parsed, limit, sortDir) };
  }

  getTraceSpans(traceId: string, organizationId: string): Array<Record<string, unknown>> {
    this.ensure();
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_spans
         WHERE organization_id = ? AND trace_id = ?
         ORDER BY observed_at ASC, id ASC`,
      )
      .all(organizationId, traceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.parseRow(r));
  }

  queryTraces(filter: QueryFilter): QueryResult<TraceOverview> {
    this.ensure();
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [filter.organizationId];
    if (filter.traceId) {
      conditions.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.provider) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.serviceName) {
      conditions.push("service_name = ?");
      params.push(filter.serviceName);
    }
    if (filter.from) {
      conditions.push("observed_at >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("observed_at <= ?");
      params.push(filter.to);
    }
    if (filter.search) {
      conditions.push("(name LIKE ? OR attributes_json LIKE ? OR status LIKE ?)");
      const term = `%${filter.search}%`;
      params.push(term, term, term);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = this.offsetFromCursor(filter.cursor);
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 500);
    const rows = this.sql
      .prepare(
        `SELECT trace_id,
                MIN(observed_at) AS start_time,
                MAX(observed_at) AS end_time,
                COUNT(*) AS span_count,
                MIN(name) AS root_span,
                MIN(service_name) AS service_name,
                CASE WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
                     WHEN SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) > 0 THEN 'ok'
                     ELSE 'unset' END AS status
         FROM telemetry_spans
         ${where}
         GROUP BY trace_id
         ORDER BY start_time DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    const total = (
      this.sql
        .prepare(`SELECT COUNT(DISTINCT trace_id) AS c FROM telemetry_spans ${where}`)
        .get(...params) as { c: number }
    ).c;
    const overviews: TraceOverview[] = rows.map((r) => ({
      traceId: String(r.trace_id),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
      spanCount: Number(r.span_count),
      rootSpan: r.root_span ? String(r.root_span) : "",
      serviceName: r.service_name ? String(r.service_name) : "",
      status: String(r.status) as "ok" | "error" | "unset",
      durationMs: Math.max(0, Date.parse(String(r.end_time)) - Date.parse(String(r.start_time))),
    }));
    const nextOffset = offset + limit;
    return {
      rows: overviews,
      total,
      nextCursor: nextOffset < total ? encodeCursor(String(nextOffset)) : undefined,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Metric queries                                                      */
  /* ------------------------------------------------------------------ */

  queryMetrics(filter: QueryFilter): QueryResult<Record<string, unknown>> {
    this.ensure();
    const { where, params } = this.buildWhere(filter, "telemetry_metrics", "observed_at");
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const sortDir = filter.sort === "asc" ? "ASC" : "DESC";
    const cursorClause = this.cursorClause(filter.cursor, sortDir);
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_metrics
         ${where} ${cursorClause}
         ORDER BY observed_at ${sortDir}, id ${sortDir}
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    const parsed = rows.map((r) => this.parseRow(r));
    return { rows: parsed, nextCursor: this.nextCursor(parsed, limit, sortDir) };
  }

  getMetricNames(organizationId: string, serviceName?: string): string[] {
    this.ensure();
    const params: unknown[] = [organizationId];
    let serviceClause = "";
    if (serviceName) {
      serviceClause = " AND service_name = ?";
      params.push(serviceName);
    }
    const rows = this.sql
      .prepare(
        `SELECT DISTINCT name FROM telemetry_metrics WHERE organization_id = ? ${serviceClause} ORDER BY name`,
      )
      .all(...params) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  getBreakdownValues(
    organizationId: string,
    name: string,
    attribute: string,
    serviceName?: string,
  ): string[] {
    this.ensure();
    if (!/^[A-Za-z0-9_.-]+$/.test(attribute)) return [];
    const path = attribute.includes(".") ? `'$."${attribute}"'` : `'$."${attribute}"'`;
    const params: unknown[] = [organizationId, name];
    let serviceClause = "";
    if (serviceName) {
      serviceClause = " AND service_name = ?";
      params.push(serviceName);
    }
    const rows = this.sql
      .prepare(
        `SELECT DISTINCT json_extract(attributes_json, ${path}) AS v
         FROM telemetry_metrics
         WHERE organization_id = ? AND name = ? ${serviceClause}
           AND json_extract(attributes_json, ${path}) IS NOT NULL
         ORDER BY v`,
      )
      .all(...params) as Array<{ v: unknown }>;
    return rows.map((r) => String(r.v));
  }

  getMetricSeries(input: {
    organizationId: string;
    name: string;
    serviceName?: string;
    from?: string;
    to?: string;
    intervalSec?: number;
    aggregate?: "sum" | "avg" | "max" | "min" | "count";
  }): MetricSeries {
    this.ensure();
    const interval = Math.max(1, input.intervalSec ?? 60);
    const aggregate = input.aggregate ?? "sum";
    const from = input.from ?? toIso(new Date(Date.now() - 24 * 60 * 60 * 1000)) ?? nowIso();
    const to = input.to ?? nowIso();
    const conditions = ["organization_id = ?", "name = ?", "observed_at >= ?", "observed_at <= ?"];
    const params: unknown[] = [input.organizationId, input.name, from, to];
    if (input.serviceName) {
      conditions.push("service_name = ?");
      params.push(input.serviceName);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const aggExpr =
      aggregate === "avg"
        ? "AVG(COALESCE(value, sum))"
        : aggregate === "max"
          ? "MAX(COALESCE(value, sum))"
          : aggregate === "min"
            ? "MIN(COALESCE(value, sum))"
            : aggregate === "count"
              ? "COUNT(*)"
              : "SUM(COALESCE(value, sum))";

    const typeRow = this.sql
      .prepare(
        `SELECT metric_type, aggregation_temporality, is_monotonic
         FROM telemetry_metrics ${where}
         ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(...params) as
      | { metric_type: string; aggregation_temporality: number | null; is_monotonic: number | null }
      | undefined;
    const metricType = typeRow?.metric_type ?? "sum";

    const bucketExpr = `(CAST(strftime('%s', observed_at) AS INTEGER) / ${interval}) * ${interval}`;
    const rows = this.sql
      .prepare(
        `SELECT ${bucketExpr} AS bucket,
                COALESCE(NULLIF(json_extract(attributes_json, '$."type"'), ''), NULLIF(json_extract(attributes_json, '$."gen_ai.token.type"'), ''), 'default') AS label,
                ${aggExpr} AS value
         FROM telemetry_metrics
         ${where}
         GROUP BY bucket, label
         ORDER BY bucket ASC`,
      )
      .all(...params) as Array<{ bucket: number; label: string; value: number }>;

    const seriesMap = new Map<string, Map<number, number>>();
    for (const r of rows) {
      let pointMap = seriesMap.get(r.label);
      if (!pointMap) {
        pointMap = new Map();
        seriesMap.set(r.label, pointMap);
      }
      pointMap.set(r.bucket, Number(r.value));
    }

    const startBucket = Math.floor(Date.parse(from) / 1000 / interval) * interval;
    const endBucket = Math.floor(Date.parse(to) / 1000 / interval) * interval;

    const series: MetricSeries["series"] = [];
    for (const [label, pointMap] of seriesMap.entries()) {
      const points: MetricSeriesPoint[] = [];
      for (let b = startBucket; b <= endBucket; b += interval) {
        points.push({ timestamp: b * 1000, value: pointMap.get(b) ?? null });
      }
      series.push({ label, points });
    }

    return { name: input.name, metricType, aggregate, interval, series };
  }

  /* ------------------------------------------------------------------ */
  /* Services / stats / activity                                         */
  /* ------------------------------------------------------------------ */

  getServices(organizationId: string): string[] {
    this.ensure();
    const rows = this.sql
      .prepare(
        `SELECT provider FROM (
           SELECT provider FROM telemetry_logs WHERE organization_id = ?
           UNION
           SELECT provider FROM telemetry_spans WHERE organization_id = ?
           UNION
           SELECT provider FROM telemetry_metrics WHERE organization_id = ?
         ) ORDER BY provider`,
      )
      .all(organizationId, organizationId, organizationId) as Array<{ provider: string }>;
    return rows.map((r) => r.provider);
  }

  getStats(organizationId: string, from?: string, to?: string): Record<string, unknown> {
    this.ensure();
    const count = (table: string, extraClause = ""): number => {
      const parts = ["organization_id = ?"];
      const params: unknown[] = [organizationId];
      if (from) {
        parts.push("observed_at >= ?");
        params.push(from);
      }
      if (to) {
        parts.push("observed_at <= ?");
        params.push(to);
      }
      if (extraClause) parts.push(extraClause);
      const row = this.sql
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${parts.join(" AND ")}`)
        .get(...params) as { c: number };
      return row.c;
    };
    const logs = count("telemetry_logs");
    const spans = count("telemetry_spans");
    const metrics = count("telemetry_metrics");
    const errorSpans = count("telemetry_spans", "status = 'error'");
    const errorLogs = count("telemetry_logs", "severity_number >= 17");
    const traces = this.sql
      .prepare(
        `SELECT COUNT(DISTINCT trace_id) AS c FROM telemetry_spans
         WHERE organization_id = ? ${from ? "AND observed_at >= ?" : ""} ${to ? "AND observed_at <= ?" : ""}`,
      )
      .get(organizationId, ...(from ? [from] : []), ...(to ? [to] : [])) as { c: number };
    const sessions = this.sql
      .prepare(
        `SELECT COUNT(*) AS c FROM telemetry_sessions
         WHERE organization_id = ? ${from ? "AND last_seen_at >= ?" : ""} ${to ? "AND last_seen_at <= ?" : ""}`,
      )
      .get(organizationId, ...(from ? [from] : []), ...(to ? [to] : [])) as { c: number };
    return {
      logs,
      spans,
      metrics,
      traces: traces.c,
      sessions: sessions.c,
      errorSpans,
      errorLogs,
      errorRate: spans > 0 ? Math.round((errorSpans / spans) * 10_000) / 100 : 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Sessions + transcript                                               */
  /* ------------------------------------------------------------------ */

  upsertSessionSummary(row: SessionSummaryUpsert): void {
    this.ensure();
    this.sql
      .prepare(
        `INSERT INTO telemetry_sessions (
           id, organization_id, provider, session_id, first_seen_at, last_seen_at,
           status, model, user_id, execution_ids_json, attempt_ids_json, trace_ids_json,
           message_count, tool_call_count, usage_json, cost_usd, cost_is_estimate,
           warnings_json, schema_version, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, session_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           status = COALESCE(excluded.status, telemetry_sessions.status),
           model = COALESCE(excluded.model, telemetry_sessions.model),
           user_id = COALESCE(excluded.user_id, telemetry_sessions.user_id),
           message_count = excluded.message_count,
           tool_call_count = excluded.tool_call_count,
           usage_json = COALESCE(excluded.usage_json, telemetry_sessions.usage_json),
           cost_usd = COALESCE(excluded.cost_usd, telemetry_sessions.cost_usd),
           cost_is_estimate = excluded.cost_is_estimate,
           warnings_json = excluded.warnings_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.organizationId,
        row.provider,
        row.sessionId,
        row.firstSeenAt,
        row.lastSeenAt,
        row.status ?? null,
        row.model ?? null,
        row.userId ?? null,
        JSON.stringify(row.executionIds ?? []),
        JSON.stringify(row.attemptIds ?? []),
        JSON.stringify(row.traceIds ?? []),
        row.messageCount ?? 0,
        row.toolCallCount ?? 0,
        jsonString(row.usage),
        row.costUsd ?? null,
        int(row.costIsEstimate) ?? 0,
        JSON.stringify(row.warnings ?? []),
        1,
        row.lastSeenAt,
      );
  }

  insertTranscriptMessages(rows: TranscriptMessageInsert[]): { inserted: number } {
    if (rows.length === 0) return { inserted: 0 };
    this.ensure();
    const stmt = this.sql.prepare(
      `INSERT OR IGNORE INTO telemetry_session_messages (
         id, organization_id, session_id, seq, ts, role, kind, text, tool_name,
         tool_input_json, tool_result_json, attributes_json, raw_json, schema_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.sql.transaction((all: TranscriptMessageInsert[]) => {
      let inserted = 0;
      for (const r of all) {
        const info = stmt.run(
          r.id,
          r.organizationId,
          r.sessionId,
          r.seq,
          r.ts,
          r.role,
          r.kind,
          r.text ?? null,
          r.toolName ?? null,
          jsonString(r.toolInput),
          jsonString(r.toolResult),
          JSON.stringify(r.attributes ?? {}),
          jsonString(r.raw),
          1,
          r.ts,
        );
        inserted += info.changes;
      }
      return inserted;
    });
    return { inserted: tx(rows) };
  }

  querySessions(filter: QueryFilter): QueryResult<Record<string, unknown>> {
    this.ensure();
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [filter.organizationId];
    if (filter.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.provider) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.model) {
      conditions.push("model = ?");
      params.push(filter.model);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.from) {
      conditions.push("last_seen_at >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("last_seen_at <= ?");
      params.push(filter.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const offset = this.offsetFromCursor(filter.cursor);
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_sessions ${where} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    const total = (
      this.sql.prepare(`SELECT COUNT(*) AS c FROM telemetry_sessions ${where}`).get(...params) as {
        c: number;
      }
    ).c;
    const parsed = rows.map((r) => this.parseRow(r));
    const nextOffset = offset + limit;
    return {
      rows: parsed,
      total,
      nextCursor: nextOffset < total ? encodeCursor(String(nextOffset)) : undefined,
    };
  }

  getSessionDetail(sessionId: string, organizationId: string): Record<string, unknown> | null {
    this.ensure();
    const summary = this.sql
      .prepare(
        "SELECT * FROM telemetry_sessions WHERE organization_id = ? AND session_id = ? LIMIT 1",
      )
      .get(organizationId, sessionId) as Record<string, unknown> | undefined;
    if (!summary) return null;
    const messages = (
      this.sql
        .prepare(
          "SELECT * FROM telemetry_session_messages WHERE organization_id = ? AND session_id = ? ORDER BY seq ASC",
        )
        .all(organizationId, sessionId) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const logs = (
      this.sql
        .prepare(
          "SELECT * FROM telemetry_logs WHERE organization_id = ? AND session_id = ? ORDER BY observed_at ASC LIMIT 500",
        )
        .all(organizationId, sessionId) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const spans = (
      this.sql
        .prepare(
          "SELECT * FROM telemetry_spans WHERE organization_id = ? AND session_id = ? ORDER BY observed_at ASC LIMIT 500",
        )
        .all(organizationId, sessionId) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    return {
      summary: this.parseRow(summary),
      messages,
      logs,
      spans,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Live events (SSE replay)                                            */
  /* ------------------------------------------------------------------ */

  /** Persist a live event; returns its monotonic id. */
  appendLiveEvent(organizationId: string, type: string, payload: Record<string, unknown>): number {
    this.ensure();
    const info = this.sql
      .prepare(
        `INSERT INTO telemetry_live_events (organization_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(organizationId, type, JSON.stringify(payload), nowIso());
    return Number(info.lastInsertRowid);
  }

  /** Replay persisted live events after the given id (org-scoped). */
  queryLiveEvents(
    organizationId: string,
    afterId: number,
    limit = 1_000,
  ): Array<{ id: number; type: string; payload: Record<string, unknown>; createdAt: string }> {
    this.ensure();
    const rows = this.sql
      .prepare(
        `SELECT * FROM telemetry_live_events
         WHERE organization_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(organizationId, afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      payload: (parseJson(String(r.payload_json)) ?? {}) as Record<string, unknown>,
      createdAt: String(r.created_at),
    }));
  }

  /** Latest live event id for an org (used as a replay baseline). */
  lastLiveEventId(organizationId: string): number {
    this.ensure();
    const row = this.sql
      .prepare(
        "SELECT id FROM telemetry_live_events WHERE organization_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(organizationId) as { id: number } | undefined;
    return row ? Number(row.id) : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Import state                                                        */
  /* ------------------------------------------------------------------ */

  getImportState(organizationId: string, source: string, filePath: string): ImportStateRow | null {
    this.ensure();
    const row = this.sql
      .prepare(
        "SELECT * FROM telemetry_import_state WHERE organization_id = ? AND source = ? AND file_path = ? LIMIT 1",
      )
      .get(organizationId, source, filePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      organizationId: String(row.organization_id),
      source: String(row.source),
      filePath: String(row.file_path),
      fileHash: String(row.file_hash),
      importedAt: String(row.imported_at),
      recordCount: Number(row.record_count ?? 0),
      byteOffset: Number(row.byte_offset ?? 0),
      messageCount: Number(row.message_count ?? 0),
      parserState: row.parser_state_json
        ? (parseJson(String(row.parser_state_json)) as Record<string, unknown>)
        : null,
      status: String(row.status) as ImportStateRow["status"],
      lastError: row.last_error ? String(row.last_error) : null,
    };
  }

  setImportState(row: ImportStateRow): void {
    this.ensure();
    this.sql
      .prepare(
        `INSERT INTO telemetry_import_state (
           organization_id, source, file_path, file_hash, imported_at, record_count, byte_offset,
           message_count, parser_state_json, status, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, source, file_path) DO UPDATE SET
           file_hash = excluded.file_hash,
           imported_at = excluded.imported_at,
           record_count = excluded.record_count,
           byte_offset = excluded.byte_offset,
           message_count = excluded.message_count,
           parser_state_json = excluded.parser_state_json,
           status = excluded.status,
           last_error = excluded.last_error`,
      )
      .run(
        row.organizationId,
        row.source,
        row.filePath,
        row.fileHash,
        row.importedAt,
        row.recordCount,
        row.byteOffset,
        row.messageCount,
        jsonString(row.parserState),
        row.status,
        row.lastError ?? null,
      );
  }

  /** Watcher position update; inserts a zero-hash row when missing. */
  setWatchFields(
    organizationId: string,
    source: string,
    filePath: string,
    byteOffset: number,
    messageCount: number,
    fileHash?: string,
    status?: ImportStateRow["status"],
  ): void {
    this.ensure();
    const now = nowIso();
    const existing = this.getImportState(organizationId, source, filePath);
    const info = this.sql
      .prepare(
        `UPDATE telemetry_import_state
         SET byte_offset = ?, message_count = ?, imported_at = ?,
             file_hash = CASE WHEN ? = '' THEN file_hash ELSE ? END,
             status = ?, last_error = NULL
         WHERE organization_id = ? AND source = ? AND file_path = ?`,
      )
      .run(
        byteOffset,
        messageCount,
        now,
        fileHash ?? "",
        fileHash ?? "",
        status ?? "current",
        organizationId,
        source,
        filePath,
      );
    if (info.changes === 0) {
      this.setImportState({
        organizationId,
        source,
        filePath,
        fileHash: fileHash ?? "",
        importedAt: now,
        recordCount: existing?.recordCount ?? 0,
        byteOffset,
        messageCount,
        status: status ?? "current",
      });
    }
  }

  listImportState(organizationId: string, source?: string): ImportStateRow[] {
    this.ensure();
    const rows = source
      ? (this.sql
          .prepare(
            "SELECT * FROM telemetry_import_state WHERE organization_id = ? AND source = ? ORDER BY imported_at DESC",
          )
          .all(organizationId, source) as Array<Record<string, unknown>>)
      : (this.sql
          .prepare(
            "SELECT * FROM telemetry_import_state WHERE organization_id = ? ORDER BY imported_at DESC",
          )
          .all(organizationId) as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      organizationId: String(row.organization_id),
      source: String(row.source),
      filePath: String(row.file_path),
      fileHash: String(row.file_hash),
      importedAt: String(row.imported_at),
      recordCount: Number(row.record_count ?? 0),
      byteOffset: Number(row.byte_offset ?? 0),
      messageCount: Number(row.message_count ?? 0),
      parserState: row.parser_state_json
        ? (parseJson(String(row.parser_state_json)) as Record<string, unknown>)
        : null,
      status: String(row.status) as ImportStateRow["status"],
      lastError: row.last_error ? String(row.last_error) : null,
    }));
  }

  clearImportState(organizationId: string, source?: string): number {
    this.ensure();
    if (source) {
      const info = this.sql
        .prepare("DELETE FROM telemetry_import_state WHERE organization_id = ? AND source = ?")
        .run(organizationId, source);
      return info.changes;
    }
    const info = this.sql
      .prepare("DELETE FROM telemetry_import_state WHERE organization_id = ?")
      .run(organizationId);
    return info.changes;
  }

  /* ------------------------------------------------------------------ */
  /* Ingestion errors                                                    */
  /* ------------------------------------------------------------------ */

  insertIngestError(input: {
    organizationId: string;
    sourceKind: string;
    kind: string;
    message: string;
    raw?: unknown;
    recordCount?: number;
    ts?: string;
  }): string {
    this.ensure();
    const id = `terr_${randomUUID()}`;
    const ts = input.ts ?? nowIso();
    this.sql
      .prepare(
        `INSERT INTO telemetry_ingest_errors (
           id, organization_id, ts, source_kind, kind, message, raw_json,
           record_count, schema_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.organizationId,
        ts,
        input.sourceKind,
        input.kind,
        input.message,
        jsonString(input.raw),
        input.recordCount ?? 0,
        1,
        ts,
      );
    return id;
  }

  queryIngestErrors(filter: QueryFilter): QueryResult<Record<string, unknown>> {
    this.ensure();
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [filter.organizationId];
    if (filter.from) {
      conditions.push("ts >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("ts <= ?");
      params.push(filter.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const rows = this.sql
      .prepare(`SELECT * FROM telemetry_ingest_errors ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return { rows: rows.map((r) => this.parseRow(r)) };
  }

  /* ------------------------------------------------------------------ */
  /* Dashboards                                                          */
  /* ------------------------------------------------------------------ */

  listDashboards(organizationId: string): Array<Record<string, unknown>> {
    this.ensure();
    return (
      this.sql
        .prepare(
          "SELECT * FROM telemetry_dashboards WHERE organization_id = ? ORDER BY created_at ASC",
        )
        .all(organizationId) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
  }

  getDashboard(organizationId: string, id: string): Record<string, unknown> | null {
    this.ensure();
    const dash = this.sql
      .prepare("SELECT * FROM telemetry_dashboards WHERE organization_id = ? AND id = ? LIMIT 1")
      .get(organizationId, id) as Record<string, unknown> | undefined;
    if (!dash) return null;
    return this.withWidgets(dash);
  }

  getDefaultDashboard(organizationId: string): Record<string, unknown> | null {
    this.ensure();
    const dash = this.sql
      .prepare(
        "SELECT * FROM telemetry_dashboards WHERE organization_id = ? AND is_default = 1 LIMIT 1",
      )
      .get(organizationId) as Record<string, unknown> | undefined;
    if (!dash) return null;
    return this.withWidgets(dash);
  }

  private withWidgets(dash: Record<string, unknown>): Record<string, unknown> {
    const widgets = (
      this.sql
        .prepare(
          "SELECT * FROM telemetry_dashboard_widgets WHERE dashboard_id = ? ORDER BY grid_row ASC, grid_column ASC",
        )
        .all(String(dash.id)) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    return { ...this.parseRow(dash), widgets };
  }

  createDashboard(input: {
    organizationId: string;
    name: string;
    description?: string;
    isDefault?: boolean;
  }): Record<string, unknown> {
    this.ensure();
    const id = `dash_${randomUUID()}`;
    const now = nowIso();
    if (input.isDefault) {
      this.sql
        .prepare("UPDATE telemetry_dashboards SET is_default = 0 WHERE organization_id = ?")
        .run(input.organizationId);
    }
    this.sql
      .prepare(
        `INSERT INTO telemetry_dashboards (
           id, organization_id, name, description, is_default, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.organizationId,
        input.name,
        input.description ?? null,
        input.isDefault ? 1 : 0,
        now,
        now,
      );
    return this.getDashboard(input.organizationId, id) as Record<string, unknown>;
  }

  updateDashboard(
    organizationId: string,
    id: string,
    patch: { name?: string; description?: string | null; isDefault?: boolean },
  ): Record<string, unknown> | null {
    this.ensure();
    const now = nowIso();
    if (patch.isDefault) {
      this.sql
        .prepare("UPDATE telemetry_dashboards SET is_default = 0 WHERE organization_id = ?")
        .run(organizationId);
    }
    const info = this.sql
      .prepare(
        `UPDATE telemetry_dashboards SET
           name = COALESCE(?, name),
           description = ?,
           is_default = COALESCE(?, is_default),
           updated_at = ?
         WHERE organization_id = ? AND id = ?`,
      )
      .run(
        patch.name ?? null,
        patch.description === undefined ? undefined : patch.description,
        patch.isDefault === undefined ? null : patch.isDefault ? 1 : 0,
        now,
        organizationId,
        id,
      );
    if (info.changes === 0) return null;
    return this.getDashboard(organizationId, id);
  }

  deleteDashboard(organizationId: string, id: string): boolean {
    this.ensure();
    const info = this.sql
      .prepare("DELETE FROM telemetry_dashboards WHERE organization_id = ? AND id = ?")
      .run(organizationId, id);
    return info.changes > 0;
  }

  addWidget(input: {
    organizationId: string;
    dashboardId: string;
    widgetType: string;
    title: string;
    gridColumn: number;
    gridRow: number;
    colSpan?: number;
    rowSpan?: number;
    config?: Record<string, unknown>;
  }): Record<string, unknown> | null {
    this.ensure();
    const dash = this.sql
      .prepare("SELECT id FROM telemetry_dashboards WHERE organization_id = ? AND id = ?")
      .get(input.organizationId, input.dashboardId) as { id: string } | undefined;
    if (!dash) return null;
    const id = `twid_${randomUUID()}`;
    const now = nowIso();
    this.sql
      .prepare(
        `INSERT INTO telemetry_dashboard_widgets (
           id, dashboard_id, widget_type, title, grid_column, grid_row, col_span, row_span,
           config_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.dashboardId,
        input.widgetType,
        input.title,
        input.gridColumn,
        input.gridRow,
        input.colSpan ?? 1,
        input.rowSpan ?? 1,
        JSON.stringify(input.config ?? {}),
        now,
        now,
      );
    const row = this.sql
      .prepare("SELECT * FROM telemetry_dashboard_widgets WHERE id = ?")
      .get(id) as Record<string, unknown>;
    return this.parseRow(row);
  }

  updateWidget(
    organizationId: string,
    dashboardId: string,
    widgetId: string,
    patch: {
      title?: string;
      config?: Record<string, unknown>;
      colSpan?: number;
      rowSpan?: number;
    },
  ): boolean {
    this.ensure();
    // Ownership guard: only the org that owns the dashboard may update its widgets.
    const dash = this.sql
      .prepare("SELECT id FROM telemetry_dashboards WHERE organization_id = ? AND id = ?")
      .get(organizationId, dashboardId) as { id: string } | undefined;
    if (!dash) return false;
    const info = this.sql
      .prepare(
        `UPDATE telemetry_dashboard_widgets SET
           title = COALESCE(?, title),
           config_json = COALESCE(?, config_json),
           col_span = COALESCE(?, col_span),
           row_span = COALESCE(?, row_span),
           updated_at = ?
         WHERE dashboard_id = ? AND id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.config === undefined ? null : JSON.stringify(patch.config),
        patch.colSpan ?? null,
        patch.rowSpan ?? null,
        nowIso(),
        dashboardId,
        widgetId,
      );
    return info.changes > 0;
  }

  updateWidgetPositions(
    organizationId: string,
    dashboardId: string,
    positions: Array<{
      id: string;
      gridColumn: number;
      gridRow: number;
      colSpan?: number;
      rowSpan?: number;
    }>,
  ): number {
    this.ensure();
    const dash = this.sql
      .prepare("SELECT id FROM telemetry_dashboards WHERE organization_id = ? AND id = ?")
      .get(organizationId, dashboardId) as { id: string } | undefined;
    if (!dash) return 0;
    const stmt = this.sql.prepare(
      `UPDATE telemetry_dashboard_widgets SET
         grid_column = ?, grid_row = ?, col_span = ?, row_span = ?, updated_at = ?
       WHERE dashboard_id = ? AND id = ?`,
    );
    const now = nowIso();
    const tx = this.sql.transaction((all: typeof positions) => {
      let updated = 0;
      for (const p of all) {
        const info = stmt.run(
          p.gridColumn,
          p.gridRow,
          p.colSpan ?? 1,
          p.rowSpan ?? 1,
          now,
          dashboardId,
          p.id,
        );
        updated += info.changes;
      }
      return updated;
    });
    return tx(positions);
  }

  deleteWidget(organizationId: string, dashboardId: string, widgetId: string): boolean {
    this.ensure();
    // Ownership guard: only the org that owns the dashboard may delete its widgets.
    const dash = this.sql
      .prepare("SELECT id FROM telemetry_dashboards WHERE organization_id = ? AND id = ?")
      .get(organizationId, dashboardId) as { id: string } | undefined;
    if (!dash) return false;
    const info = this.sql
      .prepare("DELETE FROM telemetry_dashboard_widgets WHERE dashboard_id = ? AND id = ?")
      .run(dashboardId, widgetId);
    return info.changes > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Delete + retention                                                  */
  /* ------------------------------------------------------------------ */

  countInRange(input: {
    organizationId: string;
    scopes: string[];
    from?: string;
    to?: string;
  }): Record<string, number> {
    this.ensure();
    const out: Record<string, number> = { logs: 0, spans: 0, metrics: 0, sessions: 0 };
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [input.organizationId];
    if (input.from) {
      conditions.push("observed_at >= ?");
      params.push(input.from);
    }
    if (input.to) {
      conditions.push("observed_at <= ?");
      params.push(input.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    if (input.scopes.includes("logs") || input.scopes.includes("all")) {
      out.logs = (
        this.sql.prepare(`SELECT COUNT(*) AS c FROM telemetry_logs ${where}`).get(...params) as {
          c: number;
        }
      ).c;
    }
    if (input.scopes.includes("traces") || input.scopes.includes("all")) {
      out.spans = (
        this.sql.prepare(`SELECT COUNT(*) AS c FROM telemetry_spans ${where}`).get(...params) as {
          c: number;
        }
      ).c;
    }
    if (input.scopes.includes("metrics") || input.scopes.includes("all")) {
      out.metrics = (
        this.sql.prepare(`SELECT COUNT(*) AS c FROM telemetry_metrics ${where}`).get(...params) as {
          c: number;
        }
      ).c;
    }
    if (input.scopes.includes("sessions") || input.scopes.includes("all")) {
      const sParams: unknown[] = [input.organizationId];
      const sParts: string[] = [];
      if (input.from) {
        sParts.push("last_seen_at >= ?");
        sParams.push(input.from);
      }
      if (input.to) {
        sParts.push("last_seen_at <= ?");
        sParams.push(input.to);
      }
      const sWhere = sParts.length ? ` AND ${sParts.join(" AND ")}` : "";
      out.sessions = (
        this.sql
          .prepare(
            `SELECT COUNT(*) AS c FROM telemetry_sessions WHERE organization_id = ?${sWhere}`,
          )
          .get(...sParams) as { c: number }
      ).c;
    }
    return out;
  }

  deleteInRange(input: {
    organizationId: string;
    scopes: string[];
    from?: string;
    to?: string;
  }): Record<string, number> {
    this.ensure();
    const out: Record<string, number> = { logs: 0, spans: 0, metrics: 0, sessions: 0 };
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [input.organizationId];
    if (input.from) {
      conditions.push("observed_at >= ?");
      params.push(input.from);
    }
    if (input.to) {
      conditions.push("observed_at <= ?");
      params.push(input.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const tx = this.sql.transaction(() => {
      if (input.scopes.includes("logs") || input.scopes.includes("all")) {
        out.logs = this.sql.prepare(`DELETE FROM telemetry_logs ${where}`).run(...params).changes;
      }
      if (input.scopes.includes("traces") || input.scopes.includes("all")) {
        out.spans = this.sql.prepare(`DELETE FROM telemetry_spans ${where}`).run(...params).changes;
      }
      if (input.scopes.includes("metrics") || input.scopes.includes("all")) {
        out.metrics = this.sql
          .prepare(`DELETE FROM telemetry_metrics ${where}`)
          .run(...params).changes;
      }
      if (input.scopes.includes("sessions") || input.scopes.includes("all")) {
        const sParams: unknown[] = [input.organizationId];
        const sParts: string[] = [];
        if (input.from) {
          sParts.push("last_seen_at >= ?");
          sParams.push(input.from);
        }
        if (input.to) {
          sParts.push("last_seen_at <= ?");
          sParams.push(input.to);
        }
        const sWhere = sParts.length ? ` AND ${sParts.join(" AND ")}` : "";
        const sInfo = this.sql
          .prepare(`DELETE FROM telemetry_sessions WHERE organization_id = ?${sWhere}`)
          .run(...sParams);
        out.sessions = sInfo.changes;
        this.sql
          .prepare(
            `DELETE FROM telemetry_session_messages WHERE organization_id = ? AND session_id NOT IN
             (SELECT session_id FROM telemetry_sessions WHERE organization_id = ?)`,
          )
          .run(input.organizationId, input.organizationId);
      }
    });
    tx();
    return out;
  }

  /** Retention: delete telemetry rows older than the given cutoff. */
  retention(input: {
    organizationId: string;
    olderThan: string;
    scopes?: string[];
  }): Record<string, number> {
    return this.deleteInRange({
      organizationId: input.organizationId,
      scopes: input.scopes ?? ["logs", "traces", "metrics", "sessions"],
      to: input.olderThan,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Cost aggregation                                                    */
  /* ------------------------------------------------------------------ */

  aggregateCosts(input: {
    organizationId: string;
    provider?: string;
    model?: string;
    sessionId?: string;
    executionId?: string;
    attemptId?: string;
    from?: string;
    to?: string;
    groupBy: "provider" | "model" | "session" | "execution" | "user" | "day";
  }): Array<Record<string, unknown>> {
    this.ensure();
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [input.organizationId];
    const groupCol: Record<typeof input.groupBy, string> = {
      provider: "provider",
      model: "model",
      session: "session_id",
      execution: "execution_id",
      user: "actor_id",
      day: "date(observed_at)",
    };
    const col = groupCol[input.groupBy];
    if (input.provider) {
      conditions.push("provider = ?");
      params.push(input.provider);
    }
    if (input.model) {
      conditions.push("model = ?");
      params.push(input.model);
    }
    if (input.sessionId) {
      conditions.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.executionId) {
      conditions.push("execution_id = ?");
      params.push(input.executionId);
    }
    if (input.attemptId) {
      conditions.push("attempt_id = ?");
      params.push(input.attemptId);
    }
    if (input.from) {
      conditions.push("observed_at >= ?");
      params.push(input.from);
    }
    if (input.to) {
      conditions.push("observed_at <= ?");
      params.push(input.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const rows = this.sql
      .prepare(
        `SELECT ${col} AS key,
                COUNT(*) AS records,
                SUM(value) AS cost_usd
         FROM telemetry_metrics
         ${where}
         AND name IN ('claude_code.cost.usage', 'codex_cli_rs.cost.usage', 'gemini_cli.cost.usage',
                      'claude_code.cost.usage_user_facing', 'github_copilot.cost.usage')
         GROUP BY ${col}
         ORDER BY cost_usd DESC`,
      )
      .all(...params) as Array<{ key: string | null; records: number; cost_usd: number | null }>;
    return rows.map((r) => ({
      key: r.key ?? "unknown",
      records: Number(r.records),
      costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                              */
  /* ------------------------------------------------------------------ */

  queryAllInRange(input: { organizationId: string; from?: string; to?: string }): {
    logs: Array<Record<string, unknown>>;
    spans: Array<Record<string, unknown>>;
    metrics: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
  } {
    this.ensure();
    const conditions = ["organization_id = ?"];
    const params: unknown[] = [input.organizationId];
    if (input.from) {
      conditions.push("observed_at >= ?");
      params.push(input.from);
    }
    if (input.to) {
      conditions.push("observed_at <= ?");
      params.push(input.to);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const logs = (
      this.sql
        .prepare(`SELECT * FROM telemetry_logs ${where} ORDER BY observed_at ASC`)
        .all(...params) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const spans = (
      this.sql
        .prepare(`SELECT * FROM telemetry_spans ${where} ORDER BY observed_at ASC`)
        .all(...params) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const metrics = (
      this.sql
        .prepare(`SELECT * FROM telemetry_metrics ${where} ORDER BY observed_at ASC`)
        .all(...params) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const sessions = (
      this.sql
        .prepare(`SELECT * FROM telemetry_sessions ${where} ORDER BY last_seen_at ASC`)
        .all(...params) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    const messages = (
      this.sql
        .prepare(`SELECT * FROM telemetry_session_messages ${where} ORDER BY seq ASC`)
        .all(...params) as Array<Record<string, unknown>>
    ).map((r) => this.parseRow(r));
    return { logs, spans, metrics, sessions, messages };
  }

  /* ------------------------------------------------------------------ */
  /* Row mapping helpers                                                 */
  /* ------------------------------------------------------------------ */

  /** Raw read access for backfill (named params via better-sqlite3). */
  queryRaw(sql: string, params?: Record<string, unknown>): Array<Record<string, unknown>> {
    this.ensure();
    return this.sql.prepare(sql).all(params ?? {}) as Array<Record<string, unknown>>;
  }

  private logRow(r: LogInsert): unknown[] {
    const now = nowIso();
    return [
      r.id,
      r.organizationId,
      r.observedAt,
      r.receivedAt,
      r.provider,
      r.sourceKind,
      r.serviceName ?? null,
      r.eventName ?? null,
      r.body ?? "",
      r.severityText ?? null,
      num(r.severityNumber),
      r.sessionId ?? null,
      r.executionId ?? null,
      r.attemptId ?? null,
      r.traceId ?? null,
      r.spanId ?? null,
      r.model ?? null,
      r.operation ?? null,
      r.toolName ?? null,
      r.actorId ?? null,
      JSON.stringify(r.attributes ?? {}),
      JSON.stringify(r.resourceAttributes ?? {}),
      r.scopeName ?? null,
      r.scopeVersion ?? null,
      jsonString(r.raw),
      r.rawAvailable ? 1 : 0,
      jsonString(r.redactionMetadata),
      r.dedupKey ?? null,
      r.importSource ?? null,
      num(r.importOffset),
      r.importHash ?? null,
      r.parseStatus ?? "ok",
      r.parseError ?? null,
      r.sourcePath ?? null,
      1,
      now,
    ];
  }

  private spanRow(r: SpanInsert): unknown[] {
    const now = nowIso();
    return [
      r.id,
      r.organizationId,
      r.observedAt,
      r.receivedAt,
      r.provider,
      r.sourceKind,
      r.serviceName ?? null,
      r.traceId,
      r.spanId,
      r.parentSpanId ?? null,
      r.name,
      r.kind ?? null,
      r.status,
      r.statusMessage ?? null,
      r.startTime,
      r.endTime ?? null,
      num(r.durationNs),
      r.sessionId ?? null,
      r.executionId ?? null,
      r.attemptId ?? null,
      r.model ?? null,
      r.operation ?? null,
      r.actorId ?? null,
      JSON.stringify(r.attributes ?? {}),
      JSON.stringify(r.resourceAttributes ?? {}),
      r.scopeName ?? null,
      r.scopeVersion ?? null,
      JSON.stringify(r.events ?? []),
      JSON.stringify(r.links ?? []),
      jsonString(r.raw),
      r.rawAvailable ? 1 : 0,
      r.dedupKey ?? null,
      r.importSource ?? null,
      num(r.importOffset),
      r.importHash ?? null,
      1,
      now,
    ];
  }

  private metricRow(r: MetricInsert): unknown[] {
    const now = nowIso();
    return [
      r.id,
      r.organizationId,
      r.observedAt,
      r.startTime ?? null,
      r.receivedAt,
      r.provider,
      r.sourceKind,
      r.serviceName ?? null,
      r.name,
      r.description ?? null,
      r.unit ?? null,
      r.metricType,
      r.sessionId ?? null,
      r.executionId ?? null,
      r.attemptId ?? null,
      r.model ?? null,
      r.actorId ?? null,
      num(r.aggregationTemporality),
      int(r.isMonotonic),
      r.value ?? null,
      num(r.count),
      r.sum ?? null,
      r.min ?? null,
      r.max ?? null,
      r.bucketCounts ? JSON.stringify(r.bucketCounts) : null,
      r.explicitBounds ? JSON.stringify(r.explicitBounds) : null,
      num(r.scale),
      num(r.zeroCount),
      num(r.positiveOffset),
      r.positiveBucketCounts ? JSON.stringify(r.positiveBucketCounts) : null,
      num(r.negativeOffset),
      r.negativeBucketCounts ? JSON.stringify(r.negativeBucketCounts) : null,
      r.quantileValues ? JSON.stringify(r.quantileValues) : null,
      r.quantileQuantiles ? JSON.stringify(r.quantileQuantiles) : null,
      JSON.stringify(r.attributes ?? {}),
      JSON.stringify(r.resourceAttributes ?? {}),
      r.scopeName ?? null,
      r.scopeVersion ?? null,
      jsonString(r.raw),
      r.rawAvailable ? 1 : 0,
      r.dedupKey ?? null,
      r.importSource ?? null,
      num(r.importOffset),
      r.importHash ?? null,
      1,
      now,
    ];
  }

  private buildWhere(
    filter: QueryFilter,
    table: string,
    timeCol: string,
  ): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    conditions.push("organization_id = ?");
    params.push(filter.organizationId);
    if (filter.provider) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.serviceName) {
      conditions.push("service_name = ?");
      params.push(filter.serviceName);
    }
    if (filter.model) {
      conditions.push("model = ?");
      params.push(filter.model);
    }
    if (filter.sessionId) {
      conditions.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.executionId) {
      conditions.push("execution_id = ?");
      params.push(filter.executionId);
    }
    if (filter.attemptId) {
      conditions.push("attempt_id = ?");
      params.push(filter.attemptId);
    }
    if (filter.traceId) {
      conditions.push("trace_id = ?");
      params.push(filter.traceId);
    }
    if (filter.severity) {
      conditions.push("severity_text = ?");
      params.push(filter.severity);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.eventType && table === "telemetry_logs") {
      conditions.push("event_name = ?");
      params.push(filter.eventType);
    }
    if (filter.userId) {
      conditions.push("actor_id = ?");
      params.push(filter.userId);
    }
    if (filter.from) {
      conditions.push(`${timeCol} >= ?`);
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push(`${timeCol} <= ?`);
      params.push(filter.to);
    }
    if (filter.search) {
      const term = `%${filter.search}%`;
      if (table === "telemetry_logs") {
        conditions.push(
          "(body LIKE ? OR event_name LIKE ? OR attributes_json LIKE ? OR resource_attributes_json LIKE ?)",
        );
        params.push(term, term, term, term);
      } else if (table === "telemetry_spans") {
        conditions.push(
          "(name LIKE ? OR attributes_json LIKE ? OR resource_attributes_json LIKE ?)",
        );
        params.push(term, term, term);
      } else {
        conditions.push(
          "(name LIKE ? OR attributes_json LIKE ? OR resource_attributes_json LIKE ?)",
        );
        params.push(term, term, term);
      }
    }
    return { where: `WHERE ${conditions.join(" AND ")}`, params };
  }

  private cursorClause(cursor: string | undefined, sortDir: "ASC" | "DESC"): string {
    if (!cursor) return "";
    const decoded = decodeCursor(cursor);
    if (decoded?.kind !== "event") return "";
    const op = sortDir === "DESC" ? "<" : ">";
    return `AND (observed_at, id) ${op} (${quote(decoded.value[0])}, ${quote(decoded.value[1])})`;
  }

  private nextCursor(
    rows: Array<{ observedAt?: string; id?: string }>,
    limit: number,
    _sortDir: string,
  ): string | undefined {
    if (rows.length < limit) return undefined;
    const last = rows[rows.length - 1];
    if (!last?.observedAt || !last.id) return undefined;
    return encodeCursor(JSON.stringify({ k: "event", v: [last.observedAt, last.id] }));
  }

  private offsetFromCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    const decoded = decodeCursor(cursor);
    if (decoded?.kind !== "offset") return 0;
    return Number(decoded.value);
  }

  private parseRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const camel = toCamel(key);
      if (value === null) {
        out[camel] = null;
      } else if (
        camel === "rawAvailable" ||
        camel === "isDefault" ||
        camel === "costIsEstimate" ||
        camel === "isMonotonic"
      ) {
        out[camel] = value === 1 || value === true;
      } else if (typeof value === "string" && /_json$/.test(key)) {
        out[camel] = parseJson(value);
      } else if (typeof value === "string" && key === "parser_state_json") {
        out[camel] = parseJson(value);
      } else {
        out[camel] = value;
      }
    }
    return out;
  }
}

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function encodeCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { kind: string; value: string | [string, string] } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { k: string; v: unknown };
    if (parsed.k === "offset" && typeof parsed.v === "string") {
      return { kind: "offset", value: parsed.v };
    }
    if (
      parsed.k === "event" &&
      Array.isArray(parsed.v) &&
      typeof parsed.v[0] === "string" &&
      typeof parsed.v[1] === "string"
    ) {
      return { kind: "event", value: [parsed.v[0], parsed.v[1]] };
    }
    return null;
  } catch {
    return null;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
