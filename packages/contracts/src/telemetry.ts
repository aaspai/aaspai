import { z } from "zod";
import {
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  positiveIntegerSchema,
} from "./primitives";

/**
 * Canonical AI-observer telemetry contracts.
 *
 * These are the read-side model for agent-session telemetry (logs,
 * spans, metrics, sessions, transcripts, cost, import state, dashboards).
 * They deliberately mirror the AI Observer reference model while adding
 * Aaspai tenant ownership and the plan's common envelope (observed vs
 * received time, raw-payload retention, dedup keys, import cursors).
 *
 * Every record that can be viewed by a human must be organization
 * scoped; the server derives ownership from the authenticated principal
 * and never trusts a client-supplied organization id.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const telemetryProviderSchema = z.enum([
  "claude-code",
  "codex_cli_rs",
  "gemini_cli",
  "opencode",
  "copilot-chat",
  "github-copilot",
  "aaspai",
  "runtime",
  "unknown",
]);
export type TelemetryProvider = z.infer<typeof telemetryProviderSchema>;

export const telemetrySourceKindSchema = z.enum([
  "otlp",
  "import",
  "watch",
  "aaspai_native",
  "backfill",
]);
export type TelemetrySourceKind = z.infer<typeof telemetrySourceKindSchema>;

/** A single key/value attribute; values are stored as JSON-safe strings. */
export const telemetryAttributeSchema = z.object({
  key: z.string().trim().min(1).max(512),
  value: jsonObjectSchema,
});
export type TelemetryAttribute = z.infer<typeof telemetryAttributeSchema>;

/**
 * The plan §7.1 common envelope. Every observer event carries these
 * correlation fields when known. Unknown values are null/absent, never
 * misleading empty strings.
 */
export const telemetryEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    eventId: identifierSchema,
    provider: telemetryProviderSchema,
    sourceKind: telemetrySourceKindSchema,
    observedAt: isoTimestampSchema,
    receivedAt: isoTimestampSchema,
    organizationId: identifierSchema,
    actorId: identifierSchema.optional(),
    sessionId: identifierSchema.optional(),
    executionId: identifierSchema.optional(),
    attemptId: identifierSchema.optional(),
    traceId: identifierSchema.optional(),
    spanId: identifierSchema.optional(),
    parentSpanId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    model: z.string().trim().max(256).optional(),
    operation: z.string().trim().max(512).optional(),
    severity: z.string().trim().max(64).optional(),
    status: z.string().trim().max(64).optional(),
    attributes: jsonObjectSchema.optional(),
    resourceAttributes: jsonObjectSchema.optional(),
    scopeName: z.string().trim().max(256).optional(),
    scopeVersion: z.string().trim().max(64).optional(),
    normalizedPayload: jsonObjectSchema.optional(),
    rawPayload: jsonObjectSchema.optional(),
    rawAvailable: z.boolean(),
    redactionMetadata: jsonObjectSchema.optional(),
    dedupKey: z.string().trim().min(1).max(512).optional(),
    importSource: z.string().trim().max(128).optional(),
    importOffset: z.number().int().nonnegative().optional(),
    importHash: z.string().trim().max(128).optional(),
  })
  .strict();
export type TelemetryEnvelope = z.infer<typeof telemetryEnvelopeSchema>;

/** A canonical normalized log record (§7.2). */
export const telemetryLogEventSchema = z
  .object({
    ...telemetryEnvelopeSchema.shape,
    body: z.string().max(16_384),
    severityText: z.string().trim().max(64).optional(),
    severityNumber: z.number().int().nonnegative().optional(),
    serviceName: z.string().trim().max(256).optional(),
    eventName: z.string().trim().max(512).optional(),
    toolName: z.string().trim().max(256).optional(),
    parseError: z.string().max(4_096).optional(),
    parseStatus: z.enum(["ok", "error", "unknown"]),
    sourcePath: z.string().trim().max(4_096).optional(),
  })
  .strict();
export type TelemetryLogEvent = z.infer<typeof telemetryLogEventSchema>;

/** A canonical normalized span (§7.3). Orphan spans are valid. */
export const telemetrySpanSchema = z
  .object({
    ...telemetryEnvelopeSchema.shape,
    traceId: identifierSchema,
    spanId: identifierSchema,
    parentSpanId: identifierSchema.optional(),
    name: z.string().trim().min(1).max(512),
    kind: z.string().trim().max(64).optional(),
    status: z.enum(["ok", "error", "unset"]),
    statusMessage: z.string().max(4_096).optional(),
    serviceName: z.string().trim().max(256).optional(),
    startTime: isoTimestampSchema,
    endTime: isoTimestampSchema.optional(),
    durationNs: z.number().int().nonnegative().optional(),
    events: z.array(jsonObjectSchema).max(128).optional(),
    links: z.array(jsonObjectSchema).max(128).optional(),
  })
  .strict();
export type TelemetrySpan = z.infer<typeof telemetrySpanSchema>;

