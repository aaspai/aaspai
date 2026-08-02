import type { AuthVerifier } from "@aaspai/auth";
import { CompanyCommandService } from "@aaspai/company";
import {
  and,
  companyControlEvents,
  desc,
  eq,
  executionOperatorRuns,
  executionProcessDefinitions,
  getDefaultDb,
  loops,
  processBindings,
  wakeups,
} from "@aaspai/db";
import type { Context, Hono } from "hono";
import { authenticate } from "./auth.js";

export function registerStrategicRoutes(
  app: Hono,
  options: { authVerifier?: AuthVerifier } = {},
): void {
  app.get("/v1/company/strategic-summary", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({
      data: await new CompanyCommandService(getDefaultDb().db).getSummary(
        auth.principal.organizationId,
      ),
    });
  });

  app.get("/v1/company/timeline", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const rows = await getDefaultDb()
      .db.select()
      .from(companyControlEvents)
      .where(eq(companyControlEvents.organizationId, auth.principal.organizationId))
      .orderBy(desc(companyControlEvents.occurredAt))
      .limit(100);
    return c.json({ data: rows });
  });

  app.post("/v1/company/setup", (c) => executeCommand(c, options, "setup_company"));
  app.post("/v1/company/validate", (c) => executeCommand(c, options, "validate_company"));
  app.post("/v1/company/discovery", (c) => executeCommand(c, options, "start_discovery"));
  app.post("/v1/company/activate", (c) => executeCommand(c, options, "activate_company"));
  app.post("/v1/company/commands", (c) => executeCommand(c, options));

  app.get("/v1/objectives", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const summary = await new CompanyCommandService(getDefaultDb().db).getSummary(
      auth.principal.organizationId,
    );
    return c.json({ data: summary.objectives });
  });

  app.get("/v1/objectives/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const summary = await new CompanyCommandService(getDefaultDb().db).getSummary(
      auth.principal.organizationId,
    );
    const objective = summary.objectives.find((item) => item.id === c.req.param("id"));
    return objective
      ? c.json({ data: objective })
      : c.json({ error: "not_found", message: "objective not found" }, 404);
  });

  app.post("/v1/objectives/:id/measurements", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = await c.req.json().catch(() => null);
    return executeCommand(
      c,
      options,
      "record_measurement",
      {
        ...(isRecord(body) ? body : {}),
        goalId: c.req.param("id"),
        actorId: auth.principal.userId,
        organizationId: auth.principal.organizationId,
      },
      auth,
    );
  });
  app.post("/v1/objectives/:id/evaluate", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = await c.req.json().catch(() => null);
    return executeCommand(
      c,
      options,
      "evaluate_objective",
      { ...(isRecord(body) ? body : {}), goalId: c.req.param("id") },
      auth,
    );
  });

  app.get("/v1/projects", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const summary = await new CompanyCommandService(getDefaultDb().db).getSummary(
      auth.principal.organizationId,
    );
    return c.json({ data: summary.projects });
  });

  app.get("/v1/projects/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const summary = await new CompanyCommandService(getDefaultDb().db).getSummary(
      auth.principal.organizationId,
    );
    const project = summary.projects.find((item) => item.id === c.req.param("id"));
    return project
      ? c.json({ data: project })
      : c.json({ error: "not_found", message: "project not found" }, 404);
  });

  app.get("/v1/projects/:id/timeline", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const rows = await getDefaultDb()
      .db.select()
      .from(companyControlEvents)
      .where(eq(companyControlEvents.organizationId, auth.principal.organizationId))
      .orderBy(desc(companyControlEvents.occurredAt))
      .limit(200);
    return c.json({ data: rows.filter((row) => row.targetId === c.req.param("id")) });
  });
  app.post("/v1/projects/:id/evaluate", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = await c.req.json().catch(() => null);
    return executeCommand(
      c,
      options,
      "evaluate_project",
      { ...(isRecord(body) ? body : {}), projectId: c.req.param("id") },
      auth,
    );
  });
  app.post("/v1/projects/:id/milestones/:milestoneId/evaluate", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = await c.req.json().catch(() => null);
    return executeCommand(
      c,
      options,
      "record_milestone_evaluation",
      {
        ...(isRecord(body) ? body : {}),
        projectId: c.req.param("id"),
        milestoneId: c.req.param("milestoneId"),
      },
      auth,
    );
  });

  app.get("/v1/manager-runs", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const rows = await getDefaultDb()
      .db.select()
      .from(executionOperatorRuns)
      .where(eq(executionOperatorRuns.organizationId, auth.principal.organizationId))
      .orderBy(desc(executionOperatorRuns.updatedAt));
    return c.json({
      data: rows.map(({ operatorAgentId, ...run }) => ({
        ...run,
        managerAgentId: operatorAgentId,
      })),
    });
  });

  app.get("/v1/process-definitions", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({
      data: await getDefaultDb()
        .db.select()
        .from(executionProcessDefinitions)
        .where(eq(executionProcessDefinitions.organizationId, auth.principal.organizationId))
        .orderBy(desc(executionProcessDefinitions.createdAt)),
    });
  });

  app.get("/v1/projects/:id/process-bindings", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    return c.json({
      data: await getDefaultDb()
        .db.select()
        .from(processBindings)
        .where(
          and(
            eq(processBindings.organizationId, auth.principal.organizationId),
            eq(processBindings.projectId, c.req.param("id")),
          ),
        )
        .orderBy(desc(processBindings.updatedAt)),
    });
  });

  app.post("/v1/manager-runs/:id/wake", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const rows = await getDefaultDb()
      .db.select()
      .from(executionOperatorRuns)
      .where(
        and(
          eq(executionOperatorRuns.organizationId, auth.principal.organizationId),
          eq(executionOperatorRuns.id, c.req.param("id")),
        ),
      )
      .limit(1);
    const run = rows[0];
    if (!run) return c.json({ error: "not_found", message: "manager run not found" }, 404);
    const loopId = `loop/manager/${auth.principal.organizationId}`;
    const now = new Date().toISOString();
    await getDefaultDb()
      .db.insert(loops)
      .values({
        id: loopId,
        organizationId: auth.principal.organizationId,
        patternId: "manager",
        configJson: "{}",
        gateJson: "{}",
        budgetJson: "{}",
        scheduleJson: "{}",
        paused: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    await getDefaultDb()
      .db.insert(wakeups)
      .values({
        id: `wake_operator_${Date.now()}`,
        organizationId: auth.principal.organizationId,
        loopId,
        source: "on_demand",
        triggerDetail: "manager",
        reason: "Manual manager wake",
        agentId: run.operatorAgentId,
        payloadJson: JSON.stringify({ operatorRunId: run.id }),
        status: "queued",
        idempotencyKey: `operator-wake:${run.id}:${now}`,
        requestedAt: now,
        requestedByActorId: auth.principal.userId,
        requestedByActorType: "user",
      })
      .run();
    return c.json({ data: { queued: true, managerRunId: run.id } }, 202);
  });

  app.post("/v1/manager-runs/:id/pause", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const [run] = await getDefaultDb()
      .db.select({
        scopeType: executionOperatorRuns.scopeType,
        scopeId: executionOperatorRuns.scopeId,
      })
      .from(executionOperatorRuns)
      .where(
        and(
          eq(executionOperatorRuns.organizationId, auth.principal.organizationId),
          eq(executionOperatorRuns.id, c.req.param("id")),
        ),
      )
      .limit(1);
    if (!run) return c.json({ error: "not_found", message: "manager run not found" }, 404);
    if (run.scopeType !== "project")
      return c.json(
        { error: "invalid_request", message: "only project manager runs can be paused" },
        409,
      );
    return executeCommand(
      c,
      options,
      "pause_scope",
      { scopeType: "project", scopeId: run.scopeId },
      auth,
    );
  });

  app.get("/v1/threads", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const service = new CompanyCommandService(getDefaultDb().db);
    return c.json({
      data: await service.listThreads(
        auth.principal.organizationId,
        c.req.query("entityType"),
        c.req.query("entityId"),
      ),
    });
  });

  app.post("/v1/threads", (c) => executeCommand(c, options, "create_thread"));
  app.post("/v1/threads/:id/messages", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = await c.req.json().catch(() => null);
    return executeCommand(
      c,
      options,
      "add_thread_message",
      { ...(isRecord(body) ? body : {}), threadId: c.req.param("id") },
      auth,
    );
  });

  app.get("/v1/threads/:id/messages", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const service = new CompanyCommandService(getDefaultDb().db);
    return c.json({
      data: await service.listThreadMessages(auth.principal.organizationId, c.req.param("id")),
    });
  });
}

