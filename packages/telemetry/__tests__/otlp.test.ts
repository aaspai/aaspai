import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ingestOtlpRequest } from "../src/ingest.js";
import { decodeOtlp, detectOtlpFormat, OtlpError, severityNumberToText } from "../src/otlp.js";
import { createTelemetryTestContext, TEST_ORGANIZATION } from "../src/test-utils.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
});

const LOGS_JSON = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "claude-code" } },
          { key: "session.id", value: { stringValue: "sess_otlp1" } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: "claude", version: "1.0" },
          logRecords: [
            {
              timeUnixNano: "1750000000000000000",
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "otlp log one" },
              attributes: [
                { key: "event.name", value: { stringValue: "user_prompt" } },
                { key: "model", value: { stringValue: "claude-sonnet-4-5" } },
              ],
            },
            {
              timeUnixNano: "1750000001000000000",
              severityNumber: 17,
              body: { stringValue: "otlp log two" },
            },
          ],
        },
      ],
    },
  ],
};

describe("OTLP format detection", () => {
  it("detects JSON and protobuf by first byte", () => {
    expect(detectOtlpFormat(new TextEncoder().encode(JSON.stringify(LOGS_JSON)))).toBe("json");
    expect(detectOtlpFormat(new TextEncoder().encode('  {"a":1}'))).toBe("json");
    expect(detectOtlpFormat(new Uint8Array([0x0a, 0x03, 0x01, 0x02, 0x03]))).toBe("protobuf");
    expect(detectOtlpFormat(new Uint8Array([0x12, 0x05]))).toBe("protobuf");
  });
});

describe("OTLP log decode", () => {
  it("decodes JSON logs with resource/scope into canonical inserts", () => {
    const result = decodeOtlp({
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(LOGS_JSON)),
    });
    expect(result.logs).toHaveLength(2);
    expect(result.accepted.logs).toBe(2);
    const first = result.logs[0]!;
    expect(first.provider).toBe("claude-code");
    expect(first.sessionId).toBe("sess_otlp1");
    expect(first.model).toBe("claude-sonnet-4-5");
    expect(first.observedAt).toMatch(/^2025-06/);
    expect(first.severityText).toBe("INFO");
    const second = result.logs[1]!;
    expect(second.severityText).toBe("ERROR");
  });

  it("decodes protobuf-encoded logs", async () => {
    // Round-trip the JSON through the protobuf encoder to build a wire payload.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const root = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");
    const LogsType = root.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
    const message = LogsType.fromObject(LOGS_JSON);
    const bytes = LogsType.encode(message).finish();
    const result = decodeOtlp({
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: Uint8Array.from(bytes),
    });
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]?.body).toBe("otlp log one");
  });

  it("handles gzip JSON", () => {
    const body = gzipSync(Buffer.from(JSON.stringify(LOGS_JSON)));
    const result = decodeOtlp({
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: new Uint8Array(body),
      contentEncoding: "gzip",
    });
    expect(result.logs).toHaveLength(2);
  });

  it("rejects malformed JSON", () => {
    expect(() =>
      decodeOtlp({
        kind: "logs",
        organizationId: TEST_ORGANIZATION,
        body: new TextEncoder().encode("{not json"),
      }),
    ).toThrow(OtlpError);
  });

  it("rejects invalid gzip", () => {
    expect(() =>
      decodeOtlp({
        kind: "logs",
        organizationId: TEST_ORGANIZATION,
        body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        contentEncoding: "gzip",
      }),
    ).toThrow(OtlpError);
  });

  it("tolerates unknown fields", () => {
    const payload = {
      resourceLogs: [{ unexpectedField: true, scopeLogs: LOGS_JSON.resourceLogs[0]!.scopeLogs }],
    };
    const result = decodeOtlp({
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
    expect(result.logs.length).toBeGreaterThan(0);
  });
});

