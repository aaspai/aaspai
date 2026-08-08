import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { InMemoryAuthVerifier } from "@aaspai/auth";
import { authPrincipalSchema } from "@aaspai/contracts";
import { closeDefaultDb, eq, executionWorkItems, getDefaultDb, runMigrations } from "@aaspai/db";
import { DependencyScheduler, ExecutionStore } from "@aaspai/execution";
import type { GitRepository, PullRequestProvider } from "@aaspai/git";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiApp } from "./server.js";

const testRoot = resolve("workspace", "m3", "api-governance");
const testDb = join(testRoot, "state.db");
const organizationId = "org_api_governance";
const verifier = new InMemoryAuthVerifier([
  {
    token: "governance-write",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "human_reviewer",
      organizationId,
      apiKeyId: "key_governance",
      roles: ["member"],
      scopes: ["read", "write", "deploy"],
      authMethod: "api_key",
    }),
  },
  {
    token: "governance-session",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "human_reviewer",
      organizationId,
      sessionId: "session_governance",
      roles: ["member"],
      scopes: ["read", "write", "deploy"],
      authMethod: "session",
    }),
  },
  {
    token: "pending-2fa-session",
    principal: authPrincipalSchema.parse({
      protocolVersion: 1,
      userId: "pending_reviewer",
      organizationId,
      sessionId: "session_pending_2fa",
      roles: ["member"],
      scopes: ["read", "write"],
      authMethod: "session",
      twoFactorRedirect: true,
    }),
  },
]);

