import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerDaemon } from "../src/daemon.js";

vi.mock("@aaspai/observability", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

let sessionExecute: ReturnType<typeof vi.fn>;
vi.mock("@aaspai/sessions", () => {
  sessionExecute = vi.fn().mockResolvedValue({
    status: "completed",
    output: "ok",
    sessionId: "sess_test",
  });
  return {
    Sessions: class {
      execute = sessionExecute;
    },
  };
});

async function setupDb(): Promise<{
  tmpDir: string;
  wakeupsTable: unknown;
  handle: {
    db: {
      insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
      select: () => { from: (t: unknown) => { all: () => Promise<unknown[]> } };
    };
  };
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), "aaspai-reliability-"));
  process.env.AASPAI_DB = `sqlite:${join(tmpDir, "state.db")}`;
  const { getDefaultDb, runMigrations, wakeups } = await import("@aaspai/db");
  const handle = getDefaultDb();
  runMigrations(handle);
  return { tmpDir, wakeupsTable: wakeups, handle: handle as never };
}

async function teardownDb(tmpDir: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const { closeDefaultDb } = await import("@aaspai/db");
      await closeDefaultDb();
      break;
    } catch {
      /* try again */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 50));
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  vi.resetModules();
}

it("gives delegated agents exact durable context without platform archaeology", async () => {
  const { contextualizeDelegatedPrompt } = await import("../src/daemon.js");
  const prompt = contextualizeDelegatedPrompt("Do the assigned work.", "agent/growth-manager", {
    id: "work/growth",
    projectId: "project/growth",
    parentWorkItemId: "work/ceo",
    metadata: {
      requiredCompanyActions: [
        { type: "create_milestone", projectId: "project/growth" },
        { type: "define_and_start_process", projectId: "project/growth" },
      ],
      declaredArtifacts: [{ path: "artifacts/result.md", kind: "other" }],
      evidencePolicy: { citationPaths: ["artifacts/result.md"] },
    },
  });

  expect(prompt).toContain("Your agent ID: agent/growth-manager");
  expect(prompt).toContain("Project ID: project/growth");
  expect(prompt).toContain('"type":"create_milestone"');
  expect(prompt).toContain("artifacts/result.md");
  expect(prompt).toContain("Do not execute specialist research");
  expect(prompt).toContain("AASPAI source code");
  expect(prompt).toContain("state database");
});

async function insertQueued(
  handle: { db: { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } } },
  wakeupsTable: unknown,
  id: string,
  reason: string,
  organizationId = "org_test",
): Promise<void> {
  await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
    id,
    organizationId,
    loopId: "loop_daily_triage",
    source: "test",
    agentId: "operator",
    reason,
    payloadJson: JSON.stringify({ agentId: "operator", prompt: "do it" }),
    status: "queued",
    requestedAt: new Date().toISOString(),
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
  });
}

