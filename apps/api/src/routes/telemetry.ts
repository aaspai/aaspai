import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AuthVerifier } from "@aaspai/auth";
import { MAX_OTLP_BODY_BYTES } from "@aaspai/contracts";
import { getDefaultDb } from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import {
  backfillFromControlPlane,
  defaultLiveHub,
  exportTelemetry,
  IMPORT_SOURCES,
  type ImportSource,
  importProviderFile,
  ingestOtlpRequest,
  nowIso,
  parserFor,
  publishLive,
  TelemetryRepository,
  TelemetryWatcher,
} from "@aaspai/telemetry";
import type { Context, Hono } from "hono";
import { authenticate } from "./auth.js";

const log = getLogger("api.routes.telemetry");

/** Per-organization token-bucket rate limiter for ingest (MED-1). */
const INGEST_RATE_PER_SEC = Number(process.env.AASPAI_TELEMETRY_RATE ?? 50);
const INGEST_BURST = 200;
const ingestBuckets = new Map<string, { tokens: number; last: number }>();

function rateLimitIngest(organizationId: string): boolean {
  const now = Date.now();
  const bucket = ingestBuckets.get(organizationId) ?? { tokens: INGEST_BURST, last: now };
  const elapsedSec = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(INGEST_BURST, bucket.tokens + elapsedSec * INGEST_RATE_PER_SEC);
  bucket.last = now;
  if (bucket.tokens < 1) {
    ingestBuckets.set(organizationId, bucket);
    return false;
  }
  bucket.tokens -= 1;
  ingestBuckets.set(organizationId, bucket);
  // Bound the map size to avoid unbounded memory growth.
  if (ingestBuckets.size > 10_000) {
    const oldest = Date.now();
    for (const [key, b] of ingestBuckets) {
      if (b.last < oldest - 60_000) ingestBuckets.delete(key);
    }
  }
  return true;
}

let repo: TelemetryRepository | null = null;
function repoFor(): TelemetryRepository {
  if (!repo) repo = new TelemetryRepository(getDefaultDb());
  return repo;
}

interface QueryParams {
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

function queryParams(c: Context): QueryParams {
  const q = c.req.query();
  const rawLimit = Number(q.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1_000)
    : undefined;
  const validTime = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (Number.isNaN(Date.parse(value))) return undefined;
    return new Date(value).toISOString();
  };
  return {
    organizationId: "",
    provider: q.provider?.slice(0, 128),
    serviceName: (q.serviceName ?? q.service)?.slice(0, 256),
    model: q.model?.slice(0, 256),
    sessionId: q.sessionId?.slice(0, 256),
    executionId: q.executionId?.slice(0, 256),
    attemptId: q.attemptId?.slice(0, 256),
    traceId: q.traceId?.slice(0, 256),
    severity: q.severity?.slice(0, 64),
    status: q.status?.slice(0, 64),
    eventType: (q.eventType ?? q.eventTypeName)?.slice(0, 256),
    search: q.search?.slice(0, 256),
    from: validTime(q.from),
    to: validTime(q.to),
    userId: q.userId?.slice(0, 256),
    cursor: q.cursor?.slice(0, 512),
    limit,
    sort: q.sort === "asc" ? "asc" : "desc",
  };
}

function withOrg(principal: { organizationId: string }, params: QueryParams): QueryParams {
  return { ...params, organizationId: principal.organizationId };
}

const JSON_HEADERS = { "content-type": "application/json" };

