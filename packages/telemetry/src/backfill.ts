import { newEventId, nowIso, providerFromServiceName, toIso } from "./canonical.js";
import { projectSession, projectTranscript } from "./projection.js";
import type { LogInsert, MetricInsert, TelemetryRepository } from "./repository.js";

/**
 * Historical backfill from existing Aaspai control-plane records.
 *
 * Re-projects `session_events`, `execution_events`, and
 * `execution_raw_outputs` into observer rows. Backfill is idempotent
 * (dedup keys derived from source ids), resumable, does not mutate the
 * source tables, preserves original timestamps and ids, and supports a
 * dry-run mode plus a bounded session/date range.
 */

export interface BackfillOptions {
  organizationId: string;
  dryRun?: boolean;
  from?: string;
  to?: string;
  sessionId?: string;
  attemptId?: string;
}

export interface BackfillResult {
  candidates: number;
  insertedLogs: number;
  insertedMetrics: number;
  skipped: number;
  failed: number;
  sessions: number;
  dryRun: boolean;
  errors: string[];
}

interface RawSessionEvent {
  id: number;
  session_id: string;
  ts: string;
  kind: string;
  payload_json: string;
  seq: number;
}

interface RawExecutionEvent {
  id: number;
  organization_id: string;
  attempt_id: string;
  ts: string;
  type: string;
  payload_json: string;
  seq: number;
}

interface RawExecutionOutput {
  id: number;
  organization_id: string;
  attempt_id: string;
  ts: string;
  stream: string;
  chunk: string;
  seq: number;
}

