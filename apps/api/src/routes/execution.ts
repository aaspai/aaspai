import { isDeepStrictEqual } from "node:util";
import type { AuthVerifier } from "@aaspai/auth";
import { type ExecutionGovernanceInput, executionGovernanceSchema } from "@aaspai/contracts";
import { getDefaultDb } from "@aaspai/db";
import {
  DependencyScheduler,
  ExecutionStore,
  ExternalActionConflictError,
} from "@aaspai/execution";
import type { GitRepository, PullRequestProvider } from "@aaspai/git";
import { LocalGitHubPullRequestProvider, LocalGitRepository } from "@aaspai/git";
import type { Hono } from "hono";
import { authenticate } from "./auth.js";

interface ExecutionRouteOptions {
  authVerifier?: AuthVerifier;
  git?: GitRepository;
  pullRequests?: PullRequestProvider;
}

export function registerExecutionRoutes(app: Hono, options: ExecutionRouteOptions = {}): void {
  app.post("/v1/execution/work-items", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const required = ["goalId", "projectId", "title", "idempotencyKey"];
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

    if (
      body.workKind !== undefined &&
      !["repository", "general", "external_action"].includes(String(body.workKind))
    ) {
      return c.json({ error: "invalid_request", message: "workKind is invalid" }, 400);
    }
    if (
      body.deliveryMode !== undefined &&
      !["none", "artifact", "commit", "pull_request"].includes(String(body.deliveryMode))
    ) {
      return c.json({ error: "invalid_request", message: "deliveryMode is invalid" }, 400);
    }
    const workKind =
      body.workKind === "general" || body.workKind === "external_action"
        ? body.workKind
        : "repository";
    const deliveryMode =
      body.deliveryMode === "none" ||
      body.deliveryMode === "artifact" ||
      body.deliveryMode === "commit" ||
      body.deliveryMode === "pull_request"
        ? body.deliveryMode
        : workKind === "repository"
          ? "commit"
          : "none";
    if (
      (workKind === "external_action" && deliveryMode !== "none") ||
      (workKind === "general" && !["none", "artifact"].includes(deliveryMode))
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: `${workKind} work cannot use ${deliveryMode} delivery`,
        },
        400,
      );
    }
    if (workKind === "repository" && typeof body.repositoryId !== "string") {
      return c.json(
        { error: "invalid_request", message: "repositoryId is required for repository work" },
        400,
      );
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const context = {
      organizationId: auth.principal.organizationId,
      actorId: auth.principal.userId,
      correlationId: c.req.header("x-request-id") ?? "api-work-item-create",
    };
    const goal = await store.getGoal(body.goalId as string, context);
    const project = await store.getProject(body.projectId as string, context);
    if (!goal || !project || project.goalId !== goal.id) {
      return c.json(
        { error: "invalid_lineage", message: "Goal and project lineage is invalid" },
        400,
      );
    }
    if (
      body.repositoryIds !== undefined &&
      (!Array.isArray(body.repositoryIds) ||
        body.repositoryIds.length > 32 ||
        body.repositoryIds.some((value) => typeof value !== "string" || value.length === 0))
    ) {
      return c.json({ error: "invalid_lineage", message: "Repository lineage is invalid" }, 400);
    }
    const projectRepositories = await store.listRepositoriesForProject(project.id, context);
    let repositoryId =
      typeof body.repositoryId === "string" && body.repositoryId
        ? body.repositoryId
        : projectRepositories[0]?.id;
    if (!repositoryId) {
      const repository = await store.createRepository({
        id: `repo:general:${project.id}`,
        organizationId: auth.principal.organizationId,
        projectId: project.id,
        purpose: "project",
        provider: "local",
        localPath: process.cwd(),
      });
      repositoryId = repository.id;
      projectRepositories.push(repository);
    }
    const repositoryIds = [
      ...new Set([
        repositoryId,
        ...(Array.isArray(body.repositoryIds) ? (body.repositoryIds as string[]) : []),
      ]),
    ];
    const ownedRepositoryIds = new Set(projectRepositories.map((repository) => repository.id));
    if (repositoryIds.some((id) => !ownedRepositoryIds.has(id))) {
      return c.json({ error: "invalid_lineage", message: "Repository lineage is invalid" }, 400);
    }
    if (typeof body.definitionRevisionId === "string") {
      const revision = await store.getDefinitionRevision(body.definitionRevisionId, context);
      if (!revision || !repositoryIds.includes(revision.repositoryId)) {
        return c.json(
          { error: "invalid_lineage", message: "Definition revision lineage is invalid" },
          400,
        );
      }
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
    const externalAction =
      workKind === "external_action" ? parseExternalActionPlan(body.externalAction) : null;
    if (
      workKind === "external_action" &&
      (!externalAction ||
        !governance?.approval?.required ||
        governance.approval.actorType !== "human")
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "external_action work requires an externalAction plan and human approval",
        },
        400,
      );
    }
    if (
      externalAction &&
      !isApprovedConnectorOperation(externalAction.connector, externalAction.operation)
    ) {
      return c.json(
        {
          error: "connector_denied",
          message: "Connector operation is not approved for external actions",
        },
        400,
      );
    }
    const workItem = await store.createWorkItem({
      organizationId: auth.principal.organizationId,
      goalId: body.goalId as string,
      projectId: body.projectId as string,
      repositoryId,
      repositoryIds,
      workKind,
      deliveryMode,
      title: body.title as string,
      description: typeof body.description === "string" ? body.description : undefined,
      definitionRevisionId:
        typeof body.definitionRevisionId === "string" ? body.definitionRevisionId : null,
      sourceCommitSha: typeof body.sourceCommitSha === "string" ? body.sourceCommitSha : null,
      branchName: typeof body.branchName === "string" ? body.branchName : null,
      idempotencyKey: body.idempotencyKey as string,
      metadata: {
        ...(isRecord(body.metadata) ? body.metadata : {}),
        ...(externalAction ? { externalAction } : {}),
      },
      governance,
    });
    return c.json({ data: await store.getWorkItem(workItem.id) }, 201);
  });

  app.post("/v1/execution/work-items/:id/deliver", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "deploy");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    const item = await store.getWorkItem(c.req.param("id"), {
      organizationId: auth.principal.organizationId,
      actorId: auth.principal.userId,
      correlationId: c.req.header("x-request-id") ?? "api-work-item-deliver",
    });
    if (!item) return c.json({ error: "not_found", message: "Work item not found" }, 404);
    if (
      item.status !== "completed" ||
      item.deliveryMode !== "pull_request" ||
      !["ready", "failed", "delivering"].includes(item.deliveryStatus)
    ) {
      return c.json(
        { error: "not_deliverable", message: "Work item is not ready for delivery" },
        409,
      );
    }
    const claimed = await store.claimDelivery(item.id);
    if (!claimed) {
      return c.json({ error: "delivery_in_progress", message: "Delivery is already running" }, 409);
    }
    const deliveryOwner = claimed.deliveryClaimOwner;
    if (!deliveryOwner) {
      return c.json({ error: "delivery_failed", message: "Delivery claim owner is missing" }, 500);
    }
    const repository = await store.getRepository(item.repositoryId, {
      organizationId: auth.principal.organizationId,
      actorId: auth.principal.userId,
      correlationId: c.req.header("x-request-id") ?? "api-work-item-deliver",
    });
    if (!repository?.remoteUrl || !claimed.branchName || !claimed.deliveryCommitSha) {
      await store.completeDelivery({
        workItemId: item.id,
        ownerId: deliveryOwner,
        status: "failed",
        error: "Pull-request delivery requires repository, branch, and commit evidence",
      });
      return c.json(
        { error: "delivery_failed", message: "Repository delivery data is missing" },
        409,
      );
    }
    try {
      const git = options.git ?? new LocalGitRepository();
      await git.push(repository.localPath, "origin", claimed.branchName, claimed.deliveryCommitSha);
      const provider = options.pullRequests ?? new LocalGitHubPullRequestProvider();
      const pullRequest =
        (await provider.find?.({
          repository: repository.remoteUrl,
          head: claimed.branchName,
          base: repository.defaultBranch,
        })) ??
        (await provider.create({
          repository: repository.remoteUrl,
          head: claimed.branchName,
          base: repository.defaultBranch,
          title: item.title,
          body: item.description || `Automated delivery for ${item.id}`,
        }));
      const delivered = await store.completeDelivery({
        workItemId: item.id,
        ownerId: deliveryOwner,
        status: "delivered",
        ref: pullRequest.url,
      });
      return c.json({ data: delivered, pullRequest }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.completeDelivery({
        workItemId: item.id,
        ownerId: deliveryOwner,
        status: "failed",
        error: message,
      });
      return c.json({ error: "delivery_failed", message }, 502);
    }
  });

  app.post("/v1/execution/work-items/:id/external-actions", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "deploy");
    if ("response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.connector !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(body.connector) ||
      typeof body.operation !== "string" ||
      !body.operation ||
      typeof body.idempotencyKey !== "string" ||
      !body.idempotencyKey
    ) {
      return c.json(
        {
          error: "invalid_request",
          message: "connector, operation, and idempotencyKey are required",
        },
        400,
      );
    }
    const store = new ExecutionStore(getDefaultDb().db);
    const item = await store.getWorkItem(c.req.param("id"));
    if (!item || item.organizationId !== auth.principal.organizationId) {
      return c.json({ error: "not_found", message: "Work item not found" }, 404);
    }
    if (item.workKind !== "external_action" || item.status !== "completed") {
      return c.json(
        { error: "not_actionable", message: "External action work is not approved and complete" },
        409,
      );
    }
    const approvals = await store.listApprovalsForWorkItem(item.id);
    if (
      !approvals.some(
        (approval) => approval.actorType === "human" && approval.status === "approved",
      )
    ) {
      return c.json(
        { error: "approval_required", message: "External action requires human approval" },
        409,
      );
    }
    const expected = parseExternalActionPlan(item.metadata.externalAction);
    const requested = parseExternalActionPlan({
      connector: body.connector,
      operation: body.operation,
      payload: isRecord(body.payload) ? body.payload : {},
    });
    if (!expected || !requested || !isDeepStrictEqual(expected, requested)) {
      return c.json(
        {
          error: "action_mismatch",
          message: "External action does not match the approved work item plan",
        },
        409,
      );
    }
    if (!isApprovedConnectorOperation(requested.connector, requested.operation)) {
      return c.json(
        {
          error: "connector_denied",
          message: "Connector operation is not approved for external actions",
        },
        403,
      );
    }
    let claimed: Awaited<ReturnType<ExecutionStore["claimExternalAction"]>>;
    try {
      claimed = await store.claimExternalAction({
        organizationId: item.organizationId,
        workItemId: item.id,
        connector: body.connector,
        operation: body.operation,
        payload: isRecord(body.payload) ? body.payload : {},
        idempotencyKey: body.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof ExternalActionConflictError) {
        return c.json({ error: "idempotency_conflict", message: error.message }, 409);
      }
      throw error;
    }
    if (claimed.disposition === "replay") {
      return c.json({ data: publicExternalAction(claimed.action), duplicate: true }, 200);
    }
    if (claimed.disposition === "in_progress" || !claimed.ownerId) {
      return c.json(
        { data: publicExternalAction(claimed.action), duplicate: true, inProgress: true },
        202,
      );
    }
    const ownerId = claimed.ownerId;
    const connectorEnv = `AASPAI_CONNECTOR_${body.connector.toUpperCase().replace(/-/g, "_")}`;
    const endpoint = process.env[`${connectorEnv}_URL`];
    if (!endpoint) {
      const action = await store.completeExternalAction(claimed.action.id, ownerId, {
        status: "failed",
        error: `${connectorEnv}_URL is not configured`,
      });
      return c.json(
        {
          error: "connector_unavailable",
          message: "Connector is not configured",
          data: publicExternalAction(action),
        },
        503,
      );
    }
    let result: Record<string, unknown>;
    try {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
      ) {
        throw new Error("Connector endpoint must use HTTPS");
      }
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          "idempotency-key": body.idempotencyKey,
          ...(process.env[`${connectorEnv}_TOKEN`]
            ? { authorization: `Bearer ${process.env[`${connectorEnv}_TOKEN`]}` }
            : {}),
        },
        body: JSON.stringify({
          operation: body.operation,
          payload: isRecord(body.payload) ? body.payload : {},
          workItemId: item.id,
        }),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(`Connector returned ${response.status}: ${text.slice(0, 512)}`);
      result = text ? safeJsonObject(text) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await store.completeExternalAction(claimed.action.id, ownerId, {
        status: "failed",
        error: message,
      });
      return c.json(
        { error: "connector_failed", message, data: publicExternalAction(action) },
        502,
      );
    }
    const action = await store.completeExternalAction(claimed.action.id, ownerId, {
      status: "succeeded",
      result,
    });
    let governanceWarning: string | undefined;
    try {
      await store.recordGovernanceEvent({
        organizationId: item.organizationId,
        workItemId: item.id,
        action: `connector.${body.connector}.${body.operation}`,
        decision: "allowed",
        reason: "idempotent external action completed",
        metadata: { externalActionId: action.id },
      });
    } catch {
      governanceWarning = "governance_event_persistence_failed";
    }
    return c.json(
      {
        data: publicExternalAction(action),
        ...(governanceWarning ? { warning: governanceWarning } : {}),
      },
      200,
    );
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
    const scheduler = new DependencyScheduler(store, {
      maxOrganizationConcurrency: boundedConcurrency(body.maxOrganizationConcurrency, 2),
      maxProjectConcurrency: boundedConcurrency(body.maxProjectConcurrency, 1),
      maxRepositoryConcurrency: boundedConcurrency(body.maxRepositoryConcurrency, 1),
      maxAgentConcurrency: boundedConcurrency(body.maxAgentConcurrency, 1),
    });
    let result: Awaited<ReturnType<DependencyScheduler["tick"]>>;
    try {
      result = await scheduler.tick({
        organizationId: auth.principal.organizationId,
        goalId: workflowRun.goalId,
        workflowRunId: workflowRun.id,
        agentId: body.agentId,
        harness: body.harness,
        maxDispatch,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "provider_capability_unsupported") {
        return c.json({ error: "provider_capability_unsupported", message: String(error) }, 422);
      }
      throw error;
    }
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
    const requestedActorType = pendingApproval.actorType;
    if (!["human", "operator", "supervisor"].includes(requestedActorType)) {
      return c.json(
        { error: "approval_role_denied", message: "Approval role is not authorized" },
        403,
      );
    }
    const actorType = requestedActorType as "human" | "operator" | "supervisor";
    if (
      actorType === "human" &&
      (auth.principal.authMethod !== "session" ||
        !auth.principal.sessionId ||
        auth.principal.twoFactorRedirect === true)
    ) {
      return c.json(
        {
          error: "interactive_approval_required",
          message: "Human approval requires a verified interactive session",
        },
        403,
      );
    }
    if (
      (actorType === "operator" || actorType === "supervisor") &&
      !auth.principal.roles.includes(actorType)
    ) {
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

  app.post("/v1/execution/attempts/:id/interrupt", async (c) => {
    const auth = await authenticate(c, options.authVerifier, "write");
    if ("response" in auth) return auth.response;
    const store = new ExecutionStore(getDefaultDb().db);
    try {
      const current = await store.getAttempt(c.req.param("id"));
      if (!current) return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
      if (current.organizationId !== auth.principal.organizationId) {
        return c.json({ error: "organization_denied", message: "Organization access denied" }, 403);
      }
      const attempt = await store.requestInterruptAttempt(c.req.param("id"));
      return c.json({ data: attempt });
    } catch (error) {
      if (String(error).includes("not found")) {
        return c.json({ error: "not_found", message: "Agent attempt not found" }, 404);
      }
      if (String(error).includes("has not started")) {
        return c.json({ error: "attempt_not_running", message: String(error) }, 409);
      }
      throw error;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { text: value };
  }
}

function parseExternalActionPlan(value: unknown): {
  connector: string;
  operation: string;
  payload: Record<string, unknown>;
} | null {
  if (
    !isRecord(value) ||
    typeof value.connector !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.connector) ||
    typeof value.operation !== "string" ||
    !/^[a-z][a-z0-9._:-]{0,127}$/.test(value.operation) ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return { connector: value.connector, operation: value.operation, payload: value.payload };
}

const APPROVED_CONNECTOR_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  email: ["send"],
  linkedin: ["send_message"],
  crm: ["create_lead", "update_lead", "book_meeting", "create_proposal", "mark_closed"],
  calendar: ["book"],
  slack: ["post.message"],
};

function isApprovedConnectorOperation(connector: string, operation: string): boolean {
  return APPROVED_CONNECTOR_OPERATIONS[connector]?.includes(operation) === true;
}

function boundedConcurrency(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(32, Math.max(1, Math.floor(value)))
    : fallback;
}

function publicExternalAction(
  action: Awaited<ReturnType<ExecutionStore["claimExternalAction"]>>["action"],
) {
  const { claimOwner: _claimOwner, fingerprint: _fingerprint, ...publicAction } = action;
  return publicAction;
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
