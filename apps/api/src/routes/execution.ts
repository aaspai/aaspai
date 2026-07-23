import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import type { Hono } from "hono";

export function registerExecutionRoutes(app: Hono): void {
  app.post("/v1/execution/work-items", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const required = [
      "organizationId",
      "goalId",
      "projectId",
      "repositoryId",
      "title",
      "idempotencyKey",
    ];
    if (!body || required.some((key) => typeof body[key] !== "string" || body[key] === "")) {
      return c.json(
        { error: "invalid_request", message: "work item lineage and idempotencyKey are required" },
        400,
      );
    }

    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.createWorkItem({
      organizationId: body.organizationId as string,
      goalId: body.goalId as string,
      projectId: body.projectId as string,
      repositoryId: body.repositoryId as string,
      title: body.title as string,
      description: typeof body.description === "string" ? body.description : undefined,
      definitionRevisionId:
        typeof body.definitionRevisionId === "string" ? body.definitionRevisionId : null,
      sourceCommitSha: typeof body.sourceCommitSha === "string" ? body.sourceCommitSha : null,
      branchName: typeof body.branchName === "string" ? body.branchName : null,
      idempotencyKey: body.idempotencyKey as string,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
    });
    return c.json({ data: await store.getWorkItem(workItem.id) }, 201);
  });

  app.get("/v1/execution/work-items/:id", async (c) => {
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    return c.json({ data: workItem });
  });

  app.post("/v1/execution/work-items/:id/claim", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { attemptId?: unknown } | null;
    if (!body || typeof body.attemptId !== "string" || body.attemptId === "") {
      return c.json({ error: "invalid_request", message: "attemptId is required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const claimed = await store.claimWorkItem(c.req.param("id"), body.attemptId);
    if (!claimed)
      return c.json({ error: "conflict", message: "Work item is already claimed" }, 409);
    return c.json({
      data: { workItemId: c.req.param("id"), attemptId: body.attemptId, status: "claimed" },
    });
  });

  app.get("/v1/execution/attempts/:id", async (c) => {
    const store = new ExecutionStore(getDefaultDb().db);
    const attempt = await store.getAttempt(c.req.param("id"));
    if (!attempt) return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
    return c.json({
      data: {
        attempt,
        events: await store.listEvents(attempt.id),
        artifacts: await store.listArtifacts(attempt.id),
      },
    });
  });

  app.post("/v1/execution/attempts/:id/cancel", async (c) => {
    const store = new ExecutionStore(getDefaultDb().db);
    try {
      const attempt = await store.cancelAttempt(c.req.param("id"));
      return c.json({ data: attempt });
    } catch (error) {
      if (String(error).includes("not found")) {
        return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
      }
      throw error;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
