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