async function executeCommand(
  c: Context,
  options: { authVerifier?: AuthVerifier },
  expectedType?: string,
  override?: Record<string, unknown>,
  authenticated?: Awaited<ReturnType<typeof authenticate>>,
) {
  const auth = authenticated ?? (await authenticate(c, options.authVerifier, "write"));
  if ("response" in auth) return auth.response;
  const body = await c.req.json().catch(() => null);
  if (!isRecord(body) && !override)
    return c.json({ error: "invalid_request", message: "command body is required" }, 400);
  const command: Record<string, unknown> = {
    ...(isRecord(body) ? body : {}),
    ...(override ?? {}),
    organizationId: auth.principal.organizationId,
    actorId: auth.principal.userId,
  };
  if (expectedType && command.type !== expectedType) command.type = expectedType;
  if (typeof command.idempotencyKey !== "string")
    command.idempotencyKey = `${expectedType ?? "command"}:${Date.now()}`;
  if (
    OWNER_COMMANDS.has(String(command.type)) &&
    !auth.principal.roles.some((role) => role === "owner" || role === "admin")
  ) {
    return c.json(
      { error: "forbidden", message: "Owner or admin role required for company governance" },
      403,
    );
  }
  try {
    return c.json(
      { data: await new CompanyCommandService(getDefaultDb().db).execute(command) },
      expectedType === "setup_company" ? 201 : 200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message)
      ? 404
      : /required|must|invalid|approval/i.test(message)
        ? 409
        : 400;
    return c.json({ error: "invalid_request", message }, status);
  }
}

const OWNER_COMMANDS = new Set([
  "setup_company",
  "validate_company",
  "start_discovery",
  "submit_portfolio_proposal",
  "activate_company",
  "create_objective",
  "create_project",
  "appoint_project_manager",
  "pause_scope",
  "resume_scope",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