describe("execution governance API", () => {
  beforeAll(async () => {
    await mkdir(testRoot, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${testDb}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("exposes checker and approval transitions with organization authorization", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      title: "API governed change",
      deliveryMode: "none",
      idempotencyKey: "api-governed-change",
      governance: {
        verification: { required: true, minEvidence: 1 },
        approval: { required: true, actorType: "human" },
      },
    });
    const app = createApiApp({ authVerifier: verifier });
    const schedule = await app.request(`/v1/execution/workflows/${fixture.run.id}/schedule`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({ agentId: "maker", harness: "opencode_local" }),
    });
    expect(schedule.status).toBe(202);
    const scheduleBody = (await schedule.json()) as {
      data: { dispatched: Array<{ attempt: { id: string } }> };
    };
    const attempt = scheduleBody.data.dispatched[0]?.attempt;
    if (!attempt) throw new Error("scheduler did not dispatch governed work");
    await store.completeScheduledAttempt({ attemptId: attempt.id, status: "succeeded" });
    const verification = await store.getVerificationForWorkItem(item.id);
    expect(verification).not.toBeNull();

    const checkerResponse = await app.request(
      `/v1/execution/verifications/${verification?.id}/checker-attempts`,
      {
        method: "POST",
        headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
        body: JSON.stringify({ agentId: "checker", harness: "opencode_local" }),
      },
    );
    expect(checkerResponse.status).toBe(201);
    const checker = (await checkerResponse.json()) as { data: { id: string } };
    await store.startCheckerAttempt(checker.data.id);
    await store.transitionAttempt(checker.data.id, "succeeded");
    await store.createArtifact({
      id: "test-result",
      organizationId,
      attemptId: checker.data.id,
      kind: "test_result",
      path: "test-result.json",
      mediaType: "application/json",
      sizeBytes: 2,
      sha256: "0".repeat(64),
    });
    const submit = await app.request(`/v1/execution/verifications/${verification?.id}/submit`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({
        checkerAttemptId: checker.data.id,
        status: "passed",
        summary: "verified",
        evidenceIds: ["test-result"],
      }),
    });
    expect(submit.status).toBe(200);
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    const apiKeyDecision = await app.request(`/v1/execution/approvals/${approval?.id}/decision`, {
      method: "POST",
      headers: { authorization: "Bearer governance-write", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: "not interactive" }),
    });
    expect(apiKeyDecision.status).toBe(403);
    const pendingTwoFactor = await app.request(`/v1/execution/approvals/${approval?.id}/decision`, {
      method: "POST",
      headers: { cookie: "pending-2fa-session", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: "2FA pending" }),
    });
    expect(pendingTwoFactor.status).toBe(403);
    const decision = await app.request(`/v1/execution/approvals/${approval?.id}/decision`, {
      method: "POST",
      headers: { cookie: "governance-session", "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: "reviewed" }),
    });
    expect(decision.status).toBe(200);
    await expect(store.getWorkItem(item.id)).resolves.toMatchObject({ status: "completed" });
  });

  it("executes one connector request and replays duplicate external actions", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      workKind: "external_action",
      deliveryMode: "none",
      title: "Post governed notification",
      idempotencyKey: "api-external-action",
      metadata: {
        externalAction: {
          connector: "slack",
          operation: "post.message",
          payload: { text: "hello" },
        },
      },
      governance: { approval: { required: true, actorType: "human" } },
    });
    await new DependencyScheduler(store).run(
      {
        organizationId,
        goalId: fixture.lineage.goalId,
        workflowRunId: fixture.run.id,
        agentId: "maker",
        harness: "opencode_local",
      },
      async () => "succeeded",
    );
    const approval = (await store.listApprovalsForWorkItem(item.id))[0];
    if (!approval) throw new Error("Approval was not created");
    await store.decideApproval({
      approvalId: approval.id,
      actorId: "human_reviewer",
      actorType: "human",
      status: "approved",
    });

    const previousEndpoint = process.env.AASPAI_CONNECTOR_SLACK_URL;
    process.env.AASPAI_CONNECTOR_SLACK_URL = "https://connector.example.test/action";
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = createApiApp({ authVerifier: verifier });
    const request = () =>
      app.request(`/v1/execution/work-items/${item.id}/external-actions`, {
        method: "POST",
        headers: { cookie: "governance-session", "content-type": "application/json" },
        body: JSON.stringify({
          connector: "slack",
          operation: "post.message",
          payload: { text: "hello" },
          idempotencyKey: "send-notification",
        }),
      });
    try {
      const firstRequest = request();
      for (let index = 0; index < 20 && fetchMock.mock.calls.length === 0; index++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const duplicate = await request();
      expect(duplicate.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      resolveFetch?.(new Response('{"messageId":"1"}', { status: 200 }));
      expect((await firstRequest).status).toBe(200);
      const replay = await request();
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({ duplicate: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      if (previousEndpoint === undefined) delete process.env.AASPAI_CONNECTOR_SLACK_URL;
      else process.env.AASPAI_CONNECTOR_SLACK_URL = previousEndpoint;
    }
  });

  it("does not execute a completed external action without approved human evidence", async () => {
    const handle = getDefaultDb();
    const store = new ExecutionStore(handle.db);
    const fixture = await createFixture(store);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      workKind: "external_action",
      deliveryMode: "none",
      title: "Legacy completed notification",
      idempotencyKey: "external-action-without-approval",
      metadata: {
        externalAction: {
          connector: "slack",
          operation: "post.message",
          payload: { text: "hello" },
        },
      },
      governance: { approval: { required: true, actorType: "human" } },
    });
    await handle.db
      .update(executionWorkItems)
      .set({ status: "completed" })
      .where(eq(executionWorkItems.id, item.id));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await createApiApp({ authVerifier: verifier }).request(
        `/v1/execution/work-items/${item.id}/external-actions`,
        {
          method: "POST",
          headers: { cookie: "governance-session", "content-type": "application/json" },
          body: JSON.stringify({
            connector: "slack",
            operation: "post.message",
            payload: { text: "hello" },
            idempotencyKey: "unapproved-send",
          }),
        },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "approval_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects connector operations outside the approved outbound set", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const fixture = await createFixture(store);
    const app = createApiApp({ authVerifier: verifier });
    const response = await app.request("/v1/execution/work-items", {
      method: "POST",
      headers: { cookie: "governance-session", "content-type": "application/json" },
      body: JSON.stringify({
        ...fixture.lineage,
        title: "Unapproved outbound action",
        idempotencyKey: "unapproved-outbound-action",
        workKind: "external_action",
        deliveryMode: "none",
        externalAction: {
          connector: "shell",
          operation: "execute",
          payload: { command: "send" },
        },
        governance: { approval: { required: true, actorType: "human" } },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "connector_denied" });
  });

  it("pushes the verified commit SHA and reconciles an existing pull request", async () => {
    const store = new ExecutionStore(getDefaultDb().db);
    const fixture = await createFixture(store);
    const commitSha = "a".repeat(40);
    const item = await store.createWorkItem({
      ...fixture.lineage,
      deliveryMode: "pull_request",
      title: "Deliver immutable change",
      idempotencyKey: `api-pr-delivery:${randomUUID()}`,
    });
    await new DependencyScheduler(store).run(
      {
        organizationId,
        goalId: fixture.lineage.goalId,
        workflowRunId: fixture.run.id,
        agentId: "maker",
        harness: "opencode_local",
      },
      async ({ attempt }) => {
        await store.recordDeliveryCommit(item.id, attempt.id, commitSha, "worker/pr-delivery");
        return "succeeded";
      },
    );
    const push = vi.fn(async () => undefined);
    const create = vi.fn();
    const find = vi.fn(async () => ({
      number: 7,
      url: "https://github.com/example/project/pull/7",
      state: "open" as const,
      head: "worker/pr-delivery",
      base: "main",
    }));
    const app = createApiApp({
      authVerifier: verifier,
      git: { push } as unknown as GitRepository,
      pullRequestProvider: { create, find } as unknown as PullRequestProvider,
    });
    const response = await app.request(`/v1/execution/work-items/${item.id}/deliver`, {
      method: "POST",
      headers: { cookie: "governance-session" },
    });

    expect(response.status).toBe(200);
    expect(push).toHaveBeenCalledWith(
      "workspace/m3/api-governance/project",
      "origin",
      "worker/pr-delivery",
      commitSha,
    );
    expect(find).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});

async function createFixture(store: ExecutionStore) {
  const goal = await store.createGoal({ organizationId, title: "API governance goal" });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "API governance project",
  });
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: "workspace/m3/api-governance/project",
    remoteUrl: "example/project",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: "abcdef1",
    sourcePath: ".",
    contentHash: "api-governance-fixture",
  });
  const run = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    idempotencyKey: `api-governance-run:${randomUUID()}`,
  });
  return {
    run,
    lineage: {
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
    },
  };
}
