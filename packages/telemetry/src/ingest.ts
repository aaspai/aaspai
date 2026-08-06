import { nowIso, providerFromServiceName } from "./canonical.js";
import type { ImportResult, ImportSource, ImportState, SessionParser } from "./importers/index.js";
import type { LiveHub } from "./live.js";
import { decodeOtlp, type OtlpDecodeResult, OtlpError, type OtlpRequest } from "./otlp.js";
import { projectSession, projectTranscript } from "./projection.js";
import { publishLive } from "./publish.js";
import { redactRawPayload, redactValue } from "./redact.js";
import type { LogInsert, MetricInsert, SpanInsert, TelemetryRepository } from "./repository.js";

/**
 * High-level ingestion entry points used by the API, worker, and CLI.
 *
 * - OTLP: decode → redact → persist → live-publish, reporting
 *   accepted/rejected counts and persisting diagnosable errors.
 * - Native files: parse → commit cursor atomically → project session.
 */

export interface IngestReport {
  accepted: { logs: number; spans: number; metrics: number };
  rejected: { logs: number; spans: number; metrics: number };
  errors: string[];
}

export function ingestOtlpRequest(
  repo: TelemetryRepository,
  hub: LiveHub,
  request: OtlpRequest,
): IngestReport {
  const report: IngestReport = {
    accepted: { logs: 0, spans: 0, metrics: 0 },
    rejected: { logs: 0, spans: 0, metrics: 0 },
    errors: [],
  };
  let decoded: OtlpDecodeResult;
  try {
    decoded = decodeOtlp(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof OtlpError ? err.code : "invalid_request";
    report.errors.push(message);
    repo.insertIngestError({
      organizationId: request.organizationId,
      sourceKind: "otlp",
      kind: code,
      message,
    });
    return report;
  }

  // Redact raw payloads AND normalized attributes before persistence.
  const redactedLogs: LogInsert[] = [];
  for (const log of decoded.logs) {
    const raw = redactValue(log.raw);
    const attrs = redactValue(log.attributes);
    const resourceAttrs = redactValue(log.resourceAttributes);
    redactedLogs.push({
      ...log,
      attributes: attrs.value as Record<string, unknown>,
      resourceAttributes: resourceAttrs.value as Record<string, unknown> | undefined,
      raw: raw.value,
      rawAvailable: true,
      redactionMetadata: {
        raw: raw.redacted,
        attributes: attrs.redacted,
        resourceAttributes: resourceAttrs.redacted,
        rawTruncated: raw.truncated,
      },
    });
  }
  const redactedSpans: SpanInsert[] = decoded.spans.map((span) => {
    const raw = redactValue(span.raw);
    const attrs = redactValue(span.attributes);
    return {
      ...span,
      attributes: attrs.value as Record<string, unknown>,
      raw: raw.value,
      rawAvailable: true,
    };
  });
  const redactedMetrics: MetricInsert[] = decoded.metrics.map((metric) => {
    const raw = redactValue(metric.raw);
    const attrs = redactValue(metric.attributes);
    return {
      ...metric,
      attributes: attrs.value as Record<string, unknown>,
      raw: raw.value,
      rawAvailable: true,
    };
  });

  try {
    const result = repo.insertBatch({
      logs: redactedLogs,
      spans: redactedSpans,
      metrics: redactedMetrics,
    });
    report.accepted.logs = result.logs;
    report.accepted.spans = result.spans;
    report.accepted.metrics = result.metrics;
    report.rejected.logs = redactedLogs.length - result.logs;
    report.rejected.spans = result.spansSkipped;
    report.rejected.metrics = redactedMetrics.length - result.metrics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    repo.insertIngestError({
      organizationId: request.organizationId,
      sourceKind: "otlp",
      kind: "persist_failed",
      message,
    });
    return report;
  }

  for (const log of redactedLogs) {
    publishLive(repo, hub, request.organizationId, "log", {
      id: log.id,
      observedAt: log.observedAt,
      provider: log.provider,
      body: log.body,
    });
  }
  for (const span of redactedSpans) {
    publishLive(repo, hub, request.organizationId, "span", {
      id: span.id,
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
    });
  }
  for (const metric of redactedMetrics) {
    publishLive(repo, hub, request.organizationId, "metric", {
      id: metric.id,
      name: metric.name,
      value: metric.value,
    });
  }
  return report;
}

export interface ImportFileOptions {
  organizationId: string;
  source: ImportSource;
  filePath: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface ImportFileResult {
  sessionId: string;
  logs: number;
  metrics: number;
  spans: number;
  recordCount: number;
  status: "new" | "modified" | "current" | "error";
  dryRun: boolean;
}

export async function importProviderFile(
  repo: TelemetryRepository,
  hub: LiveHub,
  parser: SessionParser,
  options: ImportFileOptions,
): Promise<ImportFileResult> {
  const existing = repo.getImportState(options.organizationId, options.source, options.filePath);
  const { computeFileHash } = await import("./importers/index.js");
  const fileHash = await computeFileHash(options.filePath).catch(() => "");

  if (existing && existing.fileHash === fileHash && existing.recordCount > 0 && !options.force) {
    return {
      sessionId: "",
      logs: 0,
      metrics: 0,
      spans: 0,
      recordCount: existing.recordCount,
      status: "current",
      dryRun: options.dryRun ?? false,
    };
  }

  const state: ImportState =
    existing && existing.byteOffset > 0
      ? {
          byteOffset: existing.byteOffset,
          messageCount: existing.messageCount,
          parserState: existing.parserState ?? {},
        }
      : { byteOffset: 0, messageCount: 0, parserState: {} };

  const result: ImportResult = await parser.parseFile(options.filePath);
  const status: ImportFileResult["status"] = existing ? "modified" : "new";

  if (options.dryRun) {
    return {
      sessionId: result.sessionId,
      logs: result.logs.length,
      metrics: result.metrics.length,
      spans: result.spans.length,
      recordCount: result.recordCount,
      status,
      dryRun: true,
    };
  }

  const now = nowIso();
  const commit = repo.commitWatchBatch({
    logs: result.logs,
    spans: result.spans,
    metrics: result.metrics,
    state: {
      organizationId: options.organizationId,
      source: options.source,
      filePath: options.filePath,
      fileHash,
      importedAt: existing?.importedAt ?? now,
      recordCount: (existing?.recordCount ?? 0) + result.recordCount,
      byteOffset: state.byteOffset + result.logs.length,
      messageCount: state.messageCount + result.recordCount,
      parserState: state.parserState,
      status: "current",
    },
  });

  // Project a session summary + transcript from imported logs.
  if (result.sessionId && result.logs.length > 0) {
    const projection = projectSession({
      organizationId: options.organizationId,
      sessionId: result.sessionId,
      provider: providerFromServiceName(options.source),
      logs: result.logs,
    });
    repo.upsertSessionSummary({
      id: `tsess_${result.sessionId}`,
      organizationId: options.organizationId,
      provider: providerFromServiceName(options.source),
      sessionId: result.sessionId,
      firstSeenAt: projection.firstSeenAt,
      lastSeenAt: projection.lastSeenAt,
      model: projection.model,
      messageCount: projection.messageCount,
      toolCallCount: projection.toolCallCount,
    });
    repo.insertTranscriptMessages(projectTranscript(result.logs));
  }

  for (const log of result.logs) {
    publishLive(repo, hub, options.organizationId, "log", {
      id: log.id,
      observedAt: log.observedAt,
      provider: log.provider,
      body: log.body,
    });
  }
  publishLive(repo, hub, options.organizationId, "import", {
    source: options.source,
    filePath: options.filePath,
    inserted: commit.logs + commit.metrics + commit.spans,
  });

  return {
    sessionId: result.sessionId,
    logs: commit.logs,
    metrics: commit.metrics,
    spans: commit.spans,
    recordCount: result.recordCount,
    status,
    dryRun: false,
  };
}

export { redactRawPayload };