/** Canonical metric data (§7.4). One row per data point. */
export const telemetryMetricSchema = z
  .object({
    ...telemetryEnvelopeSchema.shape,
    name: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).optional(),
    unit: z.string().trim().max(64).optional(),
    metricType: z.enum(["gauge", "sum", "histogram", "exponential_histogram", "summary"]),
    serviceName: z.string().trim().max(256).optional(),
    startTime: isoTimestampSchema.optional(),
    aggregationTemporality: z.number().int().nonnegative().optional(),
    isMonotonic: z.boolean().optional(),
    value: z.number().optional(),
    count: z.number().int().nonnegative().optional(),
    sum: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    bucketCounts: z.array(z.number()).max(2_048).optional(),
    explicitBounds: z.array(z.number()).max(2_048).optional(),
    scale: z.number().int().optional(),
    zeroCount: z.number().int().nonnegative().optional(),
    positiveOffset: z.number().int().optional(),
    positiveBucketCounts: z.array(z.number()).max(2_048).optional(),
    negativeOffset: z.number().int().optional(),
    negativeBucketCounts: z.array(z.number()).max(2_048).optional(),
    quantileValues: z.array(z.number()).max(128).optional(),
    quantileQuantiles: z.array(z.number()).max(128).optional(),
  })
  .strict();
export type TelemetryMetric = z.infer<typeof telemetryMetricSchema>;

/** Projected session summary (§7.5). Derived; never a second source of truth. */
export const telemetrySessionSummarySchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    id: identifierSchema,
    organizationId: identifierSchema,
    provider: telemetryProviderSchema,
    sessionId: identifierSchema,
    firstSeenAt: isoTimestampSchema,
    lastSeenAt: isoTimestampSchema,
    status: z.string().trim().max(64).optional(),
    model: z.string().trim().max(256).optional(),
    userId: identifierSchema.optional(),
    executionIds: z.array(identifierSchema).max(64).optional(),
    attemptIds: z.array(identifierSchema).max(64).optional(),
    traceIds: z.array(identifierSchema).max(64).optional(),
    messageCount: z.number().int().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    usage: jsonObjectSchema.optional(),
    costUsd: z.number().optional(),
    costIsEstimate: z.boolean().optional(),
    warnings: z.array(z.string().max(4_096)).max(128).optional(),
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TelemetrySessionSummary = z.infer<typeof telemetrySessionSummarySchema>;

/** A transcript message row (§7.5). */
export const telemetryTranscriptMessageSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    sessionId: identifierSchema,
    seq: z.number().int().nonnegative(),
    ts: isoTimestampSchema,
    role: z.enum(["user", "assistant", "tool_use", "tool_result", "system", "unknown"]),
    kind: z.string().trim().max(64),
    text: z.string().max(16_384).optional(),
    toolName: z.string().trim().max(256).optional(),
    toolInput: jsonObjectSchema.optional(),
    toolResult: jsonObjectSchema.optional(),
    attributes: jsonObjectSchema.optional(),
    raw: jsonObjectSchema.optional(),
  })
  .strict();
export type TelemetryTranscriptMessage = z.infer<typeof telemetryTranscriptMessageSchema>;

/** Usage/cost result (§7.6). Estimates are explicitly marked. */
export const telemetryUsageCostSchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    organizationId: identifierSchema,
    provider: telemetryProviderSchema,
    model: z.string().trim().max(256).optional(),
    sessionId: identifierSchema.optional(),
    executionId: identifierSchema.optional(),
    attemptId: identifierSchema.optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    toolTokens: z.number().int().nonnegative().optional(),
    otherTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().optional(),
    costSource: z.enum(["provider", "calculated", "unknown"]),
    costIsEstimate: z.boolean(),
    pricingVersion: z.string().trim().max(64).optional(),
  })
  .strict();
export type TelemetryUsageCost = z.infer<typeof telemetryUsageCostSchema>;

/** Import job + progress (§8.3). */
export const telemetryImportProgressSchema = z
  .object({
    source: telemetryProviderSchema,
    filePath: z.string().trim().max(4_096),
    fileHash: z.string().trim().max(128),
    importedAt: isoTimestampSchema,
    recordCount: z.number().int().nonnegative(),
    byteOffset: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    parserState: jsonObjectSchema.optional(),
    status: z.enum(["new", "modified", "current", "error", "partial"]),
    lastError: z.string().max(4_096).optional(),
  })
  .strict();
export type TelemetryImportProgress = z.infer<typeof telemetryImportProgressSchema>;