describe("WorkerDaemon atomic claim (issue #2 reinforcement)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sessionExecute = vi
      .fn()
      .mockResolvedValue({ status: "completed", output: "ok", sessionId: "sess_test" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not claim a wakeup that is already claimed by another worker", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "race test");

    // Pre-claim it (simulating another worker having claimed first)
    const { wakeups } = await import("@aaspai/db");
    const db = (await import("@aaspai/db")).getDefaultDb();
    await db.db
      .update(wakeups)
      .set({ status: "claimed", claimedAt: new Date().toISOString() } as never)
      .where((await import("drizzle-orm")).eq(wakeups.id, wakeupId));

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await daemon.claimAndRun(wakeupId);

    // Should NOT have called sessions.execute — the wakeup was already claimed
    expect(sessionExecute).not.toHaveBeenCalled();
    await teardownDb(tmpDir);
  });

  it("does not claim a wakeup owned by another organization", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "foreign tenant", "org_other");

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).not.toHaveBeenCalled();
    const { wakeups } = await import("@aaspai/db");
    const db = (await import("@aaspai/db")).getDefaultDb();
    const rows = await (
      db.db.select().from(wakeups) as {
        all: () => Promise<Array<{ id: string; status: string }>>;
      }
    ).all();
    expect(rows.find((row) => row.id === wakeupId)?.status).toBe("queued");
    await teardownDb(tmpDir);
  });

  it("honors the queued adapter, runtime, and durable session identity", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    const sessionId = `sess_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "manual",
      source: "api",
      agentId: "operator",
      payloadJson: JSON.stringify({
        agentId: "operator",
        prompt: "do it",
        adapter: "claude_local",
        runtime: { kind: "local", envPassthrough: false },
        sessionId,
      }),
      status: "queued",
      requestedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test" });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "claude_local",
        runtime: { kind: "local", envPassthrough: false },
        durableSessionId: sessionId,
      }),
    );
    await teardownDb(tmpDir);
  });

  it("acknowledges company command notifications without creating agent work", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop/company-control/org-test",
      source: "on_demand",
      agentId: "agent/ceo",
      payloadJson: JSON.stringify({ command: "create_milestone" }),
      status: "queued",
      requestedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test" });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).not.toHaveBeenCalled();
    const { wakeups } = await import("@aaspai/db");
    const rows = await (
      (await import("@aaspai/db")).getDefaultDb().db.select().from(wakeups) as {
        all: () => Promise<Array<{ id: string; status: string }>>;
      }
    ).all();
    expect(rows.find((row) => row.id === wakeupId)?.status).toBe("completed");
    await teardownDb(tmpDir);
  });

  it("recovers missed prompted company work into one durable agent attempt", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    const notificationId = `wup_${randomUUID()}`;
    const legacyCompletedId = `wup_${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values([
      {
        id: wakeupId,
        organizationId: "org_test",
        loopId: "loop/company-control/org-test",
        source: "on_demand",
        agentId: "agent/ceo",
        payloadJson: JSON.stringify({
          command: "activate_company",
          adapter: "dry_run_local",
          prompt: "Staff the approved projects.",
          requiredCompanyActions: [{ type: "hire_and_delegate", projectId: "project/growth" }],
        }),
        status: "completed",
        finishedAt: requestedAt,
        requestedAt,
        idempotencyKey: randomUUID(),
      },
      {
        id: notificationId,
        organizationId: "org_test",
        loopId: "loop/company-control/org-test",
        source: "on_demand",
        agentId: "agent/ceo",
        payloadJson: JSON.stringify({ command: "create_milestone" }),
        status: "completed",
        finishedAt: requestedAt,
        requestedAt,
        idempotencyKey: randomUUID(),
      },
      {
        id: legacyCompletedId,
        organizationId: "org_test",
        loopId: "loop/company-control/org-test",
        source: "on_demand",
        agentId: "agent/ceo",
        payloadJson: JSON.stringify({
          command: "activate_company",
          prompt: "Already executed by the legacy session.",
        }),
        status: "completed",
        sessionId: "sess_legacy_completed",
        finishedAt: requestedAt,
        requestedAt,
        idempotencyKey: randomUUID(),
      },
    ]);

    const { WorkerDaemon } = await import("../src/daemon.js");
    const { ExecutionStore } = await import("@aaspai/execution");
    const { wakeups } = await import("@aaspai/db");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    const executeDurableAttempt = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      exitCode: 0,
      timedOut: false,
      summary: "Staffed the approved projects.",
      usageBasis: "per_run",
      clearSession: false,
    });
    daemon.setLegacySessionExecutorForTests(undefined);
    daemon.setDurableAttemptExecutorForTests(executeDurableAttempt);

    await daemon.recoverMissedExecutableWakeups();
    let rows = await handle.db.select().from(wakeups);
    expect(rows.find((row) => row.id === wakeupId)?.status).toBe("queued");
    expect(rows.find((row) => row.id === notificationId)?.status).toBe("completed");
    expect(rows.find((row) => row.id === legacyCompletedId)?.status).toBe("completed");

    await daemon.claimAndRun(wakeupId);

    const store = new ExecutionStore(handle.db as never);
    await expect(store.getWorkflowRun(`run:wakeup:${wakeupId}`)).resolves.toMatchObject({
      sourceType: "wakeup",
      sourceId: wakeupId,
    });
    await expect(store.getWorkItem(`work:wakeup:${wakeupId}`)).resolves.toMatchObject({
      status: "completed",
      workKind: "general",
      deliveryMode: "none",
      metadata: {
        requiredCompanyActions: [{ type: "hire_and_delegate", projectId: "project/growth" }],
      },
    });
    expect(await store.listAttemptsForWorkItem(`work:wakeup:${wakeupId}`)).toHaveLength(1);
    expect(executeDurableAttempt).toHaveBeenCalledTimes(1);

    await daemon.recoverMissedExecutableWakeups();
    rows = await handle.db.select().from(wakeups);
    expect(rows.find((row) => row.id === wakeupId)?.status).toBe("completed");
    expect(executeDurableAttempt).toHaveBeenCalledTimes(1);
    await teardownDb(tmpDir);
  });

  it("retries failed CEO discovery in a new durable session and applies the proposal", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop/company-control/org-test",
      source: "on_demand",
      agentId: "agent/ceo",
      payloadJson: JSON.stringify({
        command: "start_discovery",
        adapter: "dry_run_local",
        prompt: "Propose the smallest useful project portfolio.",
      }),
      status: "queued",
      requestedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    const { ExecutionStore } = await import("@aaspai/execution");
    const store = new ExecutionStore(handle.db as never);
    const executions: Array<{
      attemptNumber: number;
      wakeupId?: string;
      durableSessionId?: string;
      resumeSessionId?: string;
    }> = [];
    const executeDurableAttempt = vi.fn(
      async (input: Parameters<WorkerDaemon["executeDurableAttempt"]>[0]) => {
        executions.push({
          attemptNumber: input.attempt.attemptNumber,
          wakeupId: input.wakeupId,
          durableSessionId: input.durableSessionId,
          resumeSessionId: input.resumeSessionId,
        });
        const result = {
          protocolVersion: 1,
          timedOut: false,
          exitCode: 0,
          summary: 'AASPAI_PORTFOLIO_PROPOSAL={"summary":"Start with one project","projects":[]}',
          sessionId: "provider_discovery",
          usageBasis: "per_run" as const,
          clearSession: false,
        };
        const session = await store.createHarnessSession({
          id: input.durableSessionId,
          organizationId: "org_test",
          agentId: input.agentId,
          adapter: input.adapter,
          prompt: input.prompt,
          wakeupId: input.wakeupId,
        });
        await store.linkHarnessSession(input.attempt.id, session.id);
        await store.setHarnessSessionProviderIdentity(session.id, result.sessionId);
        let completedResult:
          | typeof result
          | (typeof result & { errorCode: string; errorMessage: string });
        try {
          await input.beforeAttemptCompletion?.(result, session.id);
          completedResult = result;
        } catch (error) {
          completedResult = {
            ...result,
            exitCode: 1,
            errorCode: "evidence_persistence_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          };
        }
        await store.completeHarnessSession(
          session.id,
          completedResult,
          completedResult.exitCode === 0 ? "succeeded" : "failed",
        );
        return completedResult;
      },
    );
    daemon.setLegacySessionExecutorForTests(undefined);
    daemon.setDurableAttemptExecutorForTests(executeDurableAttempt);
    daemon.applyDiscoveryProposal = vi
      .fn()
      .mockRejectedValueOnce(new Error("proposal references an unavailable company goal"))
      .mockResolvedValueOnce(undefined);

    await daemon.claimAndRun(wakeupId);

    const { agentAttempts, executionWorkItems, sessions, wakeups } = await import("@aaspai/db");
    const rows = await (
      (await import("@aaspai/db")).getDefaultDb().db.select().from(executionWorkItems) as {
        all: () => Promise<
          Array<{
            id: string;
            workKind: string;
            deliveryMode: string;
            maxAttempts: number;
            status: string;
          }>
        >;
      }
    ).all();
    expect(rows.find((row) => row.id === `work:wakeup:${wakeupId}`)).toMatchObject({
      workKind: "general",
      deliveryMode: "none",
      maxAttempts: 3,
      status: "ready",
    });
    const queuedWakeups = await handle.db.select().from(wakeups);
    const retryWakeup = queuedWakeups.find((row) => row.triggerDetail === "attempt-retry");
    expect(retryWakeup?.status).toBe("queued");
    const retryPayload = JSON.parse(String(retryWakeup?.payloadJson)) as Record<string, unknown>;
    expect(retryPayload).toMatchObject({
      command: "start_discovery",
      workItemId: `work:wakeup:${wakeupId}`,
      workflowRunId: `run:wakeup:${wakeupId}`,
      resumeSessionId: "provider_discovery",
    });
    const firstAttempt = (await handle.db.select().from(agentAttempts)).find(
      (attempt) => attempt.attemptNumber === 1,
    );
    const retrySession = (await handle.db.select().from(sessions)).find(
      (session) => session.wakeupId === retryWakeup?.id,
    );
    expect(retrySession?.parentSessionId).toBe(firstAttempt?.harnessSessionId);

    await daemon.claimAndRun(retryWakeup?.id ?? "missing");

    expect(executions).toHaveLength(2);
    expect(executions[0]?.wakeupId).toBe(wakeupId);
    expect(executions[1]).toMatchObject({
      attemptNumber: 2,
      wakeupId: retryWakeup?.id,
      durableSessionId: retrySession?.id,
      resumeSessionId: "provider_discovery",
    });
    await expect(store.getWorkItem(`work:wakeup:${wakeupId}`)).resolves.toMatchObject({
      status: "completed",
    });
    expect(await store.listAttemptsForWorkItem(`work:wakeup:${wakeupId}`)).toHaveLength(2);
    expect(daemon.applyDiscoveryProposal).toHaveBeenCalledTimes(2);
    expect(daemon.applyDiscoveryProposal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "start_discovery" }),
      expect.stringContaining("AASPAI_PORTFOLIO_PROPOSAL="),
      firstAttempt?.harnessSessionId,
      `work:wakeup:${wakeupId}`,
    );
    expect(daemon.applyDiscoveryProposal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "start_discovery" }),
      expect.stringContaining("AASPAI_PORTFOLIO_PROPOSAL="),
      retrySession?.id,
      `work:wakeup:${wakeupId}`,
    );
    expect(
      (await handle.db.select().from(wakeups)).find((row) => row.id === retryWakeup?.id),
    ).toMatchObject({ status: "completed" });
    await teardownDb(tmpDir);
  });
});

