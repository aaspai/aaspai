import { type AuthVerifier, authorizePrincipal } from "@aaspai/auth";
import type { ApiScope, AuthPrincipal } from "@aaspai/contracts";
import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import type { Context, Hono } from "hono";

interface ExecutionRouteOptions {
  authVerifier?: AuthVerifier;
}

type AuthResult = { principal: AuthPrincipal } | { response: Response };

export function registerExecutionRoutes(app: Hono, options: ExecutionRouteOptions = {}): void {
  app.post("/v1/execution/work-items", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const required = ["goalId", "projectId", "repositoryId", "title", "idempotencyKey"];
    if (!body || required.some((key) => typeof body[key] !== "string" || body[key] === "")) {
      return c.json(
        { error: "invalid_request", message: "work item lineage and idempotencyKey are required" },
        400,
      );
    }

    if (
      typeof body.organizationId === "string" &&
      body.organizationId !== auth.principal.organizationId
    ) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }

    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.createWorkItem({
      organizationId: auth.principal.organizationId,
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
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (workItem.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    return c.json({ data: workItem });
  });

  app.post("/v1/execution/work-items/:id/claim", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as { attemptId?: unknown } | null;
    if (!body || typeof body.attemptId !== "string" || body.attemptId === "") {
      return c.json({ error: "invalid_request", message: "attemptId is required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (workItem.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    const claimed = await store.claimWorkItem(c.req.param("id"), body.attemptId);
    if (!claimed)
      return c.json({ error: "conflict", message: "Work item is already claimed" }, 409);
    return c.json({
      data: { workItemId: c.req.param("id"), attemptId: body.attemptId, status: "claimed" },
    });
  });

  app.get("/v1/execution/attempts/:id", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const attempt = await store.getAttempt(c.req.param("id"));
    if (!attempt) return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
    if (attempt.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    return c.json({
      data: {
        attempt,
        events: await store.listEvents(attempt.id),
        artifacts: await store.listArtifacts(attempt.id),
      },
    });
  });

  app.post("/v1/execution/attempts/:id/cancel", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    try {
      const current = await store.getAttempt(c.req.param("id"));
      if (!current) return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
      if (current.organizationId !== auth.principal.organizationId) {
        return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
      }
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

async function authenticate(
  c: Context,
  verifier: AuthVerifier | undefined,
  requiredScope: ApiScope,
): Promise<AuthResult> {
  if (!verifier) {
    return {
      response: c.json(
        { error: "auth_unconfigured", message: "Execution API authentication is not configured" },
        503,
      ),
    };
  }

  const authorization = c.req.header("Authorization");
  const cookie = c.req.header("Cookie");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  const bearerToken = bearer?.[1];
  const credential = bearerToken
    ? { kind: "bearer" as const, value: bearerToken }
    : cookie
      ? { kind: "session" as const, value: cookie }
      : undefined;
  const verified = await verifier.verify({ credential });
  if (!verified.ok) {
    const status = verified.code === "missing_credential" ? 401 : 401;
    return {
      response: c.json({ error: verified.code, message: "Authentication required" }, status),
    };
  }

  const authorized = authorizePrincipal(verified.principal, { requiredScopes: [requiredScope] });
  if (!authorized.ok) {
    return {
      response: c.json({ error: authorized.code, message: "Authentication scope denied" }, 403),
    };
  }
  return { principal: authorized.principal };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
