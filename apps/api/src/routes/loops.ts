import { randomUUID } from "node:crypto";
import type { AuthVerifier } from "@aaspai/auth";
import { getDefaultDb, wakeups as wakeupsTable } from "@aaspai/db";
import { DEFAULT_LOOPS_DIR, FileLoopConfigSource } from "@aaspai/file-loader";
import { getLogger } from "@aaspai/observability";
import type { Hono } from "hono";
import { authenticate } from "./auth.js";

const log = getLogger("api.routes.loops");

let loopSource: FileLoopConfigSource | null = null;

function source(): FileLoopConfigSource {
  if (!loopSource) {
    loopSource = new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? DEFAULT_LOOPS_DIR);
  }
  return loopSource;
}

export function registerLoopRoutes(app: Hono, options: { authVerifier?: AuthVerifier } = {}): void {
  app.get("/v1/loops", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const s = source();
    await s.start();
    try {
      const ids = await s.list();
      const items = await Promise.all(
        ids.map(async (id) => {
          const cfg = await s.get(id);
          return {
            id: cfg.id,
            title: cfg.title,
            status: cfg.status,
            autonomyLevel: cfg.autonomyLevel,
            schedule: cfg.schedule,
          };
        }),
      );
      return c.json({ data: items });
    } finally {
      await s.stop();
    }
  });

  app.get("/v1/loops/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const id = c.req.param("id");
    const s = source();
    await s.start();
    try {
      if (!(await s.has(id))) {
        return c.json({ error: "not_found", message: `Loop ${id} not found` }, 404);
      }
      const cfg = await s.get(id);
      return c.json({ data: cfg });
    } finally {
      await s.stop();
    }
  });

  app.post("/v1/loops/:id/fire", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const id = c.req.param("id");
    const s = source();
    await s.start();
    try {
      if (!(await s.has(id))) {
        return c.json({ error: "not_found", message: `Loop ${id} not found` }, 404);
      }
      const loop = await s.get(id);
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string; agentId?: string };
      const wakeupId = `wake_${randomUUID()}`;
      const handle = getDefaultDb();
      await handle.db.insert(wakeupsTable).values({
        id: wakeupId,
        organizationId: auth.principal.organizationId,
        loopId: loop.id,
        source: "api",
        triggerDetail: "http",
        reason: body.reason ?? `fired via API at ${new Date().toISOString()}`,
        agentId: body.agentId ?? loop.agent,
        payloadJson: JSON.stringify({ firedAt: new Date().toISOString() }),
        status: "queued",
        idempotencyKey: `api:${loop.id}:${Date.now()}:${randomUUID().slice(0, 8)}`,
        requestedAt: new Date().toISOString(),
      } as never);
      log.info("loop fired via api", { loopId: loop.id, wakeupId });
      return c.json({ data: { wakeupId, loopId: loop.id, status: "queued" } }, 202);
    } finally {
      await s.stop();
    }
  });

  app.post("/v1/loops/:id/trigger", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const id = c.req.param("id");
    const s = source();
    await s.start();
    try {
      if (!(await s.has(id))) {
        return c.json({ error: "not_found", message: `Loop ${id} not found` }, 404);
      }
      const loop = await s.get(id);
      if (loop.schedule.kind !== "event" && loop.schedule.kind !== "webhook") {
        return c.json(
          { error: "invalid_trigger", message: `Loop ${id} is not event-triggered` },
          409,
        );
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const idempotencyKey =
        c.req.header("idempotency-key") ??
        (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
      if (!idempotencyKey) {
        return c.json({ error: "invalid_request", message: "Idempotency-Key is required" }, 400);
      }
      const wakeupId = `wake_${randomUUID()}`;
      try {
        await getDefaultDb()
          .db.insert(wakeupsTable)
          .values({
            id: wakeupId,
            organizationId: auth.principal.organizationId,
            loopId: loop.id,
            source: "api",
            triggerDetail:
              loop.schedule.kind === "event"
                ? (loop.schedule.topic ?? "event")
                : (loop.schedule.path ?? "webhook"),
            reason: `external ${loop.schedule.kind} trigger`,
            agentId: loop.agent,
            payloadJson: JSON.stringify(body.payload ?? body),
            status: "queued",
            idempotencyKey: `trigger:${auth.principal.organizationId}:${loop.id}:${idempotencyKey}`,
            requestedAt: new Date().toISOString(),
          } as never);
      } catch (error) {
        if (/unique constraint failed/i.test(String(error))) {
          return c.json({ data: { loopId: loop.id, status: "duplicate" } }, 200);
        }
        throw error;
      }
      return c.json({ data: { wakeupId, loopId: loop.id, status: "queued" } }, 202);
    } finally {
      await s.stop();
    }
  });
}
