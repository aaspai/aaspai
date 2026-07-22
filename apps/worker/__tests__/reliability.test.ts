import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function insertQueued(
  handle: { db: { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } } },
  wakeupsTable: unknown,
  id: string,
  reason: string,
): Promise<void> {
  await (handle.db.insert(wakeupsTable) as { values: (v: unknown) => Promise<unknown> }).values({
    id,
    organizationId: "org_test",
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
    await (daemon as unknown as { claimAndRun(id: string): Promise<void> }).claimAndRun(wakeupId);

    // Should NOT have called sessions.execute — the wakeup was already claimed
    expect(sessionExecute).not.toHaveBeenCalled();
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

    const first = (daemon as unknown as { pollWakeups(): Promise<void> }).pollWakeups();
    // While the first is in flight (session is 200ms), fire a second tick.
    await new Promise((r) => setTimeout(r, 20));
    const second = (daemon as unknown as { pollWakeups(): Promise<void> }).pollWakeups();

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

    sessionExecute = vi.fn().mockRejectedValue(new Error("adapter timeout"));

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await (daemon as unknown as { claimAndRun(id: string): Promise<void> }).claimAndRun(wakeupId);

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

  it("succeeds on the 2nd attempt without marking as failed", async () => {
    const { tmpDir, wakeupsTable, handle } = await setupDb();
    const wakeupId = `wup_${randomUUID()}`;
    await insertQueued(handle, wakeupsTable, wakeupId, "transient fail then ok");

    let calls = 0;
    sessionExecute = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return { status: "completed", output: "ok", sessionId: "sess_test" };
    });

    const { WorkerDaemon } = await import("../src/daemon.js");
    const daemon = new WorkerDaemon({ organizationId: "org_test", workspaceRoot: tmpDir });
    await (daemon as unknown as { claimAndRun(id: string): Promise<void> }).claimAndRun(wakeupId);

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
    const pollPromise = (daemon as unknown as { pollWakeups(): Promise<void> }).pollWakeups();
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
