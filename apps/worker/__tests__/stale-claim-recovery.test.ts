import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@aaspai/observability", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

vi.mock("@aaspai/sessions", () => ({
  Sessions: class {
    execute = vi.fn().mockRejectedValue(new Error("session exploded"));
  },
}));

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
  const tmpDir = mkdtempSync(join(tmpdir(), "aaspai-recover-"));
  process.env.AASPAI_DB = `sqlite:${join(tmpDir, "state.db")}`;
  const { getDefaultDb, runMigrations, wakeups } = await import("@aaspai/db");
  const handle = getDefaultDb();
  runMigrations(handle);
  return { tmpDir, wakeupsTable: wakeups, handle: handle as never };
}

async function teardownDb(tmpDir: string): Promise<void> {
  try {
    const { closeDefaultDb } = await import("@aaspai/db");
    await closeDefaultDb();
  } catch {
    /* best effort */
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
}

describe("WorkerDaemon stale-claim recovery (issue #3)", () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
  });

  it("recovers only claims without a fresh wakeup heartbeat", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();

    const oldClaimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const freshClaimedAt = new Date(Date.now() - 30_000).toISOString();

    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: `wup_${randomUUID()}`,
      organizationId: "org_test",
      loopId: "loop_daily_triage",
      source: "test",
      reason: "test stale",
      payloadJson: JSON.stringify({ agentId: "operator", prompt: "do it" }),
      status: "claimed",
      claimedAt: oldClaimedAt,
      requestedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      idempotencyKey: randomUUID(),
      createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: `wup_${randomUUID()}`,
      organizationId: "org_test",
      loopId: "loop_daily_triage",
      source: "test",
      reason: "test fresh",
      payloadJson: JSON.stringify({ agentId: "operator", prompt: "do it" }),
      status: "claimed",
      claimedAt: freshClaimedAt,
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: randomUUID(),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: `wup_${randomUUID()}`,
      organizationId: "org_test",
      loopId: "loop_daily_triage",
      source: "test",
      reason: "test heartbeat",
      payloadJson: JSON.stringify({ agentId: "operator", prompt: "long work" }),
      status: "claimed",
      claimedAt: oldClaimedAt,
      heartbeatAt: freshClaimedAt,
      requestedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      idempotencyKey: randomUUID(),
      createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const { ExecutionStore } = await import("@aaspai/execution");
    await expect(
      new ExecutionStore(handle.db as never).countStaleClaimedWakeups(
        new Date(Date.now() - 5 * 60_000).toISOString(),
        "org_test",
      ),
    ).resolves.toBe(1);
    const daemon = new WorkerDaemon({
      organizationId: "org_test",
      workspaceRoot: tmpDir,
    });
    await (daemon as unknown as { recoverStaleClaims(): Promise<void> }).recoverStaleClaims();

    const all = await (
      handle.db.select().from(wakeupsTable) as {
        all: () => Promise<Array<{ reason: string; status: string; error: string | null }>>;
      }
    ).all();
    const stale = all.find((w) => w.reason === "test stale");
    const fresh = all.find((w) => w.reason === "test fresh");
    const heartbeat = all.find((w) => w.reason === "test heartbeat");
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toMatch(/stale claim/);
    expect(fresh?.status).toBe("claimed");
    expect(heartbeat?.status).toBe("claimed");

    await teardownDb(tmpDir);
  });

  it("does not terminalize a wakeup whose heartbeat wins the recovery race", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop_daily_triage",
      source: "test",
      reason: "heartbeat race",
      payloadJson: "{}",
      status: "claimed",
      claimedAt: staleAt,
      heartbeatAt: staleAt,
      requestedAt: staleAt,
      idempotencyKey: randomUUID(),
    });

    const { eq, getDefaultDb, wakeups } = await import("@aaspai/db");
    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    const privateDaemon = daemon as unknown as {
      recoverStaleClaims(): Promise<void>;
      markFailed(
        id: string,
        reason: string,
        snapshot?: { claimedAt: string | null; heartbeatAt: string | null },
      ): Promise<boolean>;
    };
    const markFailed = privateDaemon.markFailed.bind(daemon);
    privateDaemon.markFailed = async (id, reason, snapshot) => {
      await getDefaultDb()
        .db.update(wakeups)
        .set({ heartbeatAt: new Date().toISOString() })
        .where(eq(wakeups.id, id));
      return markFailed(id, reason, snapshot);
    };

    await privateDaemon.recoverStaleClaims();

    const [row] = await getDefaultDb().db.select().from(wakeups).where(eq(wakeups.id, wakeupId));
    expect(row?.status).toBe("claimed");
    expect(row?.heartbeatAt).not.toBe(staleAt);
    await teardownDb(tmpDir);
  });

  it("queues a failed attempt with its provider session and verification feedback", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop/company-control/org_test",
      source: "system",
      agentId: "agent/manager",
      reason: "execute delegated work",
      payloadJson: JSON.stringify({ prompt: "Build the sales playbook" }),
      status: "completed",
      requestedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });
    const rows = await (
      handle.db.select().from(wakeupsTable) as { all: () => Promise<Record<string, unknown>[]> }
    ).all();
    const source = rows.find((row) => row.id === wakeupId);
    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await (
      daemon as unknown as {
        queueRetryWakeup(
          wakeup: Record<string, unknown>,
          request: Record<string, unknown>,
          attemptNumber: number,
          retry: { resumeSessionId?: string; failure?: string },
        ): Promise<void>;
      }
    ).queueRetryWakeup(
      source ?? {},
      {
        prompt: "Build the sales playbook",
        workItemId: "work_test",
        workflowRunId: "run_test",
      },
      2,
      {
        resumeSessionId: "provider_session_123",
        failure: "Unsupported commercial or security claim in sales-playbook.md",
      },
    );

    const queued = (
      await (
        handle.db.select().from(wakeupsTable) as { all: () => Promise<Record<string, unknown>[]> }
      ).all()
    ).find((row) => row.triggerDetail === "attempt-retry");
    const payload = JSON.parse(String(queued?.payloadJson)) as Record<string, unknown>;
    expect(payload.resumeSessionId).toBe("provider_session_123");
    expect(payload.prompt).toContain("previous attempt did not pass execution verification");
    expect(payload.prompt).toContain("Unsupported commercial or security claim");

    await (
      daemon as unknown as {
        queueRetryWakeup(
          wakeup: Record<string, unknown>,
          request: Record<string, unknown>,
          attemptNumber: number,
          retry: { resumeSessionId?: string; failure?: string },
        ): Promise<void>;
      }
    ).queueRetryWakeup(
      source ?? {},
      {
        prompt: "Build the sales playbook",
        workItemId: "work_test",
        workflowRunId: "run_test",
        resumeSessionId: "broken_provider_session",
      },
      3,
      { failure: "Provider session failed" },
    );
    const freshPayload = JSON.parse(
      String(
        (
          await (
            handle.db.select().from(wakeupsTable) as {
              all: () => Promise<Record<string, unknown>[]>;
            }
          ).all()
        ).find((row) => row.idempotencyKey === "retry:work_test:3")?.payloadJson,
      ),
    ) as Record<string, unknown>;
    expect(freshPayload.resumeSessionId).toBeUndefined();

    await (
      daemon as unknown as {
        queueRetryWakeup(
          wakeup: Record<string, unknown>,
          request: Record<string, unknown>,
          attemptNumber: number,
          retry: { resumeSessionId?: string; failure?: string },
        ): Promise<void>;
      }
    ).queueRetryWakeup(
      source ?? {},
      {
        prompt: "Review verified delegated work",
        workItemId: "work_test",
        workflowRunId: "run_test",
        resumeSessionId: "required_manager_session",
        resumeWorkspaceId: "workspace_manager",
        mustResumeSession: true,
      },
      4,
      { failure: "Transient provider error" },
    );
    const managerRetryPayload = JSON.parse(
      String(
        (
          await (
            handle.db.select().from(wakeupsTable) as {
              all: () => Promise<Record<string, unknown>[]>;
            }
          ).all()
        ).find((row) => row.idempotencyKey === "retry:work_test:4")?.payloadJson,
      ),
    ) as Record<string, unknown>;
    expect(managerRetryPayload).toMatchObject({
      resumeSessionId: "required_manager_session",
      resumeWorkspaceId: "workspace_manager",
      mustResumeSession: true,
    });

    await teardownDb(tmpDir);
  });

  it("requeues lost delegated work with the persisted provider session", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const { agentAttempts, eq, sessionEvents, sessions, wakeups } = await import("@aaspai/db");
    const { ExecutionStore } = await import("@aaspai/execution");
    const store = new ExecutionStore(handle.db as never);
    const goal = await store.createGoal({ organizationId: "org_test", title: "Grow" });
    const project = await store.createProject({
      organizationId: "org_test",
      goalId: goal.id,
      title: "Growth",
    });
    const repository = await store.createRepository({
      organizationId: "org_test",
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: tmpDir,
    });
    const revision = await store.createDefinitionRevision({
      organizationId: "org_test",
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: tmpDir,
      contentHash: "hash",
    });
    const run = await store.createWorkflowRun({
      organizationId: "org_test",
      goalId: goal.id,
      definitionRevisionId: revision.id,
      idempotencyKey: "run:recovery",
    });
    const work = await store.createWorkItem({
      organizationId: "org_test",
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: run.id,
      title: "Delegated work",
      definitionRevisionId: revision.id,
      idempotencyKey: "work:recovery",
      maxAttempts: 3,
      status: "ready",
    });
    const attempt = await store.createAttempt({
      id: `attempt:wakeup:wakeup/${randomUUID()}`,
      organizationId: "org_test",
      workflowRunId: run.id,
      workItemId: work.id,
      agentId: "agent/manager",
      harness: "opencode_cli",
    });
    await store.claimWorkItem(work.id, attempt.id);
    await store.transitionAttempt(attempt.id, "preparing");
    await store.transitionAttempt(attempt.id, "running");
    const session = await store.createHarnessSession({
      organizationId: "org_test",
      agentId: "agent/manager",
      adapter: "opencode_cli",
      prompt: "Build it",
    });
    await store.linkHarnessSession(attempt.id, session.id);
    await store.setHarnessSessionProviderIdentity(session.id, "provider_session_123");
    const retainedWorkspace = await store.createWorkspace({
      organizationId: "org_test",
      attemptId: attempt.id,
      repositoryId: repository.id,
      path: tmpDir,
      branchName: `disposable/${attempt.id}`,
      baseCommitSha: "abcdef1",
      status: "ready",
    });
    await store.acquireResourceLock({
      organizationId: "org_test",
      resourceType: "workspace",
      resourceId: retainedWorkspace.id,
      ownerAttemptId: attempt.id,
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await store.appendHarnessSessionEvent({
      sessionId: session.id,
      kind: "tool_result",
      payload: { tool: "bash" },
      seq: 1,
    });
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const db = handle.db as unknown as {
      update(table: unknown): {
        set(value: unknown): { where(condition: unknown): Promise<unknown> };
      };
    };
    await db
      .update(agentAttempts)
      .set({ startedAt: staleAt, heartbeatAt: staleAt })
      .where(eq(agentAttempts.id, attempt.id));
    const wakeupId = `wup_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop/company-control/org_test",
      source: "system",
      agentId: "agent/manager",
      reason: "delegated work",
      payloadJson: JSON.stringify({
        prompt: "Build it",
        sessionId: session.id,
        workItemId: work.id,
        workflowRunId: run.id,
        resumeSessionId: "provider_session_123",
        resumeWorkspaceId: retainedWorkspace.id,
        mustResumeSession: true,
      }),
      status: "claimed",
      claimedAt: new Date().toISOString(),
      requestedAt: staleAt,
      idempotencyKey: randomUUID(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await (daemon as unknown as { recoverStaleClaims(): Promise<void> }).recoverStaleClaims();

    await expect(store.getAttempt(attempt.id)).resolves.toMatchObject({ status: "running" });
    const activeWake = (
      await (
        handle.db.select().from(wakeupsTable) as { all: () => Promise<Record<string, unknown>[]> }
      ).all()
    ).find((row) => row.id === wakeupId);
    expect(activeWake?.status).toBe("claimed");

    await db
      .update(sessionEvents)
      .set({ ts: staleAt })
      .where(eq(sessionEvents.sessionId, session.id));
    await db.update(wakeups).set({ claimedAt: staleAt }).where(eq(wakeups.id, wakeupId));
    await (daemon as unknown as { recoverStaleClaims(): Promise<void> }).recoverStaleClaims();

    await expect(store.getAttempt(attempt.id)).resolves.toMatchObject({ status: "lost" });
    await expect(store.getWorkItem(work.id)).resolves.toMatchObject({ status: "ready" });
    const recoveredWakeups = await (
      handle.db.select().from(wakeupsTable) as {
        all: () => Promise<Record<string, unknown>[]>;
      }
    ).all();
    const recovered = recoveredWakeups.find((row) => row.id === wakeupId);
    expect(recovered).toMatchObject({
      status: "failed",
      error: expect.stringContaining("retry queued"),
    });
    const retryWakeup = recoveredWakeups.find((row) => row.triggerDetail === "attempt-retry");
    expect(retryWakeup?.id).not.toBe(wakeupId);
    const retryPayload = JSON.parse(String(retryWakeup?.payloadJson)) as Record<string, unknown>;
    expect(retryPayload).toMatchObject({
      resumeSessionId: "provider_session_123",
      resumeWorkspaceId: retainedWorkspace.id,
      mustResumeSession: true,
    });
    expect(retryPayload.sessionId).not.toBe(session.id);
    const retrySession = (await handle.db.select().from(sessions)).find(
      (row) => row.wakeupId === retryWakeup?.id,
    );
    expect(retrySession).toMatchObject({
      id: retryPayload.sessionId,
      parentSessionId: session.id,
      status: "queued",
    });
    await expect(store.getHarnessSession(session.id)).resolves.toMatchObject({
      sessionId: "provider_session_123",
    });
    const originalEvents = await handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id));
    expect(originalEvents).toHaveLength(1);
    expect(originalEvents[0]?.seq).toBe(1);
    await expect(
      store.findResourceLock("org_test", "workspace", retainedWorkspace.id),
    ).resolves.toBeNull();

    const artifactRoot = join(tmpDir, "artifacts");
    process.env.AASPAI_ARTIFACTS_ROOT = artifactRoot;
    const failedWorkspace = join(tmpDir, "failed-workspace");
    await mkdir(join(failedWorkspace, "growth"), { recursive: true });
    await writeFile(
      join(failedWorkspace, "growth", "lead-list.md"),
      "Lead: https://example.test\n",
      "utf8",
    );
    const lostAttempt = await store.getAttempt(attempt.id);
    const currentWork = await store.getWorkItem(work.id);
    const brokerSecret = "attempt-broker-secret-value";
    expect(lostAttempt).not.toBeNull();
    expect(currentWork).not.toBeNull();
    await (
      daemon as unknown as {
        persistAttemptOutput(input: Record<string, unknown>): Promise<void>;
      }
    ).persistAttemptOutput({
      result: { exitCode: 1, timedOut: true, summary: `safe ${brokerSecret}` },
      attempt: lostAttempt,
      workItem: currentWork,
      workspacePath: failedWorkspace,
      sourceCommit: "abcdef1",
      branchName: `disposable/${attempt.id}`,
      repositoryWork: false,
      ephemeralSecrets: [brokerSecret],
    });
    const artifactDirectory = createHash("sha256").update(attempt.id).digest("hex");
    const persistedResult = await readFile(
      join(artifactRoot, artifactDirectory, "result.json"),
      "utf8",
    );
    expect(persistedResult).toContain("[REDACTED]");
    expect(persistedResult).not.toContain(brokerSecret);
    const retryAttempt = await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: run.id,
      workItemId: work.id,
      agentId: "agent/manager",
      harness: "opencode_cli",
      attemptNumber: 2,
    });
    const retryWorkspace = join(tmpDir, "retry-workspace");
    await mkdir(retryWorkspace, { recursive: true });
    await (
      daemon as unknown as {
        restorePreviousAttemptArtifacts(
          attempt: typeof retryAttempt,
          workspacePath: string,
        ): Promise<void>;
      }
    ).restorePreviousAttemptArtifacts(retryAttempt, retryWorkspace);
    await expect(readFile(join(retryWorkspace, "growth", "lead-list.md"), "utf8")).resolves.toBe(
      "Lead: https://example.test\n",
    );

    await writeFile(
      join(failedWorkspace, "growth", "lead-list.md"),
      `Lead: ${brokerSecret}\n`,
      "utf8",
    );
    await expect(
      (
        daemon as unknown as {
          persistAttemptOutput(input: Record<string, unknown>): Promise<void>;
        }
      ).persistAttemptOutput({
        result: { exitCode: 1, timedOut: true },
        attempt: lostAttempt,
        workItem: currentWork,
        workspacePath: failedWorkspace,
        sourceCommit: "abcdef1",
        branchName: `disposable/${attempt.id}`,
        repositoryWork: false,
        ephemeralSecrets: [brokerSecret],
      }),
    ).rejects.toThrow("Attempt output contains an ephemeral secret");
    await expect(
      readFile(join(artifactRoot, artifactDirectory, "files", "growth", "lead-list.md"), "utf8"),
    ).resolves.toBe("Lead: https://example.test\n");

    await teardownDb(tmpDir);
  });
});

describe("WorkerDaemon claimAndRun failure path (issue #2)", () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
  });

  it("marks wakeup as failed when the session throws (instead of leaving it claimed)", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();

    const wakeupId = `wup_${randomUUID()}`;
    await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
      id: wakeupId,
      organizationId: "org_test",
      loopId: "loop_daily_triage",
      source: "test",
      agentId: "operator",
      reason: "trigger test",
      payloadJson: JSON.stringify({ agentId: "operator", prompt: "do it" }),
      status: "queued",
      requestedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({
      organizationId: "org_test",
      workspaceRoot: tmpDir,
    });
    await (daemon as unknown as { claimAndRun(id: string): Promise<void> }).claimAndRun(wakeupId);

    const rows = await (
      handle.db.select().from(wakeupsTable) as {
        all: () => Promise<
          Array<{ id: string; status: string; error: string | null; sessionId: string | null }>
        >;
      }
    ).all();
    const row = rows.find((r) => r.id === wakeupId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/session exploded/);

    await teardownDb(tmpDir);
  });
});
