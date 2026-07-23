/**
 * aaspai-api — the HTTP control plane.
 *
 * Surface (foundation slice, minimal):
 *   GET  /healthz                    — liveness + readiness
 *   GET  /v1/loops                   — list registered loops
 *   POST /v1/loops/:id/fire          — enqueue a wakeup (returns 202)
 *   POST /v1/sessions                — start a session (returns 202 with sessionId)
 *   GET  /v1/sessions/:id            — read a session record
 *   GET  /v1/sessions/:id/events     — SSE stream of session events
 *
 * What's NOT here (deferred):
 *   - Better Auth composition (the verifier is injected by the composition root)
 *   - Webhooks
 *   - MCP / OpenAPI
 *   - Auth on legacy loop/session routes
 *
 * Architecture: the api does NOT execute sessions. It enqueues a
 * wakeup row in the DB. The worker picks it up and runs the session
 * via @aaspai/sessions. This is the same write pattern the CLI uses
 * today — the api is just a different entry point.
 */

import type { AuthVerifier } from "@aaspai/auth";
import {
  closeDefaultDb,
  getDefaultDb,
  sessions as sessionsTable,
  wakeups as wakeupsTable,
} from "@aaspai/db";
import { getLogger } from "@aaspai/observability";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLoopRoutes } from "./routes/loops.js";
import { registerSessionRoutes } from "./routes/sessions.js";

const log = getLogger("api.server");

export interface ApiOptions {
  host?: string;
  port?: number;
  /** Auth verifier supplied by the composition root. Execution routes fail closed when absent. */
  authVerifier?: AuthVerifier;
}

export function createApiApp(options: Pick<ApiOptions, "authVerifier"> = {}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    const ms = Date.now() - t0;
    log.info("request", { method: c.req.method, path: c.req.path, status: c.res.status, ms });
  });
  app.onError((err, c) => {
    log.error("unhandled error", { err: String(err), path: c.req.path });
    return c.json({ error: "internal_error", message: (err as Error).message }, 500);
  });
  registerHealthRoutes(app);
  registerLoopRoutes(app);
  registerSessionRoutes(app);
  registerExecutionRoutes(app, { authVerifier: options.authVerifier });
  return app;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(opts: ApiOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? process.env.AASPAI_API_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.AASPAI_API_PORT ?? 7420);
  const app = createApiApp({ authVerifier: opts.authVerifier });
  const server = serve({ fetch: app.fetch, hostname: host, port }) as ServerType;
  const url = `http://${host}:${port}`;
  log.info("api listening", { url });
  return {
    url,
    async close() {
      log.info("api shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDefaultDb();
      log.info("api stopped");
    },
  };
}

export { eq, getDefaultDb, sessionsTable, wakeupsTable };
