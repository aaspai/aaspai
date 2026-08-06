import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import {
  anyValueToJson,
  nanosToIso,
  newEventId,
  nowIso,
  providerFromServiceName,
  toIso,
} from "./canonical.js";
import { enforceBodyLimit } from "./redact.js";
import type { LogInsert, MetricInsert, SpanInsert } from "./repository.js";

/**
 * OTLP ingestion (logs, traces, metrics) in JSON and protobuf form,
 * with gzip support. Logic adapted from the AI Observer reference
 * handlers and decoders (MIT licensed).
 *
 * Both wire formats are decoded through the OpenTelemetry protobuf
 * message definitions into one plain-object shape, then converted to
 * the canonical Aaspai insert model. Unknown fields are ignored and
 * partial records are reported instead of aborting the whole request.
 */

const require = createRequire(import.meta.url);
// Deep import of the generated OTLP protobuf root (CJS module).
// `@opentelemetry/otlp-transformer` is a direct dependency so this path
// is pinned by the lockfile.
const otlpRoot = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");

export type OtlpKind = "logs" | "traces" | "metrics";

export interface OtlpDecodeResult {
  kind: OtlpKind;
  logs: LogInsert[];
  spans: SpanInsert[];
  metrics: MetricInsert[];
  /** Counts accepted per record for partial-acceptance reporting. */
  accepted: { logs: number; spans: number; metrics: number };
}

export interface OtlpRequest {
  kind: OtlpKind;
  organizationId: string;
  body: Uint8Array;
  contentType?: string | null;
  contentEncoding?: string | null;
  receivedAt?: string;
}

export type OtlpFormat = "json" | "protobuf";

/** Replicates the reference format detector (first non-whitespace byte). */
export function detectOtlpFormat(body: Uint8Array): OtlpFormat {
  let i = 0;
  // Skip UTF-8 BOM
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) i = 3;
  // Skip ASCII whitespace
  while (
    i < body.length &&
    (body[i] === 0x20 || body[i] === 0x09 || body[i] === 0x0a || body[i] === 0x0d)
  ) {
    i += 1;
  }
  if (i >= body.length) return "protobuf";
  const first = body[i] ?? 0;
  if (first === 0x7b || first === 0x5b) return "json";
  return "protobuf";
}

export function decompressBody(body: Uint8Array, contentEncoding?: string | null): Uint8Array {
  if (!contentEncoding) return body;
  const encoding = contentEncoding.trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    return gunzipSync(body);
  }
  if (encoding === "identity") return body;
  throw new OtlpError(
    "unsupported_content_encoding",
    `unsupported Content-Encoding: ${contentEncoding}`,
  );
}

export class OtlpError extends Error {
  override readonly name = "OtlpError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Decode an OTLP request body into canonical inserts. */
export function decodeOtlp(request: OtlpRequest): OtlpDecodeResult {
  enforceBodyLimit(request.body.byteLength);
  let body: Uint8Array;
  try {
    body = decompressBody(request.body, request.contentEncoding);
  } catch (err) {
    if (err instanceof OtlpError) throw err;
    throw new OtlpError("invalid_gzip", "invalid gzip payload");
  }
  enforceBodyLimit(body.byteLength);

  const format = detectOtlpFormat(body);
  let message: unknown;
  try {
    if (format === "json") {
      const text = new TextDecoder().decode(body);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new OtlpError("invalid_json", "malformed JSON payload");
      }
      message = lookup(request.kind).fromObject(parsed);
    } else {
      message = lookup(request.kind).decode(body);
    }
  } catch (err) {
    if (err instanceof OtlpError) throw err;
    throw new OtlpError(
      format === "json" ? "invalid_json" : "invalid_protobuf",
      `malformed ${format} payload: ${(err as Error).message}`,
    );
  }

  const plain = lookup(request.kind).toObject(message, {
    arrays: true,
    objects: true,
    longs: String,
    bytes: String,
  });

  switch (request.kind) {
    case "logs":
      return convertLogs(plain, request.organizationId, request.receivedAt);
    case "traces":
      return convertTraces(plain, request.organizationId, request.receivedAt);
    case "metrics":
      return convertMetrics(plain, request.organizationId, request.receivedAt);
  }
}

function lookup(kind: OtlpKind) {
  switch (kind) {
    case "logs":
      return otlpRoot.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
    case "traces":
      return otlpRoot.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    case "metrics":
      return otlpRoot.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
  }
}

