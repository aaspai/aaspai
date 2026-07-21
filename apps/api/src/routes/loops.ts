import { Hono } from "hono";
import { getDefaultDb } from "@aaspai/db";
import { wakeups as wakeupsTable } from "@aaspai/db";
import { FileLoopConfigSource } from "@aaspai/file-loader";
import { getLogger } from "@aaspai/observability";
import { randomUUID } from "node:crypto";

const log = getLogger("api.routes.loops");

let loopSource: FileLoopConfigSource | null = null;

function source(): FileLoopConfigSource {
  if (!loopSource) {
    loopSource = new FileLoopConfigSource(process.env.AASPAI_LOOPS_DIR ?? "./loops");
  }
  return loopSource;
}

export function registerLoopRoutes(app: Hono): void {
  app.get("/v1/loops", async (c) => {
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
        organizationId: "default",
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
      return c.json(
        { data: { wakeupId, loopId: loop.id, status: "queued" } },
        202,
      );
    } finally {
      await s.stop();
    }
  });
}