/** Dashboard definition (§9.3). Widgets are data, not rendered blobs. */
export const telemetryDashboardWidgetSchema = z
  .object({
    id: identifierSchema,
    dashboardId: identifierSchema,
    widgetType: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(256),
    gridColumn: z.number().int().nonnegative(),
    gridRow: z.number().int().nonnegative(),
    colSpan: z.number().int().nonnegative().default(1),
    rowSpan: z.number().int().nonnegative().default(1),
    config: jsonObjectSchema.optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TelemetryDashboardWidget = z.infer<typeof telemetryDashboardWidgetSchema>;

export const telemetryDashboardSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    name: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).optional(),
    isDefault: z.boolean().default(false),
    widgets: z.array(telemetryDashboardWidgetSchema).max(256).optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type TelemetryDashboard = z.infer<typeof telemetryDashboardSchema>;

/** Query filters + cursor pagination (§9.1). */
export const telemetryQueryFilterSchema = z
  .object({
    organizationId: identifierSchema,
    provider: telemetryProviderSchema.optional(),
    serviceName: z.string().trim().max(256).optional(),
    model: z.string().trim().max(256).optional(),
    sessionId: identifierSchema.optional(),
    executionId: identifierSchema.optional(),
    attemptId: identifierSchema.optional(),
    traceId: identifierSchema.optional(),
    severity: z.string().trim().max(64).optional(),
    status: z.string().trim().max(64).optional(),
    eventType: z.string().trim().max(256).optional(),
    search: z.string().trim().max(256).optional(),
    from: isoTimestampSchema.optional(),
    to: isoTimestampSchema.optional(),
    userId: identifierSchema.optional(),
    cursor: z.string().trim().max(512).optional(),
    limit: z.number().int().nonnegative().max(1_000).default(50),
    sort: z.enum(["desc", "asc"]).default("desc"),
  })
  .strict();
export type TelemetryQueryFilter = z.infer<typeof telemetryQueryFilterSchema>;

/** Cursor-paginated response envelope. */
export const telemetryCursorResponseSchema = z
  .object({
    items: z.array(z.unknown()),
    nextCursor: z.string().max(512).optional(),
    total: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type TelemetryCursorResponse = z.infer<typeof telemetryCursorResponseSchema>;

/** Export manifest (§9.1 / OBS-T205). */
export const telemetryExportManifestSchema = z
  .object({
    exportId: identifierSchema,
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    organizationId: identifierSchema,
    generatedAt: isoTimestampSchema,
    timeRange: z
      .object({
        from: isoTimestampSchema,
        to: isoTimestampSchema,
      })
      .optional(),
    sources: z.array(telemetrySourceKindSchema),
    counts: z
      .object({
        logs: z.number().int().nonnegative(),
        spans: z.number().int().nonnegative(),
        metrics: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        messages: z.number().int().nonnegative(),
        dashboards: z.number().int().nonnegative(),
      })
      .optional(),
    files: z.array(
      z.object({
        name: z.string().trim().min(1),
        checksumSha256: z.string().trim().max(128).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
      }),
    ),
    redactionApplied: z.boolean(),
  })
  .strict();
export type TelemetryExportManifest = z.infer<typeof telemetryExportManifestSchema>;

/** Deletion result (§8 / OBS-T240). */
export const telemetryDeletionResultSchema = z
  .object({
    organizationId: identifierSchema,
    scopes: z.array(z.enum(["logs", "traces", "metrics", "sessions", "all"])),
    from: isoTimestampSchema.optional(),
    to: isoTimestampSchema.optional(),
    logsDeleted: z.number().int().nonnegative(),
    spansDeleted: z.number().int().nonnegative(),
    metricsDeleted: z.number().int().nonnegative(),
    sessionsDeleted: z.number().int().nonnegative(),
    auditRecorded: z.boolean(),
  })
  .strict();
export type TelemetryDeletionResult = z.infer<typeof telemetryDeletionResultSchema>;

/** Durable ingestion error (§8.2). */
export const telemetryIngestionErrorSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    ts: isoTimestampSchema,
    sourceKind: telemetrySourceKindSchema,
    kind: z.string().trim().min(1).max(64),
    message: z.string().max(4_096),
    raw: jsonObjectSchema.optional(),
    recordCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type TelemetryIngestionError = z.infer<typeof telemetryIngestionErrorSchema>;

/** Live event envelope (§9.2). */
export const telemetryLiveEventSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    type: z.enum(["log", "span", "metric", "session", "ingest_error", "import"]),
    ts: isoTimestampSchema,
    event: jsonObjectSchema,
  })
  .strict();
export type TelemetryLiveEvent = z.infer<typeof telemetryLiveEventSchema>;

/** Reference-comparison result (§11). */
export const telemetryComparisonResultSchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    corpus: z.string().trim().min(1).max(512),
    fixture: z.string().trim().min(1).max(512),
    expectedCounts: jsonObjectSchema,
    actualCounts: jsonObjectSchema,
    differences: z.array(
      z.object({
        field: z.string().trim().min(1),
        expected: z.unknown(),
        actual: z.unknown(),
        classification: z.enum(["match", "acceptable", "reference_limitation", "defect"]),
      }),
    ),
    matching: z.boolean(),
  })
  .strict();
export type TelemetryComparisonResult = z.infer<typeof telemetryComparisonResultSchema>;

export const MAX_TELEMETRY_BODY_BYTES = positiveIntegerSchema.safeParse(16_384).success
  ? 16_384
  : 16_384;
export const MAX_TELEMETRY_ATTRIBUTE_COUNT = 128;
export const MAX_TELEMETRY_ATTRIBUTE_KEY_BYTES = 512;
export const MAX_TELEMETRY_RAW_PAYLOAD_BYTES = 256 * 1024;
export const MAX_OTLP_BODY_BYTES = 10 * 1024 * 1024;