/* ------------------------------------------------------------------ */
/* Attribute helpers                                                   */
/* ------------------------------------------------------------------ */

interface AttrObj {
  key?: string;
  value?: unknown;
}

function attrsToMap(attrs: AttrObj[] | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) {
    if (!a?.key) continue;
    out[a.key] = anyValueToJson(a.value);
  }
  return out;
}

function getServiceName(resourceAttrs: Record<string, unknown> | null | undefined): string | null {
  const service = resourceAttrs?.["service.name"];
  return typeof service === "string" && service.trim() ? service : null;
}

/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */

export function convertLogs(
  payload: { resourceLogs?: Array<Record<string, unknown>> },
  organizationId: string,
  receivedAt?: string,
): OtlpDecodeResult {
  const logs: LogInsert[] = [];
  const received = receivedAt ?? nowIso();

  for (const resourceLog of payload.resourceLogs ?? []) {
    const resourceAttrs = attrsToMap(
      (resourceLog.resource as { attributes?: AttrObj[] } | undefined)?.attributes,
    );
    const serviceName = getServiceName(resourceAttrs);
    const provider = providerFromServiceName(serviceName);
    for (const scopeLog of (resourceLog.scopeLogs as Array<Record<string, unknown>> | undefined) ??
      []) {
      const scope = scopeLog.scope as
        | { name?: string; version?: string; attributes?: AttrObj[] }
        | undefined;
      const scopeName = scope?.name;
      const scopeVersion = scope?.version;
      for (const record of (scopeLog.logRecords as Array<Record<string, unknown>> | undefined) ??
        []) {
        const eventName = pick(attrsToMap(record.attributes as AttrObj[] | undefined), [
          "event.name",
          "gen_ai.event.name",
        ]);
        // Codex SSE noise filter (reference behavior): skip storing the raw log.
        if (provider === "codex_cli_rs" && eventName === "codex.sse_event") {
          continue;
        }
        const attributes = attrsToMap(record.attributes as AttrObj[] | undefined);
        const ts = resolveLogTimestamp(record, attributes);
        const severityNumber =
          typeof record.severityNumber === "number" ? record.severityNumber : null;
        const severityText =
          typeof record.severityText === "string" && record.severityText
            ? record.severityText
            : severityNumberToText(severityNumber);
        const body = anyValueToString(record.body);
        const traceId = base64ToHexString(record.traceId);
        const spanId = base64ToHexString(record.spanId);
        const sessionId =
          pick(attributes, ["session.id", "conversation.id", "gen_ai.conversation.id"]) ??
          pick(resourceAttrs, ["session.id", "conversation.id", "gen_ai.conversation.id"]);
        const model =
          pick(attributes, [
            "model",
            "gen_ai.response.model",
            "gen_ai.request.model",
            "llm.model_name",
          ]) ?? pick(resourceAttrs, ["model", "gen_ai.response.model", "gen_ai.request.model"]);
        const dedupKey = [
          "log",
          organizationId,
          provider,
          traceId ?? "",
          spanId ?? "",
          record.timeUnixNano ?? record.observedTimeUnixNano ?? ts ?? "",
          stableHashOf(stableStringify(attributes)),
        ].join(":");

        logs.push({
          id: newEventId("tlog"),
          organizationId,
          observedAt: ts ?? received,
          receivedAt: received,
          provider,
          sourceKind: "otlp",
          serviceName,
          eventName: eventName ?? undefined,
          body: typeof body === "string" ? body.slice(0, 16_384) : String(body).slice(0, 16_384),
          severityText: severityText ?? undefined,
          severityNumber: severityNumber ?? undefined,
          sessionId: sessionId ?? undefined,
          traceId: traceId ?? undefined,
          spanId: spanId ?? undefined,
          model: model ?? undefined,
          operation: eventName ?? undefined,
          attributes,
          resourceAttributes: resourceAttrs,
          scopeName,
          scopeVersion,
          raw: record,
          rawAvailable: true,
          dedupKey,
          parseStatus: "ok",
        });
      }
    }
  }

  return {
    kind: "logs",
    logs,
    spans: [],
    metrics: [],
    accepted: { logs: logs.length, spans: 0, metrics: 0 },
  };
}