describe("WorkerDaemon in-flight guard (issue #4)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sessionExecute = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ status: "completed", output: "ok", sessionId: "sess_test" }), 200),
          ),
      );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("drops a pollWakeups call when a session is still in flight", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const w1 = `wup_${randomUUID()}`;
    const w2 = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, w1, "first");
    await insertQueued(handle, wakeupsTable, w2, "second");

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });

    const first = daemon.pollWakeups();
    // While the first is in flight (session is 200ms), fire a second tick.
    await new Promise((r) => setTimeout(r, 20));
    const second = daemon.pollWakeups();

    await Promise.all([first, second]);

    // Only the first session should have been executed; the second
    // was dropped by the in-flight guard, so w2 stays queued.
    expect(sessionExecute).toHaveBeenCalledTimes(1);
    const { wakeups } = await import("@aaspai/db");
    const db = (await import("@aaspai/db")).getDefaultDb();
    const rows = await (
      db.db.select().from(wakeups) as { all: () => Promise<Array<{ id: string; status: string }>> }
    ).all();
    const w2row = rows.find((r) => r.id === w2);
    expect(w2row?.status).toBe("queued");

    await teardownDb(tmpDir);
  });
});

describe("WorkerDaemon retry-with-backoff (reliability hardening)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("retries transient errors and gives up after 3 attempts with reason 'exhausted retries'", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "transient fail");

    const { WorkerDaemon } = await import("../src/daemon.js");
    sessionExecute = vi.fn().mockRejectedValue(new Error("adapter timeout"));
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).toHaveBeenCalledTimes(3);
    const { wakeups } = await import("@aaspai/db");
    const db = (await import("@aaspai/db")).getDefaultDb();
    const rows = await (
      db.db.select().from(wakeups) as {
        all: () => Promise<Array<{ id: string; status: string; error: string | null }>>;
      }
    ).all();
    const row = rows.find((r) => r.id === wakeupId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/exhausted retries/);

    await teardownDb(tmpDir);
  });

  it("does not mark a resolved failed session as a completed wakeup", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "provider reports failure");
    const { WorkerDaemon } = await import("../src/daemon.js");
    sessionExecute = vi
      .fn()
      .mockResolvedValue({ status: "failed", output: "", sessionId: "sess_failed" });
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).toHaveBeenCalledTimes(3);
    const { wakeups } = await import("@aaspai/db");
    const rows = await (
      (await import("@aaspai/db")).getDefaultDb().db.select().from(wakeups) as {
        all: () => Promise<Array<{ id: string; status: string; error: string | null }>>;
      }
    ).all();
    expect(rows.find((row) => row.id === wakeupId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/exhausted retries/),
    });

    await teardownDb(tmpDir);
  });

  it("succeeds on the 2nd attempt without marking as failed", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "transient fail then ok");

    const { WorkerDaemon } = await import("../src/daemon.js");
    let calls = 0;
    sessionExecute = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return { status: "completed", output: "ok", sessionId: "sess_test" };
    });
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await daemon.claimAndRun(wakeupId);

    expect(sessionExecute).toHaveBeenCalledTimes(2);
    const { wakeups } = await import("@aaspai/db");
    const db = (await import("@aaspai/db")).getDefaultDb();
    const rows = await (
      db.db.select().from(wakeups) as {
        all: () => Promise<Array<{ id: string; status: string; error: string | null }>>;
      }
    ).all();
    const row = rows.find((r) => r.id === wakeupId);
    expect(row?.status).toBe("completed");

    await teardownDb(tmpDir);
  });
});

describe("WorkerDaemon graceful shutdown", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("stop() awaits the in-flight session before closing the DB", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "shutdown during");

    let resolveSession!: (v: { status: string; output: string; sessionId: string }) => void;
    sessionExecute = vi.fn().mockImplementation(
      () =>
        new Promise<{ status: string; output: string; sessionId: string }>((r) => {
          resolveSession = r;
        }),
    );

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });

    // Start a poll (which fires off an in-flight session)
    const pollPromise = daemon.pollWakeups();
    await new Promise((r) => setTimeout(r, 50));

    // session.execute is hanging. stop() should NOT complete until
    // the session resolves.
    const stopPromise = daemon.stop();
    let stopCompleted = false;
    void stopPromise.then(() => {
      stopCompleted = true;
    });

    // Confirm stop() is blocked on the in-flight session
    await new Promise((r) => setTimeout(r, 100));
    expect(stopCompleted).toBe(false);

    // Now resolve the session; stop() should now complete
    resolveSession({ status: "completed", output: "ok", sessionId: "sess_test" });
    await stopPromise;
    expect(stopCompleted).toBe(true);
    await pollPromise;

    await teardownDb(tmpDir);
  });
});
