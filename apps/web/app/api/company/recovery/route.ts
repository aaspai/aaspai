import { agentAttempts, and, eq, getDefaultDb, lt, runMigrations, wakeups } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = await handle.db
    .select()
    .from(wakeups)
    .where(eq(wakeups.organizationId, user.organizationId));
  const attempts = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.organizationId, user.organizationId));
  return NextResponse.json({
    data: {
      queuedWakeups: rows.filter((row) => row.status === "queued").length,
      staleClaimedWakeups: rows.filter(
        (row) => row.status === "claimed" && row.claimedAt && row.claimedAt < cutoff,
      ).length,
      staleAttempts: attempts.filter(
        (row) =>
          ["running", "queued"].includes(row.status) && row.startedAt && row.startedAt < cutoff,
      ).length,
    },
  });
}

export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const store = new ExecutionStore(handle.db);
  const [lostAttempts, releasedLocks, reclaimed] = await Promise.all([
    store.reconcileLostAttempts(cutoff, user.organizationId),
    store.reconcileExpiredLocks(undefined, user.organizationId),
    handle.db
      .update(wakeups)
      .set({ status: "queued", claimedAt: null, error: "requeued by recovery" })
      .where(
        and(
          eq(wakeups.organizationId, user.organizationId),
          eq(wakeups.status, "claimed"),
          lt(wakeups.claimedAt, cutoff),
        ),
      )
      .returning({ id: wakeups.id }),
  ]);
  return NextResponse.json({
    data: { lostAttempts, releasedLocks, reclaimedWakeups: reclaimed.length },
  });
}
