import { Hono } from "hono";
import { getDefaultDb } from "@aaspai/db";
import { sessions as sessionsTable, sessionEvents as sessionEventsTable, wakeups as wakeupsTable } from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const log = getLogger("api.routes.sessions");

export function registerSessionRoutes(app: Hono): void {
  /**
   * Start a new session. The request is enqueued as a wakeup; the
   * worker picks it up and runs the session asynchronously. The API
   * returns 202 with the wakeupId; poll the session endpoint to see
   * the result.
   */
  app.post("/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      agentId?: string;
      prompt?: string;
      adapter?: string;
      runtime?: { kind?: string };
      loopId?: string;
      reason?: string;
    };
    if (!body.agentId || !body.prompt) {
      return c.json(
        { error: "invalid_request", message: "agentId and prompt are required" },
        400,
      );
    }

    const sessionId = `sess_${randomUUID()}`;
    const wakeupId = `wake_${randomUUID()}`;
    const now = new Date().toISOString();
    const handle = getDefaultDb();

    // Foundation slice: enqueue a wakeup that the worker will pick up
    // and execute. Phase 3b can short-circuit if the worker is offline
    // and run inline.
    await handle.db.insert(wakeupsTable).values({
      id: wakeupId,
      organizationId: "default",
      loopId: body.loopId ?? "manual",
      source: "api",
      triggerDetail: "http",
      reason: body.reason ?? `api session start at ${now}`,
      agentId: body.agentId,
      payloadJson: JSON.stringify({
        prompt: body.prompt,
        adapter: body.adapter ?? "dry_run_local",
        runtime: body.runtime ?? { kind: "local" },
        sessionId,
        traceId: sessionId,
      }),
      status: "queued",
      idempotencyKey: `api-session:${sessionId}`,
      requestedAt: now,
    } as never);

    log.info("session queued", { sessionId, wakeupId, agentId: body.agentId });
    return c.json(
      {
        data: {
          sessionId,
          wakeupId,
          status: "queued",
          poll: `GET /v1/sessions/${sessionId}`,
        },
      },
      202,
    );
  });

  app.get("/v1/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const handle = getDefaultDb();
    const rows = await handle.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json({ error: "not_found", message: `Session ${id} not found` }, 404);
    }
    return c.json({ data: row });
  });

  app.get("/v1/sessions", async (c) => {
    const handle = getDefaultDb();
    const limitRaw = c.req.query("limit");
    const limit = Math.min(Math.max(Number(limitRaw ?? "20"), 1), 100);
    const rows = await handle.db
      .select()
      .from(sessionsTable)
      .orderBy(desc(sessionsTable.startedAt))
      .limit(limit);
    return c.json({ data: rows });
  });

  /**
   * Server-Sent Events stream of session_events. Foundation: returns
   * all events in order. Phase 4: switches to a real subscription.
   */
  app.get("/v1/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const handle = getDefaultDb();
    const events = await handle.db
      .select()
      .from(sessionEventsTable)
      .where(eq(sessionEventsTable.sessionId, id))
      .orderBy(sessionEventsTable.seq);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const e of events) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.enqueue(enc.encode("event: end\ndata: {}\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });
}
