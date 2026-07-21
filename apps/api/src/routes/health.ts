import { Hono } from "hono";
import { getDefaultDb, wakeups } from "@aaspai/db";

export function registerHealthRoutes(app: Hono): void {
  app.get("/healthz", (c) => {
    return c.json({ status: "ok", uptime: process.uptime() });
  });

  app.get("/health/live", (c) => {
    return c.json({ status: "live" });
  });

  app.get("/health/ready", async (c) => {
    try {
      const handle = getDefaultDb();
      await handle.db.select().from(wakeups).limit(1);
      return c.json({ status: "ready", backend: handle.backend });
    } catch (err) {
      return c.json({ status: "not_ready", error: (err as Error).message }, 503);
    }
  });
}
