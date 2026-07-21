import { z } from "zod";
import {
  correlationIdSchema,
  identifierSchema,
  isoTimestampSchema,
  jsonObjectSchema,
} from "./primitives";

/**
 * Version of the observability contract.
 */
export const OBSERVABILITY_PROTOCOL_VERSION = 1 as const;

const boundedIdentifierSchema = identifierSchema.max(256);

/* ------------------------------------------------------------------ */
/* Structured logging                                                  */
/* ------------------------------------------------------------------ */

export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

const boundedLogMessageSchema = z.string().trim().min(1).max(16_384);
const boundedModuleSchema = z.string().trim().min(1).max(128);

/**
 * A structured log entry in JSON-line format.
 *
 * Every log entry includes mandatory correlation context so that
 * operators can trace a request or workflow across process boundaries.
 *
 * Named `StructuredLogEntry` to distinguish from the deployment-log
 * `LogEntry` defined in the hosting contract.
 */
export const structuredLogEntrySchema = z
  .object({
    protocolVersion: z.literal(OBSERVABILITY_PROTOCOL_VERSION),
    t: isoTimestampSchema,
    level: logLevelSchema,
    msg: boundedLogMessageSchema,
    module: boundedModuleSchema.optional(),
    correlationId: correlationIdSchema.optional(),
    causationId: boundedIdentifierSchema.optional(),
    organizationId: boundedIdentifierSchema.optional(),
    actorId: boundedIdentifierSchema.optional(),
    traceId: boundedIdentifierSchema.optional(),
    spanId: boundedIdentifierSchema.optional(),
    error: boundedLogMessageSchema.optional(),
    meta: jsonObjectSchema.optional(),
  })
  .strict();
export type StructuredLogEntry = z.infer<typeof structuredLogEntrySchema>;

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export const metricKindSchema = z.enum(["counter", "gauge", "histogram"]);
export type MetricKind = z.infer<typeof metricKindSchema>;

export const metricUnitSchema = z.enum([
  "count",
  "ms",
  "seconds",
  "bytes",
  "percent",
  "ratio",
  "dollars",
]);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

const boundedMetricNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);
const boundedMetricLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u);

const boundedMetricLabelsSchema = z
  .record(boundedMetricLabelSchema, z.string().max(256))
  .refine((val) => Object.keys(val).length <= 16, {
    message: "Metric labels must not exceed 16 entries",
  });

/**
 * A single metric data point.
 */
export const metricPointSchema = z
  .object({
    name: boundedMetricNameSchema,
    kind: metricKindSchema,
    unit: metricUnitSchema,
    value: z.number(),
    labels: boundedMetricLabelsSchema.optional(),
    timestamp: isoTimestampSchema,
    organizationId: boundedIdentifierSchema.optional(),
  })
  .strict();
export type MetricPoint = z.infer<typeof metricPointSchema>;

/**
 * Pre-defined required metric names, matching the Layer 1 spec.
 * Every observability adapter must support these.
 */
export const REQUIRED_METRICS = Object.freeze([
  "job.queue_depth",
  "job.age_ms",
  "job.attempts",
  "worker.heartbeats",
  "deployment.duration_ms",
  "capability.latency_ms",
  "capability.error_rate",
  "webhook.deduplication_rate",
  "event.processing_lag_ms",
  "agent.run_duration_ms",
  "agent.cost_dollars",
  "approval.wait_duration_ms",
  "sandbox.creation_duration_ms",
  "channel.delivery_failures",
] as const);

/* ------------------------------------------------------------------ */
/* Tracing                                                             */
/* ------------------------------------------------------------------ */

const boundedSpanNameSchema = z.string().trim().min(1).max(512);
const boundedSpanIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(32)
  .regex(/^[0-9a-f]+$/iu);
const boundedTraceIdSchema = z
  .string()
  .trim()
  .min(32)
  .max(64)
  .regex(/^[0-9a-f]+$/iu);

export const spanStatusSchema = z.enum(["ok", "error", "unset"]);

const boundedSpanAttributesSchema = z
  .record(z.string(), z.unknown())
  .refine((val) => Object.keys(val).length <= 64, {
    message: "Span attributes must not exceed 64 entries",
  });

const boundedEventAttributesSchema = z
  .record(z.string(), z.unknown())
  .refine((val) => Object.keys(val).length <= 16, {
    message: "Event attributes must not exceed 16 entries",
  });

/**
 * An OpenTelemetry-compatible span.
 */
export const spanSchema = z
  .object({
    traceId: boundedTraceIdSchema,
    spanId: boundedSpanIdSchema,
    parentSpanId: boundedSpanIdSchema.optional(),
    name: boundedSpanNameSchema,
    status: spanStatusSchema,
    startTime: isoTimestampSchema,
    endTime: isoTimestampSchema.optional(),
    attributes: boundedSpanAttributesSchema.optional(),
    events: z
      .array(
        z.object({
          name: boundedSpanNameSchema,
          time: isoTimestampSchema,
          attributes: boundedEventAttributesSchema.optional(),
        }),
      )
      .max(128)
      .optional(),
  })
  .strict();
export type Span = z.infer<typeof spanSchema>;

/**
 * Correlation context propagated across process boundaries.
 */
export const correlationContextSchema = z
  .object({
    traceId: boundedTraceIdSchema,
    spanId: boundedSpanIdSchema,
    correlationId: correlationIdSchema,
    causationId: boundedIdentifierSchema.optional(),
    organizationId: boundedIdentifierSchema.optional(),
    actorId: boundedIdentifierSchema.optional(),
    workItemId: boundedIdentifierSchema.optional(),
    runId: boundedIdentifierSchema.optional(),
    systemInstanceId: boundedIdentifierSchema.optional(),
    capabilityCallId: boundedIdentifierSchema.optional(),
  })
  .strict();
export type CorrelationContext = z.infer<typeof correlationContextSchema>;

/* ------------------------------------------------------------------ */
/* Alerting                                                            */
/* ------------------------------------------------------------------ */

export const alertSeveritySchema = z.enum(["info", "warn", "critical"]);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertKindSchema = z.enum([
  "deploy_queue_full",
  "scheduler_uninitialized",
  "db_healthcheck_failed",
  "disk_low",
  "cert_expiring",
  "orphan_reaped",
  "retention_failure",
  "worker_unhealthy",
  "lease_recovery",
]);
export type AlertKind = z.infer<typeof alertKindSchema>;

/**
 * An alert event that can be dispatched through an alerter adapter.
 */
export const alertEventSchema = z
  .object({
    kind: alertKindSchema,
    severity: alertSeveritySchema,
    message: z.string().trim().min(1).max(4_096),
    meta: jsonObjectSchema.optional(),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type AlertEvent = z.infer<typeof alertEventSchema>;