describe("OTLP trace and metric decode", () => {
  it("decodes nested + orphan spans", () => {
    const tracesJson = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "codex_cli_rs" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString(
                    "base64",
                  ),
                  spanId: Buffer.from("0000000000000001", "hex").toString("base64"),
                  name: "root",
                  kind: 2,
                  startTimeUnixNano: "1750000000000000000",
                  endTimeUnixNano: "1750000001000000000",
                  status: { code: 1 },
                  attributes: [{ key: "model", value: { stringValue: "gpt-5" } }],
                },
                {
                  traceId: Buffer.from("0123456789abcdef0123456789abcdef", "hex").toString(
                    "base64",
                  ),
                  spanId: Buffer.from("0000000000000002", "hex").toString("base64"),
                  parentSpanId: Buffer.from("0000000000000001", "hex").toString("base64"),
                  name: "child",
                  startTimeUnixNano: "1750000000500000000",
                  status: { code: 2, message: "boom" },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = decodeOtlp({
      kind: "traces",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(tracesJson)),
    });
    expect(result.spans).toHaveLength(2);
    const child = result.spans.find((s) => s.spanId === "0000000000000002");
    expect(child?.parentSpanId).toBe("0000000000000001");
    expect(child?.status).toBe("error");
    expect(child?.statusMessage).toBe("boom");
    expect(child?.durationNs).toBeNull();
    const root = result.spans.find((s) => s.spanId === "0000000000000001");
    expect(root?.durationNs).toBe(1_000_000_000);
  });

  it("decodes gauge, sum, and histogram metrics", () => {
    const metricsJson = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "gemini_cli" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "gemini_cli.token.usage",
                  sum: {
                    isMonotonic: true,
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        timeUnixNano: "1750000000000000000",
                        asInt: "1500",
                        attributes: [{ key: "type", value: { stringValue: "input" } }],
                      },
                    ],
                  },
                },
                {
                  name: "latency",
                  gauge: { dataPoints: [{ timeUnixNano: "1750000000000000000", asDouble: 12.5 }] },
                },
                {
                  name: "histo",
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        timeUnixNano: "1750000000000000000",
                        count: 5,
                        sum: 40,
                        bucketCounts: [1, 2, 2],
                        explicitBounds: [1, 5],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = decodeOtlp({
      kind: "metrics",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(metricsJson)),
    });
    expect(result.metrics).toHaveLength(3);
    const token = result.metrics.find((m) => m.name === "gemini_cli.token.usage");
    expect(token?.value).toBe(1500);
    expect(token?.isMonotonic).toBe(true);
    const gauge = result.metrics.find((m) => m.name === "latency");
    expect(gauge?.metricType).toBe("gauge");
    expect(gauge?.value).toBe(12.5);
    const histo = result.metrics.find((m) => m.name === "histo");
    expect(histo?.metricType).toBe("histogram");
    expect(histo?.count).toBe(5);
    expect(histo?.bucketCounts).toEqual([1, 2, 2]);
    expect(histo?.explicitBounds).toEqual([1, 5]);
  });
});

describe("OTLP ingest end-to-end", () => {
  it("persists, redacts, and reports counts", async () => {
    const { repo, hub } = await setup();
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1750000000000000000",
                  body: { stringValue: "hi" },
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
    const report = ingestOtlpRequest(repo, hub, {
      kind: "logs",
      organizationId: TEST_ORGANIZATION,
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });
    expect(report.accepted.logs).toBe(1);
    expect(report.errors).toHaveLength(0);
    const rows = repo.queryLogs({ organizationId: TEST_ORGANIZATION });
    expect(rows.total).toBe(1);
    // Authorization key redacted
    const attrs = rows.rows[0]?.attributesJson as Record<string, unknown>;
    expect(attrs?.Authorization).toBe("[REDACTED]");
  });
});

describe("severity mapping", () => {
  it("derives severity text from number when missing", () => {
    expect(severityNumberToText(9)).toBe("INFO");
    expect(severityNumberToText(17)).toBe("ERROR");
    expect(severityNumberToText(21)).toBe("FATAL");
    expect(severityNumberToText(1)).toBe("TRACE");
  });
});
