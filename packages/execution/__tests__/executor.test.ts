import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomousWorkExecutor } from "../src/executor";
import { ExecutionStore } from "../src/store";

describe("AutonomousWorkExecutor heartbeat", () => {
  let close: (() => Promise<void>) | undefined;
  let testDirectory: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await close?.();
    delete process.env.AASPAI_DB;
    if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
  });

  it("awaits an in-flight heartbeat and stops it before terminal completion", async () => {
    testDirectory = path.resolve("workspace", "m2", `executor-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    const handle = createDb();
    close = handle.close;
    runMigrations(handle);
    const store = new ExecutionStore(handle.db);
    const organizationId = "org_executor_heartbeat";
    const goal = await store.createGoal({ organizationId, title: "Long-running goal" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Long-running project",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: testDirectory,
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: ".",
      contentHash: "executor-heartbeat",
    });
    const run = await store.createWorkflowRun({
      organizationId,
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "run:executor-heartbeat",
    });
    const workItem = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: run.id,
      deliveryMode: "none",
      title: "Run for hours",
      idempotencyKey: "work:executor-heartbeat",
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const provider = deferred<"succeeded">();
    const providerStarted = deferred<void>();
    const pendingHeartbeat = deferred<boolean>();
    const realHeartbeat = store.heartbeatAttempt.bind(store);
    let heartbeatCalls = 0;
    vi.spyOn(store, "heartbeatAttempt").mockImplementation((attemptId, leaseMs) => {
      heartbeatCalls++;
      return heartbeatCalls === 2 ? pendingHeartbeat.promise : realHeartbeat(attemptId, leaseMs);
    });

    const execution = new AutonomousWorkExecutor(store).execute({
      organizationId,
      workflowRunId: run.id,
      workItemId: workItem.id,
      agentId: "agent_executor",
      harness: "dry_run_local",
      runProvider: async () => {
        providerStarted.resolve();
        return provider.promise;
      },
    });
    await providerStarted.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatCalls).toBe(2);

    let completed = false;
    const observed = execution.then((result) => {
      completed = true;
      return result;
    });
    provider.resolve("succeeded");
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);

    pendingHeartbeat.resolve(true);
    await expect(observed).resolves.toMatchObject({ attempt: { status: "succeeded" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatCalls).toBe(2);
  });

  it("retries with a new attempt and session when session completion outlives attempt settlement", async () => {
    testDirectory = path.resolve("workspace", "m2", `executor-recovery-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    const handle = createDb();
    close = handle.close;
    runMigrations(handle);
    const store = new ExecutionStore(handle.db);
    const organizationId = "org_executor_recovery";
    const goal = await store.createGoal({ organizationId, title: "Recover execution" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Recovery project",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: testDirectory,
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: ".",
      contentHash: "executor-recovery",
    });
    const run = await store.createWorkflowRun({
      organizationId,
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "run:executor-recovery",
    });
    const workItem = await store.createWorkItem({
      organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: run.id,
      deliveryMode: "none",
      title: "Retry after settlement crash",
      idempotencyKey: "work:executor-recovery",
      maxAttempts: 2,
    });
    const dispatched = await store.dispatchWorkItem({
      workflowRunId: run.id,
      workItemId: workItem.id,
      agentId: "agent_executor",
      harness: "dry_run_local",
    });
    expect(dispatched).not.toBeNull();
    const staleAttempt = await store.startScheduledAttempt(dispatched?.attempt.id ?? "missing");
    const staleSession = await store.createHarnessSession({
      id: "session_before_settlement_crash",
      organizationId,
      agentId: staleAttempt.agentId,
      adapter: staleAttempt.harness,
      prompt: "first execution",
    });
    await store.linkHarnessSession(staleAttempt.id, staleSession.id);
    await store.setHarnessSessionProviderIdentity(staleSession.id, "provider_before_crash");
    await store.appendHarnessSessionEvent({
      sessionId: staleSession.id,
      kind: "assistant",
      payload: { text: "durable first execution" },
      seq: 1,
    });
    await store.completeHarnessSession(
      staleSession.id,
      {
        protocolVersion: 1,
        sessionId: "provider_before_crash",
        exitCode: 1,
        timedOut: false,
        usageBasis: "per_run",
        clearSession: false,
        summary: "provider failed before attempt settlement",
      },
      "failed",
    );

    let retrySessionId = "";
    const result = await new AutonomousWorkExecutor(store).execute({
      organizationId,
      workflowRunId: run.id,
      workItemId: workItem.id,
      agentId: staleAttempt.agentId,
      harness: staleAttempt.harness,
      attempt: staleAttempt,
      runProvider: async ({ attempt }) => {
        expect(attempt.id).not.toBe(staleAttempt.id);
        const retrySession = await store.createHarnessSession({
          id: staleSession.id,
          organizationId,
          agentId: attempt.agentId,
          adapter: attempt.harness,
          prompt: "retry execution",
        });
        retrySessionId = retrySession.id;
        expect(retrySession).toMatchObject({
          parentSessionId: staleSession.id,
          inheritedProviderSessionId: "provider_before_crash",
        });
        await store.linkHarnessSession(attempt.id, retrySession.id);
        await store.appendHarnessSessionEvent({
          sessionId: retrySession.id,
          kind: "assistant",
          payload: { text: "durable retry execution" },
          seq: 1,
        });
        return "succeeded";
      },
    });

    expect(result.attempt).toMatchObject({ status: "succeeded", attemptNumber: 2 });
    await expect(store.getAttempt(staleAttempt.id)).resolves.toMatchObject({ status: "failed" });
    await expect(store.getHarnessSession(staleSession.id)).resolves.toMatchObject({
      status: "failed",
      sessionId: "provider_before_crash",
    });
    expect(
      (await store.listHarnessSessionEvents(staleSession.id)).map((event) => event.seq),
    ).toEqual([1]);
    expect(
      (await store.listHarnessSessionEvents(retrySessionId)).map((event) => event.seq),
    ).toEqual([1]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