function resolveLogTimestamp(
  record: Record<string, unknown>,
  attributes: Record<string, unknown>,
): string | null {
  const fromNanos = nanosToIso(record.timeUnixNano as string | number | undefined);
  if (fromNanos) return fromNanos;
  // Fallback: event.timestamp attribute (RFC3339) then observed time.
  const eventTs = attributes["event.timestamp"];
  if (typeof eventTs === "string") {
    const iso = toIso(eventTs);
    if (iso) return iso;
  }
  return nanosToIso(record.observedTimeUnixNano as string | number | undefined);
}

export function severityNumberToText(severityNumber: number | null | undefined): string | null {
  if (severityNumber === null || severityNumber === undefined) return null;
  if (severityNumber >= 21) return "FATAL";
  if (severityNumber >= 17) return "ERROR";
  if (severityNumber >= 13) return "WARN";
  if (severityNumber >= 9) return "INFO";
  if (severityNumber >= 5) return "DEBUG";
  if (severityNumber >= 1) return "TRACE";
  return null;
}

/** Convert an OTLP AnyValue to a string body. */
export function anyValueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("stringValue" in obj) return String(obj.stringValue ?? "");
    if ("bytesValue" in obj) return String(obj.bytesValue ?? "");
    if ("kvlistValue" in obj) return JSON.stringify(anyValueToJson(value));
    if ("arrayValue" in obj) return JSON.stringify(anyValueToJson(value));
    if ("intValue" in obj) return String(obj.intValue ?? "");
    if ("doubleValue" in obj) return String(obj.doubleValue ?? "");
    if ("boolValue" in obj) return String(obj.boolValue ?? "");
  }
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------ */
/* Traces                                                              */
/* ------------------------------------------------------------------ */

export function convertTraces(
  payload: { resourceSpans?: Array<Record<string, unknown>> },
  organizationId: string,
  receivedAt?: string,
): OtlpDecodeResult {
  const spans: SpanInsert[] = [];
  const received = receivedAt ?? nowIso();

  for (const resourceSpan of payload.resourceSpans ?? []) {
    const resourceAttrs = attrsToMap(
      (resourceSpan.resource as { attributes?: AttrObj[] } | undefined)?.attributes,
    );
    const serviceName = getServiceName(resourceAttrs);
    const provider = providerFromServiceName(serviceName);
    for (const scopeSpan of (resourceSpan.scopeSpans as
      | Array<Record<string, unknown>>
      | undefined) ?? []) {
      const scope = scopeSpan.scope as
        | { name?: string; version?: string; attributes?: AttrObj[] }
        | undefined;
      for (const span of (scopeSpan.spans as Array<Record<string, unknown>> | undefined) ?? []) {
        const traceId = base64ToHexString(span.traceId) ?? "";
        const spanId = base64ToHexString(span.spanId) ?? "";
        if (!traceId || !spanId) continue;
        const startNanos = span.startTimeUnixNano as string | number | undefined;
        const endNanos = span.endTimeUnixNano as string | number | undefined;
        const startTime = nanosToIso(startNanos) ?? received;
        const endTime = nanosToIso(endNanos);
        const durationNs =
          startNanos && endNanos ? Number(BigInt(endNanos) - BigInt(startNanos)) : null;
        const attributes = attrsToMap(span.attributes as AttrObj[] | undefined);
        const statusObj = span.status as { code?: number; message?: string } | undefined;
        const statusCode = statusObj?.code ?? 0;
        const status = statusCode === 2 ? "error" : statusCode === 1 ? "ok" : "unset";
        const sessionId = pick(attributes, [
          "session.id",
          "conversation.id",
          "gen_ai.conversation.id",
        ]);
        const model = pick(attributes, ["model", "gen_ai.response.model", "gen_ai.request.model"]);

        spans.push({
          id: newEventId("tsp"),
          organizationId,
          observedAt: startTime,
          receivedAt: received,
          provider,
          sourceKind: "otlp",
          serviceName,
          traceId,
          spanId,
          parentSpanId: base64ToHexString(span.parentSpanId) ?? undefined,
          name: String(span.name ?? "span"),
          kind: spanKindToText(typeof span.kind === "number" ? span.kind : undefined),
          status: status as "ok" | "error" | "unset",
          statusMessage: statusObj?.message ?? undefined,
          startTime,
          endTime: endTime ?? undefined,
          durationNs,
          sessionId: sessionId ?? undefined,
          model: model ?? undefined,
          operation: String(span.name ?? "") || undefined,
          attributes,
          resourceAttributes: resourceAttrs,
          scopeName: scope?.name,
          scopeVersion: scope?.version,
          events: (span.events as Array<Record<string, unknown>> | undefined)?.map((e) => ({
            name: e.name,
            time: nanosToIso(e.timeUnixNano as string | number | undefined),
            attributes: attrsToMap(e.attributes as AttrObj[] | undefined),
          })),
          links: (span.links as Array<Record<string, unknown>> | undefined)?.map((l) => ({
            traceId: base64ToHexString(l.traceId),
            spanId: base64ToHexString(l.spanId),
            attributes: attrsToMap(l.attributes as AttrObj[] | undefined),
          })),
          raw: span,
          rawAvailable: true,
        });
      }
    }
  }

  return {
    kind: "traces",
    logs: [],
    spans,
    metrics: [],
    accepted: { logs: 0, spans: spans.length, metrics: 0 },
  };
}

