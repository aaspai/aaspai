import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * AI-observer telemetry tables.
 *
 * These mirror the AI Observer reference model (flat tables with JSON
 * columns) and add Aaspai tenant ownership. Every row carries
 * `organization_id`; all queries are org-scoped by the repository.
 *
 * The migration DDL in `packages/db/src/migrations.ts` is the
 * authoritative storage definition; these drizzle tables are the typed
 * ORM view used by tests and the web read model.
 */

export const telemetryLogs = sqliteTable(
  "telemetry_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    observedAt: text("observed_at").notNull(),
    receivedAt: text("received_at").notNull(),
    provider: text("provider").notNull(),
    sourceKind: text("source_kind").notNull(),
    serviceName: text("service_name"),
    eventName: text("event_name"),
    body: text("body").notNull().default(""),
    severityText: text("severity_text"),
    severityNumber: integer("severity_number"),
    sessionId: text("session_id"),
    executionId: text("execution_id"),
    attemptId: text("attempt_id"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    model: text("model"),
    operation: text("operation"),
    toolName: text("tool_name"),
    actorId: text("actor_id"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    resourceAttributesJson: text("resource_attributes_json").notNull().default("{}"),
    scopeName: text("scope_name"),
    scopeVersion: text("scope_version"),
    rawJson: text("raw_json"),
    rawAvailable: integer("raw_available").notNull().default(0),
    redactionMetadataJson: text("redaction_metadata_json"),
    dedupKey: text("dedup_key"),
    importSource: text("import_source"),
    importOffset: integer("import_offset"),
    importHash: text("import_hash"),
    parseStatus: text("parse_status").notNull().default("ok"),
    parseError: text("parse_error"),
    sourcePath: text("source_path"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgObservedIdx: index("tl_org_observed_idx").on(t.organizationId, t.observedAt),
    orgSessionIdx: index("tl_org_session_idx").on(t.organizationId, t.sessionId, t.observedAt),
    orgExecutionIdx: index("tl_org_execution_idx").on(
      t.organizationId,
      t.executionId,
      t.observedAt,
    ),
    orgTraceIdx: index("tl_org_trace_idx").on(t.organizationId, t.traceId),
    orgProviderModelIdx: index("tl_org_provider_model_idx").on(
      t.organizationId,
      t.provider,
      t.model,
      t.observedAt,
    ),
    dedupKeyUniq: uniqueIndex("tl_org_dedup_key_uniq").on(t.organizationId, t.dedupKey),
  }),
);

export const telemetrySpans = sqliteTable(
  "telemetry_spans",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    observedAt: text("observed_at").notNull(),
    receivedAt: text("received_at").notNull(),
    provider: text("provider").notNull(),
    sourceKind: text("source_kind").notNull(),
    serviceName: text("service_name"),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind"),
    status: text("status").notNull().default("unset"),
    statusMessage: text("status_message"),
    startTime: text("start_time").notNull(),
    endTime: text("end_time"),
    durationNs: integer("duration_ns"),
    sessionId: text("session_id"),
    executionId: text("execution_id"),
    attemptId: text("attempt_id"),
    model: text("model"),
    operation: text("operation"),
    actorId: text("actor_id"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    resourceAttributesJson: text("resource_attributes_json").notNull().default("{}"),
    scopeName: text("scope_name"),
    scopeVersion: text("scope_version"),
    eventsJson: text("events_json").notNull().default("[]"),
    linksJson: text("links_json").notNull().default("[]"),
    rawJson: text("raw_json"),
    rawAvailable: integer("raw_available").notNull().default(0),
    dedupKey: text("dedup_key"),
    importSource: text("import_source"),
    importOffset: integer("import_offset"),
    importHash: text("import_hash"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgTraceIdx: index("ts_org_trace_idx").on(t.organizationId, t.traceId, t.observedAt),
    orgSpanUniq: uniqueIndex("ts_org_span_uniq").on(t.organizationId, t.traceId, t.spanId),
    orgObservedIdx: index("ts_org_observed_idx").on(t.organizationId, t.observedAt),
    orgSessionIdx: index("ts_org_session_idx").on(t.organizationId, t.sessionId, t.observedAt),
  }),
);

export const telemetryMetrics = sqliteTable(
  "telemetry_metrics",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    observedAt: text("observed_at").notNull(),
    startTime: text("start_time"),
    receivedAt: text("received_at").notNull(),
    provider: text("provider").notNull(),
    sourceKind: text("source_kind").notNull(),
    serviceName: text("service_name"),
    name: text("name").notNull(),
    description: text("description"),
    unit: text("unit"),
    metricType: text("metric_type").notNull(),
    sessionId: text("session_id"),
    executionId: text("execution_id"),
    attemptId: text("attempt_id"),
    model: text("model"),
    actorId: text("actor_id"),
    aggregationTemporality: integer("aggregation_temporality"),
    isMonotonic: integer("is_monotonic"),
    value: real("value"),
    count: integer("count"),
    sum: real("sum"),
    min: real("min"),
    max: real("max"),
    bucketCountsJson: text("bucket_counts_json"),
    explicitBoundsJson: text("explicit_bounds_json"),
    scale: integer("scale"),
    zeroCount: integer("zero_count"),
    positiveOffset: integer("positive_offset"),
    positiveBucketCountsJson: text("positive_bucket_counts_json"),
    negativeOffset: integer("negative_offset"),
    negativeBucketCountsJson: text("negative_bucket_counts_json"),
    quantileValuesJson: text("quantile_values_json"),
    quantileQuantilesJson: text("quantile_quantiles_json"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    resourceAttributesJson: text("resource_attributes_json").notNull().default("{}"),
    scopeName: text("scope_name"),
    scopeVersion: text("scope_version"),
    rawJson: text("raw_json"),
    rawAvailable: integer("raw_available").notNull().default(0),
    dedupKey: text("dedup_key"),
    importSource: text("import_source"),
    importOffset: integer("import_offset"),
    importHash: text("import_hash"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgObservedIdx: index("tm_org_observed_idx").on(t.organizationId, t.observedAt),
    orgNameIdx: index("tm_org_name_idx").on(t.organizationId, t.name, t.observedAt),
    orgServiceIdx: index("tm_org_service_idx").on(t.organizationId, t.serviceName, t.observedAt),
  }),
);

export const telemetrySessions = sqliteTable(
  "telemetry_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    provider: text("provider").notNull(),
    sessionId: text("session_id").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    status: text("status"),
    model: text("model"),
    userId: text("user_id"),
    executionIdsJson: text("execution_ids_json").notNull().default("[]"),
    attemptIdsJson: text("attempt_ids_json").notNull().default("[]"),
    traceIdsJson: text("trace_ids_json").notNull().default("[]"),
    messageCount: integer("message_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    usageJson: text("usage_json"),
    costUsd: real("cost_usd"),
    costIsEstimate: integer("cost_is_estimate").notNull().default(0),
    warningsJson: text("warnings_json").notNull().default("[]"),
    schemaVersion: integer("schema_version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgSessionUniq: uniqueIndex("tsess_org_session_uniq").on(t.organizationId, t.sessionId),
    orgLastSeenIdx: index("tsess_org_last_seen_idx").on(t.organizationId, t.lastSeenAt),
  }),
);

export const telemetrySessionMessages = sqliteTable(
  "telemetry_session_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    ts: text("ts").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    text: text("text"),
    toolName: text("tool_name"),
    toolInputJson: text("tool_input_json"),
    toolResultJson: text("tool_result_json"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    rawJson: text("raw_json"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionSeqUniq: uniqueIndex("tmsg_session_seq_uniq").on(t.organizationId, t.sessionId, t.seq),
    sessionIdx: index("tmsg_session_idx").on(t.organizationId, t.sessionId, t.seq),
  }),
);

export const telemetryImportState = sqliteTable(
  "telemetry_import_state",
  {
    organizationId: text("organization_id").notNull(),
    source: text("source").notNull(),
    filePath: text("file_path").notNull(),
    fileHash: text("file_hash").notNull(),
    importedAt: text("imported_at").notNull(),
    recordCount: integer("record_count").notNull().default(0),
    byteOffset: integer("byte_offset").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    parserStateJson: text("parser_state_json"),
    status: text("status").notNull().default("new"),
    lastError: text("last_error"),
  },
  (t) => ({
    orgSourcePathUniq: uniqueIndex("timport_org_source_path_uniq").on(
      t.organizationId,
      t.source,
      t.filePath,
    ),
    orgSourceIdx: index("timport_org_source_idx").on(t.organizationId, t.source),
  }),
);

export const telemetryIngestErrors = sqliteTable(
  "telemetry_ingest_errors",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    ts: text("ts").notNull(),
    sourceKind: text("source_kind").notNull(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    rawJson: text("raw_json"),
    recordCount: integer("record_count").notNull().default(0),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgTsIdx: index("terr_org_ts_idx").on(t.organizationId, t.ts),
  }),
);

export const telemetryDashboards = sqliteTable(
  "telemetry_dashboards",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: integer("is_default").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    orgIdx: index("tdash_org_idx").on(t.organizationId),
  }),
);

export const telemetryDashboardWidgets = sqliteTable(
  "telemetry_dashboard_widgets",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => telemetryDashboards.id, {
        onDelete: "cascade",
      }),
    widgetType: text("widget_type").notNull(),
    title: text("title").notNull(),
    gridColumn: integer("grid_column").notNull(),
    gridRow: integer("grid_row").notNull(),
    colSpan: integer("col_span").notNull().default(1),
    rowSpan: integer("row_span").notNull().default(1),
    configJson: text("config_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    dashboardIdx: index("twidget_dashboard_idx").on(t.dashboardId, t.gridColumn, t.gridRow),
  }),
);

export const telemetryLiveEvents = sqliteTable(
  "telemetry_live_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: text("organization_id").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orgIdIdx: index("tlive_org_id_idx").on(t.organizationId, t.id),
  }),
);
