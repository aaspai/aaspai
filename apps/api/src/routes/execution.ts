import { type AuthVerifier, authorizePrincipal } from "@aaspai/auth";
import {
  type ApiScope,
  type AuthPrincipal,
  type ExecutionGovernanceInput,
  executionGovernanceSchema,
} from "@aaspai/contracts";
import { getDefaultDb } from "@aaspai/db";
import { DependencyScheduler, ExecutionStore } from "@aaspai/execution";
import type { Context, Hono } from "hono";

interface ExecutionRouteOptions {
  authVerifier?: AuthVerifier;
}

export type AuthResult = { principal: AuthPrincipal } | { response: Response };

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

    let governance: ExecutionGovernanceInput | undefined;
    if (body.governance !== undefined) {
      const parsedGovernance = executionGovernanceSchema.safeParse(body.governance);
      if (!parsedGovernance.success) {
        return c.json(
          { error: "invalid_governance", message: "Governance policy is invalid" },
          400,
        );
      }
      governance = parsedGovernance.data;
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
      governance,
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

  app.post("/v1/execution/work-items/:id/dependencies", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as {
      dependsOnWorkItemId?: unknown;
    } | null;
    if (!body || typeof body.dependsOnWorkItemId !== "string" || body.dependsOnWorkItemId === "") {
      return c.json({ error: "invalid_request", message: "dependsOnWorkItemId is required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (workItem.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    try {
      const dependency = await store.addWorkItemDependency(
        auth.principal.organizationId,
        workItem.id,
        body.dependsOnWorkItemId,
      );
      return c.json({ data: dependency }, 201);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (/cycle|depend on itself/i.test(message)) {
        return c.json({ error: "dependency_cycle", message }, 409);
      }
      if (/not found/i.test(message)) {
        return c.json({ error: "not_found", message }, 404);
      }
      if (/same goal/i.test(message)) {
        return c.json({ error: "invalid_dependency", message }, 400);
      }
      throw error;
    }
  });

  app.get("/v1/execution/work-items/:id/dependencies", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (workItem.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    return c.json({ data: await store.listWorkItemDependencies(workItem.id) });
  });

  app.get("/v1/execution/goals/:id/progress", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const goal = await store.getGoal(c.req.param("id"));
    if (!goal) return c.json({ error: "not_found", message: "Goal not found" }, 404);
    if (goal.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    return c.json({ data: await store.getGoalProgress(goal.id) });
  });

  app.get("/v1/execution/company/health", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    return c.json({ data: await store.getCompanyHealth(auth.principal.organizationId) });
  });

  app.post("/v1/execution/workflows/:id/schedule", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.agentId !== "string" || typeof body.harness !== "string") {
      return c.json({ error: "invalid_request", message: "agentId and harness are required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const workflowRun = await store.getWorkflowRun(c.req.param("id"));
    if (!workflowRun) return c.json({ error: "not_found", message: "Workflow run not found" }, 404);
    if (workflowRun.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    const maxDispatch = typeof body.maxDispatch === "number" ? body.maxDispatch : undefined;
    const result = await new DependencyScheduler(store).tick({
      organizationId: auth.principal.organizationId,
      goalId: workflowRun.goalId,
      workflowRunId: workflowRun.id,
      agentId: body.agentId,
      harness: body.harness,
      maxDispatch,
    });
    return c.json({ data: result }, 202);
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

  app.post("/v1/execution/verifications/:id/checker-attempts", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.agentId !== "string" || typeof body.harness !== "string") {
      return c.json({ error: "invalid_request", message: "agentId and harness are required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const verification = await store.getVerification(c.req.param("id"));
    if (!verification)
      return c.json({ error: "not_found", message: "Verification not found" }, 404);
    if (verification.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    try {
      const attempt = await store.createCheckerAttempt({
        verificationId: verification.id,
        agentId: body.agentId,
        harness: body.harness,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return c.json({ data: attempt }, 201);
    } catch (error) {
      return c.json(
        {
          error: "invalid_checker",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      );
    }
  });

  app.post("/v1/execution/verifications/:id/submit", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const statuses = new Set(["passed", "failed", "concerns"]);
    if (
      !body ||
      typeof body.checkerAttemptId !== "string" ||
      typeof body.status !== "string" ||
      !statuses.has(body.status) ||
      typeof body.summary !== "string"
    ) {
      return c.json(
        { error: "invalid_request", message: "checkerAttemptId, status, and summary are required" },
        400,
      );
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const verification = await store.getVerification(c.req.param("id"));
    if (!verification)
      return c.json({ error: "not_found", message: "Verification not found" }, 404);
    if (verification.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    try {
      const result = await store.submitVerification({
        verificationId: verification.id,
        checkerAttemptId: body.checkerAttemptId,
        status: body.status as "passed" | "failed" | "concerns",
        summary: body.summary,
        evidenceIds: Array.isArray(body.evidenceIds)
          ? body.evidenceIds.filter((id): id is string => typeof id === "string")
          : [],
      });
      return c.json({ data: result });
    } catch (error) {
      return c.json(
        {
          error: "invalid_verification",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      );
    }
  });

  app.post("/v1/execution/approvals/:id/decision", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const statuses = new Set(["approved", "rejected", "changes_requested"]);
    if (!body || typeof body.status !== "string" || !statuses.has(body.status)) {
      return c.json({ error: "invalid_request", message: "status is required" }, 400);
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const pendingApproval = await store.getApproval(c.req.param("id"));
    if (!pendingApproval) return c.json({ error: "not_found", message: "Approval not found" }, 404);
    if (pendingApproval.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    const actorType =
      body.actorType === "operator" || body.actorType === "supervisor" ? body.actorType : "human";
    if (actorType !== "human" && !auth.principal.roles.includes(actorType)) {
      return c.json(
        { error: "approval_role_denied", message: "Approval role is not authorized" },
        403,
      );
    }
    try {
      const result = await store.decideApproval({
        approvalId: c.req.param("id"),
        actorId: auth.principal.userId,
        actorType,
        status: body.status as "approved" | "rejected" | "changes_requested",
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return c.json({ data: result });
    } catch (error) {
      return c.json(
        {
          error: "invalid_approval",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      );
    }
  });

  app.get("/v1/execution/work-items/:id/governance-events", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const workItem = await store.getWorkItem(c.req.param("id"));
    if (!workItem) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (workItem.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
    }
    return c.json({
      data: {
        governance: workItem.governance,
        verification: await store.getVerificationForWorkItem(workItem.id),
        approvals: await store.listApprovalsForWorkItem(workItem.id),
        events: await store.listGovernanceEvents(auth.principal.organizationId, workItem.id),
      },
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
        harnessSession: attempt.harnessSessionId
          ? publicHarnessSession(await store.getHarnessSession(attempt.harnessSessionId))
          : null,
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

export async function authenticate(
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

function publicHarnessSession(session: Awaited<ReturnType<ExecutionStore["getHarnessSession"]>>) {
  if (!session) return null;
  return {
    id: session.id,
    organizationId: session.organizationId,
    agentId: session.agentId,
    adapter: session.adapter,
    status: session.status,
    sessionId: session.sessionId,
    sessionDisplayId: session.sessionDisplayId,
    resultJson: session.resultJson,
    usageJson: session.usageJson,
    costUsd: session.costUsd,
    errorFamily: session.errorFamily,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    durationMs: session.durationMs,
  };
}
