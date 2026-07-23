import type { AuthVerifier } from "@aaspai/auth";
import { CompanyOperationsService } from "@aaspai/company";
import { getDefaultDb } from "@aaspai/db";
import type { GitRepository, PullRequestProvider } from "@aaspai/git";
import { LocalGitHubPullRequestProvider, LocalGitRepository } from "@aaspai/git";
import type { Context, Hono } from "hono";
import { authenticate } from "./execution.js";

export function registerCompanyRoutes(
  app: Hono,
  options: {
    authVerifier?: AuthVerifier;
    git?: GitRepository;
    pullRequests?: PullRequestProvider;
  } = {},
): void {
  app.get("/v1/company/operations", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const service = new CompanyOperationsService(getDefaultDb().db);
    return c.json({ data: await service.getOverview(auth.principal.organizationId) });
  });

  app.post("/v1/company/departments", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || !body.name.trim())
      return c.json({ error: "invalid_request", message: "name is required" }, 400);
    try {
      const department = await new CompanyOperationsService(getDefaultDb().db).createDepartment({
        organizationId: auth.principal.organizationId,
        name: body.name,
        description: typeof body.description === "string" ? body.description : undefined,
        managerAgentId: typeof body.managerAgentId === "string" ? body.managerAgentId : null,
      });
      return c.json({ data: department }, 201);
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/departments/:id/members", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.agentId !== "string")
      return c.json({ error: "invalid_request", message: "agentId is required" }, 400);
    try {
      const member = await new CompanyOperationsService(getDefaultDb().db).setDepartmentMember({
        organizationId: auth.principal.organizationId,
        departmentId: c.req.param("id"),
        agentId: body.agentId,
        role: body.role === "manager" ? "manager" : "member",
      });
      return c.json({ data: member }, 201);
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/service-agents", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.agentId !== "string")
      return c.json({ error: "invalid_request", message: "agentId is required" }, 400);
    try {
      const serviceAgent = await new CompanyOperationsService(
        getDefaultDb().db,
      ).registerServiceAgent({
        organizationId: auth.principal.organizationId,
        agentId: body.agentId,
        departmentId: typeof body.departmentId === "string" ? body.departmentId : null,
        metadata: isRecord(body.metadata) ? body.metadata : undefined,
      });
      return c.json({ data: serviceAgent }, 201);
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/service-agents/:id/heartbeat", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      const agent = await new CompanyOperationsService(getDefaultDb().db).heartbeatServiceAgent(
        auth.principal.organizationId,
        c.req.param("id"),
        typeof body?.lastRunAt === "string" ? body.lastRunAt : undefined,
      );
      return c.json({ data: agent });
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/service-agents/:id/:action", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const action = c.req.param("action");
    if (action !== "pause" && action !== "resume" && action !== "retire")
      return c.json({ error: "not_found", message: "Unknown service-agent action" }, 404);
    try {
      const agent = await new CompanyOperationsService(getDefaultDb().db).transitionServiceAgent(
        auth.principal.organizationId,
        c.req.param("id"),
        action === "pause" ? "paused" : action === "resume" ? "active" : "retired",
      );
      return c.json({ data: agent });
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/service-agents/reconcile", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const staleAfterMs = typeof body?.staleAfterMs === "number" ? body.staleAfterMs : 5 * 60_000;
    try {
      const stale = await new CompanyOperationsService(getDefaultDb().db).reconcileServiceAgents(
        auth.principal.organizationId,
        staleAfterMs,
      );
      return c.json({ data: stale });
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/autonomy-proposals", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      (body.targetType !== "agent" && body.targetType !== "loop") ||
      typeof body.targetId !== "string" ||
      typeof body.fromLevel !== "string" ||
      typeof body.toLevel !== "string" ||
      typeof body.rationale !== "string"
    )
      return c.json(
        { error: "invalid_request", message: "target, levels, and rationale are required" },
        400,
      );
    try {
      const proposal = await new CompanyOperationsService(getDefaultDb().db).createAutonomyProposal(
        {
          organizationId: auth.principal.organizationId,
          targetType: body.targetType,
          targetId: body.targetId,
          fromLevel: body.fromLevel as "L0" | "L1" | "L2" | "L3",
          toLevel: body.toLevel as "L0" | "L1" | "L2" | "L3",
          rationale: body.rationale,
          evidence: isRecord(body.evidence) ? body.evidence : undefined,
          proposedBy: auth.principal.userId,
        },
      );
      return c.json({ data: proposal }, 201);
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.post("/v1/company/autonomy-proposals/:id/decision", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || (body.decision !== "approved" && body.decision !== "rejected"))
      return c.json(
        { error: "invalid_request", message: "decision must be approved or rejected" },
        400,
      );
    try {
      const proposal = await new CompanyOperationsService(getDefaultDb().db).decideAutonomyProposal(
        auth.principal.organizationId,
        c.req.param("id"),
        body.decision,
        auth.principal.userId,
        typeof body.reason === "string" ? body.reason : "",
      );
      return c.json({ data: proposal });
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.get("/v1/company/autonomy-change-requests", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const requests = await new CompanyOperationsService(
      getDefaultDb().db,
    ).listAutonomyChangeRequests(auth.principal.organizationId);
    return c.json({ data: requests });
  });

  app.post("/v1/company/autonomy-proposals/:id/change-request", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.repositoryId !== "string" ||
      typeof body.workspaceRoot !== "string" ||
      !body.workspaceRoot.trim()
    ) {
      return c.json(
        { error: "invalid_request", message: "repositoryId and workspaceRoot are required" },
        400,
      );
    }
    try {
      const service = new CompanyOperationsService(getDefaultDb().db, {
        git: options.git ?? new LocalGitRepository(),
        pullRequests: options.pullRequests ?? new LocalGitHubPullRequestProvider(),
      });
      const request = await service.createAutonomyChangeRequest({
        organizationId: auth.principal.organizationId,
        proposalId: c.req.param("id"),
        repositoryId: body.repositoryId,
        workspaceRoot: body.workspaceRoot,
        createdBy: auth.principal.userId,
      });
      return c.json({ data: request }, 201);
    } catch (error) {
      return companyError(c, error);
    }
  });

  app.get("/v1/company/export", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    const bundle = await new CompanyOperationsService(getDefaultDb().db).exportCompany(
      auth.principal.organizationId,
    );
    return c.json({ data: bundle });
  });

  app.post("/v1/company/import/validate", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "read");
    if ("response" in auth) return auth.response;
    try {
      const bundle = new CompanyOperationsService(getDefaultDb().db).validateImport(
        await c.req.json(),
      );
      return c.json({ data: { valid: true, counts: counts(bundle) } });
    } catch (error) {
      return c.json(
        {
          error: "invalid_bundle",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      );
    }
  });

  app.post("/v1/company/import/apply", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    try {
      const overview = await new CompanyOperationsService(getDefaultDb().db).importCompany(
        auth.principal.organizationId,
        await c.req.json(),
      );
      return c.json({ data: overview }, 200);
    } catch (error) {
      return c.json(
        {
          error: "invalid_bundle",
          message: String(error instanceof Error ? error.message : error),
        },
        400,
      );
    }
  });
}

function companyError(c: Context, error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  const status = /not found/i.test(message)
    ? 404
    : /already exists|already been decided|cannot|must be|cycle/i.test(message)
      ? 409
      : 400;
  return c.json({ error: status === 404 ? "not_found" : "invalid_request", message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function counts(bundle: {
  departments: unknown[];
  members: unknown[];
  serviceAgents: unknown[];
  autonomyProposals: unknown[];
}) {
  return {
    departments: bundle.departments.length,
    members: bundle.members.length,
    serviceAgents: bundle.serviceAgents.length,
    autonomyProposals: bundle.autonomyProposals.length,
  };
}
