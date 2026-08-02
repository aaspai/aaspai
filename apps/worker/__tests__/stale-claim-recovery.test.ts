import { randomUUID } from "node:crypto";
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

  it("moves wakeups claimed more than 5 minutes ago to failed", async () => {
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

    const { WorkerDaemon } = await import("../src/daemon.js");
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
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toMatch(/stale claim/);
    expect(fresh?.status).toBe("claimed");

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

    await teardownDb(tmpDir);
  });

  it("requeues lost delegated work with the persisted provider session", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const { agentAttempts, eq, sessionEvents } = await import("@aaspai/db");
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
      .set({ startedAt: staleAt })
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
        workItemId: work.id,
        workflowRunId: run.id,
      }),
      status: "claimed",
      claimedAt: staleAt,
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
    await (daemon as unknown as { recoverStaleClaims(): Promise<void> }).recoverStaleClaims();

    await expect(store.getAttempt(attempt.id)).resolves.toMatchObject({ status: "lost" });
    await expect(store.getWorkItem(work.id)).resolves.toMatchObject({ status: "ready" });
    const recovered = (
      await (
        handle.db.select().from(wakeupsTable) as { all: () => Promise<Record<string, unknown>[]> }
      ).all()
    ).find((row) => row.id === wakeupId);
    expect(recovered?.status).toBe("queued");
    expect(JSON.parse(String(recovered?.payloadJson))).toMatchObject({
      resumeSessionId: "provider_session_123",
    });

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
    expect(lostAttempt).not.toBeNull();
    expect(currentWork).not.toBeNull();
    await (
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
    });
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