export function registerTelemetryRoutes(
  app: Hono,
  options: { authVerifier?: AuthVerifier } = {},
): void {
  const ingest = async (c: Context, kind: "logs" | "traces" | "metrics") => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    // Pre-check Content-Length before reading the body (MED-1).
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_OTLP_BODY_BYTES) {
      return c.json(
        {
          error: "payload_too_large",
          message: `request body exceeds ${MAX_OTLP_BODY_BYTES} bytes`,
        },
        413,
      );
    }
    if (!rateLimitIngest(auth.principal.organizationId)) {
      return c.json({ error: "rate_limited", message: "ingest rate limit exceeded" }, 429);
    }
    const buf = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (buf.byteLength > MAX_OTLP_BODY_BYTES) {
      return c.json(
        {
          error: "payload_too_large",
          message: `request body exceeds ${MAX_OTLP_BODY_BYTES} bytes`,
        },
        413,
      );
    }
    const report = ingestOtlpRequest(repoFor(), defaultLiveHub, {
      kind,
      organizationId: auth.principal.organizationId,
      body: new Uint8Array(buf),
      contentType: c.req.header("content-type"),
      contentEncoding: c.req.header("content-encoding"),
      receivedAt: nowIso(),
    });
    // OTLP success response; partial success is reported when records were rejected.
    return c.json(
      {
        partialSuccess: {
          rejectedLogRecords: report.rejected.logs,
          rejectedTraceSpans: report.rejected.spans,
          rejectedMetricDataPoints: report.rejected.metrics,
          errorMessage: report.errors[0],
        },
      },
      200,
      JSON_HEADERS,
    );
  };

  app.post("/v1/telemetry/logs", (c) => ingest(c, "logs"));
  app.post("/v1/telemetry/traces", (c) => ingest(c, "traces"));
  app.post("/v1/telemetry/metrics", (c) => ingest(c, "metrics"));

  app.get("/v1/telemetry/logs", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const result = repoFor().queryLogs(withOrg(auth.principal, queryParams(c)));
    return c.json({ data: result.rows, nextCursor: result.nextCursor, total: result.total });
  });

  app.get("/v1/telemetry/logs/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const row = repoFor().getLog(c.req.param("id"), auth.principal.organizationId);
    if (!row) return c.json({ error: "not_found", message: "log not found" }, 404);
    return c.json({ data: row });
  });

  app.get("/v1/telemetry/spans", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const result = repoFor().querySpans(withOrg(auth.principal, queryParams(c)));
    return c.json({ data: result.rows, nextCursor: result.nextCursor });
  });

  app.get("/v1/telemetry/traces", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const result = repoFor().queryTraces(withOrg(auth.principal, queryParams(c)));
    return c.json({ data: result.rows, nextCursor: result.nextCursor, total: result.total });
  });

  app.get("/v1/telemetry/traces/:traceId", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const spans = repoFor().getTraceSpans(c.req.param("traceId"), auth.principal.organizationId);
    if (spans.length === 0) return c.json({ error: "not_found", message: "trace not found" }, 404);
    return c.json({ data: { traceId: c.req.param("traceId"), spans } });
  });

  app.get("/v1/telemetry/metrics", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const result = repoFor().queryMetrics(withOrg(auth.principal, queryParams(c)));
    return c.json({ data: result.rows, nextCursor: result.nextCursor });
  });

  app.get("/v1/telemetry/metrics/names", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const names = repoFor().getMetricNames(auth.principal.organizationId, c.req.query("service"));
    return c.json({ data: names });
  });

  app.get("/v1/telemetry/metrics/series", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const q = c.req.query();
    const name = q.name;
    if (!name) return c.json({ error: "invalid_request", message: "name is required" }, 400);
    const series = repoFor().getMetricSeries({
      organizationId: auth.principal.organizationId,
      name,
      serviceName: q.service,
      from: q.from,
      to: q.to,
      intervalSec: q.interval ? Number(q.interval) : undefined,
      aggregate: (q.aggregate as "sum" | "avg" | "max" | "min" | "count") ?? "sum",
    });
    return c.json({ data: series });
  });

  app.get("/v1/telemetry/metrics/breakdown-values", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const q = c.req.query();
    if (!q.name || !q.attribute) {
      return c.json({ error: "invalid_request", message: "name and attribute are required" }, 400);
    }
    const values = repoFor().getBreakdownValues(
      auth.principal.organizationId,
      q.name,
      q.attribute,
      q.service,
    );
    return c.json({ data: values });
  });

  app.get("/v1/telemetry/sessions", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const result = repoFor().querySessions(withOrg(auth.principal, queryParams(c)));
    return c.json({ data: result.rows, nextCursor: result.nextCursor, total: result.total });
  });

  app.get("/v1/telemetry/sessions/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const detail = repoFor().getSessionDetail(c.req.param("id"), auth.principal.organizationId);
    if (!detail) return c.json({ error: "not_found", message: "session not found" }, 404);
    return c.json({ data: detail });
  });

  app.get("/v1/telemetry/activity", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const r = repoFor();
    const params = withOrg(auth.principal, queryParams(c));
    const sessions = r.querySessions({ ...params, limit: Math.min(params.limit ?? 20, 50) });
    const recentLogs = r.queryLogs({ ...params, limit: Math.min(params.limit ?? 20, 50) });
    return c.json({ data: { sessions: sessions.rows, recentLogs: recentLogs.rows } });
  });

  app.get("/v1/telemetry/costs", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const q = c.req.query();
    const groupBy =
      (q.groupBy as "provider" | "model" | "session" | "execution" | "user" | "day") ?? "provider";
    const rows = repoFor().aggregateCosts({
      organizationId: auth.principal.organizationId,
      provider: q.provider,
      model: q.model,
      sessionId: q.sessionId,
      executionId: q.executionId,
      attemptId: q.attemptId,
      from: q.from,
      to: q.to,
      groupBy,
    });
    return c.json({ data: rows });
  });

  app.get("/v1/telemetry/services", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({ data: repoFor().getServices(auth.principal.organizationId) });
  });

  app.get("/v1/telemetry/stats", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const q = c.req.query();
    return c.json({ data: repoFor().getStats(auth.principal.organizationId, q.from, q.to) });
  });

  app.get("/v1/telemetry/health", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const r = repoFor();
    const org = auth.principal.organizationId;
    // Honest database check: run a real query.
    let database: "ok" | "unreachable" = "ok";
    try {
      r.queryRaw("SELECT 1");
    } catch {
      database = "unreachable";
    }
    const ingestErrors = r.queryIngestErrors({ organizationId: org, limit: 1 });
    const imports = r.listImportState(org);
    return c.json({
      data: {
        database,
        ingestErrors: {
          count: ingestErrors.total ?? ingestErrors.rows.length,
          recent: ingestErrors.rows[0] ?? null,
        },
        imports: { sources: IMPORT_SOURCES, files: imports.length },
        watchers: { running: [...watchers.keys()] },
        liveSubscribers: defaultLiveHub.subscriberCount(org),
        lastSeenAt: nowIso(),
      },
    });
  });

  /* ---------------- dashboards ---------------- */

  app.get("/v1/telemetry/dashboards", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({ data: repoFor().listDashboards(auth.principal.organizationId) });
  });

  app.post("/v1/telemetry/dashboards", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      isDefault?: boolean;
    };
    if (!body.name) return c.json({ error: "invalid_request", message: "name is required" }, 400);
    const dash = repoFor().createDashboard({
      organizationId: auth.principal.organizationId,
      name: body.name,
      description: body.description,
      isDefault: body.isDefault,
    });
    return c.json({ data: dash }, 201);
  });

  app.get("/v1/telemetry/dashboards/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const dash = repoFor().getDashboard(auth.principal.organizationId, c.req.param("id"));
    if (!dash) return c.json({ error: "not_found", message: "dashboard not found" }, 404);
    return c.json({ data: dash });
  });

  app.put("/v1/telemetry/dashboards/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string | null;
      isDefault?: boolean;
    };
    const dash = repoFor().updateDashboard(auth.principal.organizationId, c.req.param("id"), body);
    if (!dash) return c.json({ error: "not_found", message: "dashboard not found" }, 404);
    return c.json({ data: dash });
  });

  app.delete("/v1/telemetry/dashboards/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const deleted = repoFor().deleteDashboard(auth.principal.organizationId, c.req.param("id"));
    if (!deleted) return c.json({ error: "not_found", message: "dashboard not found" }, 404);
    return c.json({ data: { deleted: true } });
  });

  app.post("/v1/telemetry/dashboards/:id/widgets", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      widgetType?: string;
      title?: string;
      gridColumn?: number;
      gridRow?: number;
      colSpan?: number;
      rowSpan?: number;
      config?: Record<string, unknown>;
    };
    if (
      !body.widgetType ||
      !body.title ||
      typeof body.gridColumn !== "number" ||
      typeof body.gridRow !== "number"
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "widgetType, title, gridColumn, gridRow are required",
        },
        400,
      );
    }
    const widget = repoFor().addWidget({
      organizationId: auth.principal.organizationId,
      dashboardId: c.req.param("id"),
      widgetType: body.widgetType,
      title: body.title,
      gridColumn: body.gridColumn,
      gridRow: body.gridRow,
      colSpan: body.colSpan,
      rowSpan: body.rowSpan,
      config: body.config,
    });
    if (!widget) return c.json({ error: "not_found", message: "dashboard not found" }, 404);
    return c.json({ data: widget }, 201);
  });

  app.put("/v1/telemetry/dashboards/:id/widgets/positions", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      positions?: Array<{
        id: string;
        gridColumn: number;
        gridRow: number;
        colSpan?: number;
        rowSpan?: number;
      }>;
    };
    const updated = repoFor().updateWidgetPositions(
      auth.principal.organizationId,
      c.req.param("id"),
      body.positions ?? [],
    );
    return c.json({ data: { updated } });
  });

  app.put("/v1/telemetry/dashboards/:id/widgets/:widgetId", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      config?: Record<string, unknown>;
      colSpan?: number;
      rowSpan?: number;
    };
    const updated = repoFor().updateWidget(
      auth.principal.organizationId,
      c.req.param("id"),
      c.req.param("widgetId"),
      body,
    );
    if (!updated) return c.json({ error: "not_found", message: "widget not found" }, 404);
    return c.json({ data: { updated: true } });
  });

  app.delete("/v1/telemetry/dashboards/:id/widgets/:widgetId", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const deleted = repoFor().deleteWidget(
      auth.principal.organizationId,
      c.req.param("id"),
      c.req.param("widgetId"),
    );
    if (!deleted) return c.json({ error: "not_found", message: "widget not found" }, 404);
    return c.json({ data: { deleted: true } });
  });

  /* ---------------- live stream (SSE) ---------------- */

  app.get("/v1/telemetry/stream", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const org = auth.principal.organizationId;
    const lastEventId = c.req.header("last-event-id") ?? c.req.query("lastEventId");
    const subscription = defaultLiveHub.subscribe(org, lastEventId);
    const repo = repoFor();
    // Replay baseline: persisted live events after the client's last id.
    const replayAfter = lastEventId ? Number.parseInt(lastEventId, 10) : 0;
    let sentUpToId = Number.isFinite(replayAfter) && replayAfter > 0 ? replayAfter : 0;
    const replayBuffer = repo.queryLiveEvents(org, sentUpToId);
    for (const ev of replayBuffer) {
      if (ev.id > sentUpToId) sentUpToId = ev.id;
    }
    const encoder = new TextEncoder();
    let heartbeat = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setInterval(() => {
          // 1. Replay any persisted events not yet sent (covers producers
          //    that only persist, e.g. the local bridge, and reconnect gaps).
          const missed = repo.queryLiveEvents(org, sentUpToId);
          for (const ev of missed) {
            try {
              controller.enqueue(
                encoder.encode(
                  `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`,
                ),
              );
              if (ev.id > sentUpToId) sentUpToId = ev.id;
            } catch {
              clearInterval(timer);
              defaultLiveHub.unsubscribe(subscription);
              return;
            }
          }
          // 2. Fan out in-memory hub events.
          const events = defaultLiveHub.drain(subscription);
          for (const event of events) {
            const liveId =
              typeof event.event.liveEventId === "number" ? event.event.liveEventId : 0;
            const sseId = liveId > 0 ? liveId : event.id;
            try {
              controller.enqueue(
                encoder.encode(
                  `id: ${sseId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.event)}\n\n`,
                ),
              );
              if (liveId > sentUpToId) sentUpToId = liveId;
            } catch {
              clearInterval(timer);
              defaultLiveHub.unsubscribe(subscription);
              return;
            }
          }
          if (missed.length === 0 && events.length === 0) {
            heartbeat += 1;
            try {
              controller.enqueue(encoder.encode(`: heartbeat ${heartbeat}\n\n`));
            } catch {
              clearInterval(timer);
              defaultLiveHub.unsubscribe(subscription);
            }
          }
        }, 1_000);
        // Send the replay up front.
        for (const ev of replayBuffer) {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`,
              ),
            );
          } catch {
            defaultLiveHub.unsubscribe(subscription);
            break;
          }
        }
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(timer);
          defaultLiveHub.unsubscribe(subscription);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
      cancel() {
        defaultLiveHub.unsubscribe(subscription);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  /* ---------------- imports ---------------- */

  app.post("/v1/telemetry/imports", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      filePath?: string;
      dryRun?: boolean;
      force?: boolean;
    };
    const source = body.source as ImportSource;
    if (!source || !IMPORT_SOURCES.includes(source)) {
      return c.json(
        { error: "invalid_request", message: `source must be one of ${IMPORT_SOURCES.join(", ")}` },
        400,
      );
    }
    const r = repoFor();
    const parser = parserFor(source, { organizationId: auth.principal.organizationId });
    let files: string[] = [];
    if (body.filePath) {
      files = [body.filePath];
    } else {
      files = await parser.findSessionFiles();
    }
    const summary = {
      source,
      files: files.length,
      imported: 0,
      skipped: 0,
      logs: 0,
      metrics: 0,
      spans: 0,
      errors: [] as string[],
    };
    for (const filePath of files) {
      try {
        const result = await importProviderFile(r, defaultLiveHub, parser, {
          organizationId: auth.principal.organizationId,
          source,
          filePath,
          dryRun: body.dryRun,
          force: body.force,
        });
        if (result.status === "current") {
          summary.skipped += 1;
        } else {
          summary.imported += 1;
        }
        summary.logs += result.logs;
        summary.metrics += result.metrics;
        summary.spans += result.spans;
      } catch (err) {
        summary.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json({ data: summary }, body.dryRun ? 200 : 202);
  });

  app.get("/v1/telemetry/imports", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({ data: repoFor().listImportState(auth.principal.organizationId) });
  });

  app.get("/v1/telemetry/imports/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const state = repoFor()
      .listImportState(auth.principal.organizationId, c.req.param("id"))
      .map((s) => ({
        source: s.source,
        filePath: s.filePath,
        fileHash: s.fileHash,
        importedAt: s.importedAt,
        recordCount: s.recordCount,
        byteOffset: s.byteOffset,
        messageCount: s.messageCount,
        status: s.status,
        lastError: s.lastError,
      }));
    if (state.length === 0) return c.json({ error: "not_found", message: "import not found" }, 404);
    return c.json({ data: state });
  });

  app.post("/v1/telemetry/backfill", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      dryRun?: boolean;
      from?: string;
      to?: string;
      sessionId?: string;
    };
    const result = backfillFromControlPlane(repoFor(), {
      organizationId: auth.principal.organizationId,
      dryRun: body.dryRun,
      from: body.from,
      to: body.to,
      sessionId: body.sessionId,
    });
    return c.json({ data: result }, body.dryRun ? 200 : 202);
  });

  /* ---------------- export / delete ---------------- */

  app.post("/v1/telemetry/export", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      from?: string;
      to?: string;
      includeSessions?: boolean;
      includeDashboards?: boolean;
      createZip?: boolean;
    };
    const outputDir = resolve(process.cwd(), ".aaspai", "telemetry-exports");
    try {
      const summary = await exportTelemetry(repoFor(), {
        organizationId: auth.principal.organizationId,
        outputDir,
        from: body.from,
        to: body.to,
        includeSessions: body.includeSessions,
        includeDashboards: body.includeDashboards,
        createZip: body.createZip,
      });
      return c.json({ data: summary }, 202);
    } catch (err) {
      return c.json(
        { error: "export_failed", message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.delete("/v1/telemetry/data", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as {
      scopes?: string[];
      from?: string;
      to?: string;
      confirm?: boolean;
    };
    if (body.confirm !== true) {
      return c.json(
        { error: "confirmation_required", message: "set confirm: true to delete" },
        400,
      );
    }
    const scopes = body.scopes ?? ["all"];
    const org = auth.principal.organizationId;
    const r = repoFor();
    const counts = r.deleteInRange({ organizationId: org, scopes, from: body.from, to: body.to });
    const audit = recordAudit(org, auth.principal.userId, "telemetry.delete", {
      scopes,
      from: body.from,
      to: body.to,
      counts,
    });
    publishLive(r, defaultLiveHub, org, "ingest_error", {
      auditId: audit.id,
      kind: "delete",
      counts,
    });
    return c.json({
      data: {
        organizationId: org,
        scopes,
        from: body.from,
        to: body.to,
        logsDeleted: counts.logs,
        spansDeleted: counts.spans,
        metricsDeleted: counts.metrics,
        sessionsDeleted: counts.sessions,
        auditRecorded: audit.recorded,
      },
    });
  });

  /* ---------------- watcher ---------------- */

  app.post("/v1/telemetry/watch", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as { start?: boolean; backfill?: boolean };
    if (body.start !== true) {
      return c.json(
        { error: "invalid_request", message: "set start: true to start watching" },
        400,
      );
    }
    const importId = `watch_${randomUUID()}`;
    const watcher = new TelemetryWatcher(repoFor(), defaultLiveHub, {
      organizationId: auth.principal.organizationId,
      backfill: body.backfill,
      envPaths: {
        claude: process.env.AI_OBSERVER_CLAUDE_PATH,
        codex: process.env.AI_OBSERVER_CODEX_PATH,
        gemini: process.env.AI_OBSERVER_GEMINI_PATH,
      },
    });
    await watcher.start();
    watchers.set(importId, watcher);
    return c.json({ data: { importId, health: watcher.healthSnapshot() } }, 202);
  });

  app.get("/v1/telemetry/watch/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const watcher = watchers.get(c.req.param("id"));
    if (!watcher) return c.json({ error: "not_found", message: "watcher not found" }, 404);
    return c.json({ data: watcher.healthSnapshot() });
  });

  app.delete("/v1/telemetry/watch/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const id = c.req.param("id");
    const watcher = watchers.get(id);
    if (!watcher) return c.json({ error: "not_found", message: "watcher not found" }, 404);
    await watcher.stop();
    watchers.delete(id);
    return c.json({ data: { stopped: true } });
  });
}

/** Module-level running watchers keyed by import id. */
const watchers = new Map<string, TelemetryWatcher>();

function recordAudit(
  organizationId: string,
  actorUserId: string | undefined,
  action: string,
  metadata: Record<string, unknown>,
): { id: string; recorded: boolean } {
  const id = `audit_${randomUUID()}`;
  try {
    const raw = (
      getDefaultDb() as unknown as {
        raw: { prepare(s: string): { run(...a: unknown[]): { changes: number } } };
      }
    ).raw;
    const info = raw
      .prepare(
        "INSERT INTO audit_log (id, organization_id, actor_user_id, action, target_type, target_id, metadata, ip, user_agent, created_at) VALUES (?, ?, ?, ?, 'telemetry', '', ?, NULL, NULL, ?)",
      )
      .run(id, organizationId, actorUserId ?? null, action, JSON.stringify(metadata), nowIso());
    return { id, recorded: info.changes > 0 };
  } catch (err) {
    log.warn("failed to record audit", { action, err: String(err) });
    return { id, recorded: false };
  }
}