export function backfillFromControlPlane(
  repo: TelemetryRepository,
  options: BackfillOptions,
): BackfillResult {
  const result: BackfillResult = {
    candidates: 0,
    insertedLogs: 0,
    insertedMetrics: 0,
    skipped: 0,
    failed: 0,
    sessions: 0,
    dryRun: options.dryRun ?? false,
    errors: [],
  };
  const receivedAt = nowIso();
  const logs: LogInsert[] = [];
  const metrics: MetricInsert[] = [];

  // session_events -> transcript logs
  const sessionEventRows = repo.queryRaw(
    `SELECT * FROM session_events
     WHERE ($org = '') OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_events.session_id AND s.organization_id = $org)
       AND ($from = '' OR ts >= $from)
       AND ($to = '' OR ts <= $to)
       AND ($session = '' OR session_id = $session)
     ORDER BY session_id, seq ASC`,
    {
      org: options.organizationId,
      from: options.from ?? "",
      to: options.to ?? "",
      session: options.sessionId ?? "",
    },
  ) as unknown as RawSessionEvent[];
  result.candidates += sessionEventRows.length;
  for (const event of sessionEventRows) {
    const payload = parseJsonObject(event.payload_json);
    const text = typeof payload?.text === "string" ? payload.text : "";
    const stream = payload?.stream === "stderr" ? "stderr" : "stdout";
    logs.push({
      id: newEventId("tlog"),
      organizationId: options.organizationId,
      observedAt: toIso(event.ts) ?? receivedAt,
      receivedAt,
      provider: "aaspai",
      sourceKind: "backfill",
      serviceName: "aaspai",
      eventName: event.kind === "stdout" || event.kind === "stderr" ? undefined : event.kind,
      body: text.slice(0, 16_384),
      severityText: event.kind === "stderr" || event.kind === "error" ? "ERROR" : "INFO",
      severityNumber: event.kind === "stderr" || event.kind === "error" ? 17 : 9,
      sessionId: event.session_id,
      attributes: { stream, source: "session_events", kind: event.kind },
      dedupKey: `backfill:session_events:${event.id}`,
      importSource: "backfill",
      parseStatus: "ok",
      rawAvailable: false,
    });
  }

  // execution_events -> lifecycle logs
  const executionEventRows = repo.queryRaw(
    `SELECT * FROM execution_events
     WHERE organization_id = $org
       AND ($from = '' OR ts >= $from)
       AND ($to = '' OR ts <= $to)
       AND ($attempt = '' OR attempt_id = $attempt)
     ORDER BY attempt_id, seq ASC`,
    {
      org: options.organizationId,
      from: options.from ?? "",
      to: options.to ?? "",
      attempt: options.attemptId ?? "",
    },
  ) as unknown as RawExecutionEvent[];
  result.candidates += executionEventRows.length;
  for (const event of executionEventRows) {
    const payload = parseJsonObject(event.payload_json);
    logs.push({
      id: newEventId("tlog"),
      organizationId: options.organizationId,
      observedAt: toIso(event.ts) ?? receivedAt,
      receivedAt,
      provider: "runtime",
      sourceKind: "backfill",
      serviceName: "runtime",
      eventName: event.type,
      body: event.type.slice(0, 16_384),
      severityText: "INFO",
      severityNumber: 9,
      attemptId: event.attempt_id,
      attributes: { source: "execution_events", ...(payload ?? {}) },
      dedupKey: `backfill:execution_events:${event.id}`,
      importSource: "backfill",
      parseStatus: "ok",
      rawAvailable: false,
    });
  }

  // execution_raw_outputs -> stdout/stderr logs
  const rawOutputRows = repo.queryRaw(
    `SELECT * FROM execution_raw_outputs
     WHERE organization_id = $org
       AND ($from = '' OR ts >= $from)
       AND ($to = '' OR ts <= $to)
       AND ($attempt = '' OR attempt_id = $attempt)
     ORDER BY attempt_id, seq ASC`,
    {
      org: options.organizationId,
      from: options.from ?? "",
      to: options.to ?? "",
      attempt: options.attemptId ?? "",
    },
  ) as unknown as RawExecutionOutput[];
  result.candidates += rawOutputRows.length;
  for (const row of rawOutputRows) {
    logs.push({
      id: newEventId("tlog"),
      organizationId: options.organizationId,
      observedAt: toIso(row.ts) ?? receivedAt,
      receivedAt,
      provider: "runtime",
      sourceKind: "backfill",
      serviceName: "runtime",
      eventName: row.stream === "stderr" ? "stderr" : "stdout",
      body: row.chunk.slice(0, 16_384),
      severityText: row.stream === "stderr" ? "ERROR" : "INFO",
      severityNumber: row.stream === "stderr" ? 17 : 9,
      attemptId: row.attempt_id,
      attributes: { stream: row.stream, source: "execution_raw_outputs" },
      dedupKey: `backfill:execution_raw_outputs:${row.id}`,
      importSource: "backfill",
      parseStatus: "ok",
      rawAvailable: false,
    });
  }

  if (options.dryRun) {
    result.insertedLogs = logs.length;
    return result;
  }

  const insert = repo.insertBatch({ logs, metrics });
  result.insertedLogs = insert.logs;
  result.insertedMetrics = insert.metrics;
  result.skipped = logs.length - insert.logs;

  // Rebuild session projections from backfilled logs.
  const bySession = new Map<string, LogInsert[]>();
  for (const log of logs) {
    if (!log.sessionId) continue;
    const bucket = bySession.get(log.sessionId) ?? [];
    bucket.push(log);
    bySession.set(log.sessionId, bucket);
  }
  for (const [sessionId, sessionLogs] of bySession) {
    try {
      const projection = projectSession({
        organizationId: options.organizationId,
        sessionId,
        provider: providerFromServiceName("aaspai"),
        logs: sessionLogs,
      });
      repo.upsertSessionSummary({
        id: `tsess_${sessionId}`,
        organizationId: options.organizationId,
        provider: "aaspai",
        sessionId,
        firstSeenAt: projection.firstSeenAt,
        lastSeenAt: projection.lastSeenAt,
        status: "backfilled",
        model: projection.model,
        messageCount: projection.messageCount,
        toolCallCount: projection.toolCallCount,
      });
      const messages = projectTranscript(sessionLogs).map((m) => ({
        id: m.id,
        organizationId: m.organizationId,
        sessionId: m.sessionId,
        seq: m.seq,
        ts: m.ts,
        role: m.role,
        kind: m.kind,
        text: m.text,
        toolName: m.toolName,
        toolInput: m.toolInput,
        toolResult: m.toolResult,
        attributes: m.attributes,
        raw: m.raw,
      }));
      repo.insertTranscriptMessages(messages);
      result.sessions += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${sessionId}: ${String(err)}`);
    }
  }

  return result;
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