function spanKindToText(kind: number | null | undefined): string | undefined {
  switch (kind) {
    case 1:
      return "internal";
    case 2:
      return "server";
    case 3:
      return "client";
    case 4:
      return "producer";
    case 5:
      return "consumer";
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export function convertMetrics(
  payload: { resourceMetrics?: Array<Record<string, unknown>> },
  organizationId: string,
  receivedAt?: string,
): OtlpDecodeResult {
  const metrics: MetricInsert[] = [];
  const received = receivedAt ?? nowIso();

  for (const resourceMetric of payload.resourceMetrics ?? []) {
    const resourceAttrs = attrsToMap(
      (resourceMetric.resource as { attributes?: AttrObj[] } | undefined)?.attributes,
    );
    const serviceName = getServiceName(resourceAttrs);
    const provider = providerFromServiceName(serviceName);
    for (const scopeMetric of (resourceMetric.scopeMetrics as
      | Array<Record<string, unknown>>
      | undefined) ?? []) {
      const scope = scopeMetric.scope as { name?: string; version?: string } | undefined;
      for (const metric of (scopeMetric.metrics as Array<Record<string, unknown>> | undefined) ??
        []) {
        const name = String(metric.name ?? "");
        if (!name) continue;
        const description = typeof metric.description === "string" ? metric.description : undefined;
        const unit = typeof metric.unit === "string" ? metric.unit : undefined;
        for (const point of metricPoints(metric)) {
          metrics.push({
            id: newEventId("tmet"),
            organizationId,
            observedAt: point.observedAt,
            startTime: point.startTime,
            receivedAt: received,
            provider,
            sourceKind: "otlp",
            serviceName,
            name,
            description,
            unit,
            metricType: point.metricType,
            sessionId: undefined,
            model:
              pick(point.attributes, ["model", "gen_ai.response.model", "gen_ai.request.model"]) ??
              undefined,
            aggregationTemporality: point.aggregationTemporality,
            isMonotonic: point.isMonotonic,
            value: point.value,
            count: point.count,
            sum: point.sum,
            min: point.min,
            max: point.max,
            bucketCounts: point.bucketCounts,
            explicitBounds: point.explicitBounds,
            scale: point.scale,
            zeroCount: point.zeroCount,
            positiveOffset: point.positiveOffset,
            positiveBucketCounts: point.positiveBucketCounts,
            negativeOffset: point.negativeOffset,
            negativeBucketCounts: point.negativeBucketCounts,
            quantileValues: point.quantileValues,
            quantileQuantiles: point.quantileQuantiles,
            attributes: point.attributes,
            resourceAttributes: resourceAttrs,
            scopeName: scope?.name,
            scopeVersion: scope?.version,
            raw: point.raw,
            rawAvailable: true,
          });
        }
      }
    }
  }

  return {
    kind: "metrics",
    logs: [],
    spans: [],
    metrics,
    accepted: { logs: 0, spans: 0, metrics: metrics.length },
  };
}

interface ConvertedPoint {
  observedAt: string;
  startTime?: string;
  metricType: MetricInsert["metricType"];
  attributes: Record<string, unknown>;
  aggregationTemporality?: number;
  isMonotonic?: boolean;
  value?: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
  scale?: number;
  zeroCount?: number;
  positiveOffset?: number;
  positiveBucketCounts?: number[];
  negativeOffset?: number;
  negativeBucketCounts?: number[];
  quantileValues?: number[];
  quantileQuantiles?: number[];
  raw?: unknown;
}

function metricPoints(metric: Record<string, unknown>): ConvertedPoint[] {
  const out: ConvertedPoint[] = [];
  const gauge = metric.gauge as { dataPoints?: Array<Record<string, unknown>> } | undefined;
  if (gauge?.dataPoints) {
    for (const dp of gauge.dataPoints) {
      out.push(basePoint(dp, "gauge", numberValue(dp)));
    }
    return out;
  }
  const sum = metric.sum as
    | {
        dataPoints?: Array<Record<string, unknown>>;
        aggregationTemporality?: number;
        isMonotonic?: boolean;
      }
    | undefined;
  if (sum?.dataPoints) {
    for (const dp of sum.dataPoints) {
      out.push({
        ...basePoint(dp, "sum", numberValue(dp)),
        aggregationTemporality: sum.aggregationTemporality,
        isMonotonic: sum.isMonotonic,
      });
    }
    return out;
  }
  const histogram = metric.histogram as
    | { dataPoints?: Array<Record<string, unknown>>; aggregationTemporality?: number }
    | undefined;
  if (histogram?.dataPoints) {
    for (const dp of histogram.dataPoints) {
      out.push({
        ...basePoint(dp, "histogram", undefined),
        aggregationTemporality: histogram.aggregationTemporality,
        count: num(dp.count),
        sum: num(dp.sum),
        min: num(dp.min),
        max: num(dp.max),
        bucketCounts: numArray(dp.bucketCounts),
        explicitBounds: numArray(dp.explicitBounds),
      });
    }
    return out;
  }
  const exp = metric.exponentialHistogram as
    | { dataPoints?: Array<Record<string, unknown>>; aggregationTemporality?: number }
    | undefined;
  if (exp?.dataPoints) {
    for (const dp of exp.dataPoints) {
      const positive = dp.positive as { offset?: number; bucketCounts?: unknown } | undefined;
      const negative = dp.negative as { offset?: number; bucketCounts?: unknown } | undefined;
      out.push({
        ...basePoint(dp, "exponential_histogram", undefined),
        aggregationTemporality: exp.aggregationTemporality,
        scale: num(dp.scale),
        zeroCount: num(dp.zeroCount),
        positiveOffset: positive?.offset,
        positiveBucketCounts: numArray(positive?.bucketCounts),
        negativeOffset: negative?.offset,
        negativeBucketCounts: numArray(negative?.bucketCounts),
      });
    }
    return out;
  }
  const summary = metric.summary as { dataPoints?: Array<Record<string, unknown>> } | undefined;
  if (summary?.dataPoints) {
    for (const dp of summary.dataPoints) {
      const quantiles = (dp.quantileValues as Array<Record<string, unknown>> | undefined) ?? [];
      out.push({
        ...basePoint(dp, "summary", undefined),
        count: num(dp.count),
        sum: num(dp.sum),
        quantileQuantiles: quantiles
          .map((q) => num(q.quantile))
          .filter((v): v is number => v !== null && v !== undefined),
        quantileValues: quantiles
          .map((q) => num(q.value))
          .filter((v): v is number => v !== null && v !== undefined),
      });
    }
  }
  return out;
}

function basePoint(
  dp: Record<string, unknown>,
  metricType: MetricInsert["metricType"],
  value: number | undefined,
): ConvertedPoint {
  return {
    observedAt: nanosToIso(dp.timeUnixNano as string | number | undefined) ?? nowIso(),
    startTime: nanosToIso(dp.startTimeUnixNano as string | number | undefined) ?? undefined,
    metricType,
    attributes: attrsToMap(dp.attributes as AttrObj[] | undefined),
    value,
    raw: dp,
  };
}

function numberValue(dp: Record<string, unknown>): number | undefined {
  if (typeof dp.asDouble === "number") return dp.asDouble;
  if (typeof dp.asInt === "number") return dp.asInt;
  if (typeof dp.asDouble === "string") {
    const n = Number(dp.asDouble);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof dp.asInt === "string") {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function numArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => Number(v));
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function pick(attributes: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = attributes[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** OTLP bytes fields are base64 in protojson/protobufjs toObject. */
function base64ToHexString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("hex");
  }
  if (typeof value !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return Buffer.from(bytes).toString("hex");
}

function stableHashOf(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** JSON stringify with sorted object keys so attribute order never changes a hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

import { createHash } from "node:crypto";

export { randomUUID };
