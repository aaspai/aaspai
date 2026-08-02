import { eq, getDefaultDb, runMigrations, wakeups } from "@aaspai/db";
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
  const store = new ExecutionStore(handle.db);
  return NextResponse.json({
    data: {
      queuedWakeups: rows.filter((row) => row.status === "queued").length,
      staleClaimedWakeups: await store.countStaleClaimedWakeups(cutoff, user.organizationId),
      staleAttempts: await store.countStaleAttempts(cutoff, user.organizationId),
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
  const [lostAttempts, releasedLocks] = await Promise.all([
    store.reconcileLostAttempts(cutoff, user.organizationId),
    store.reconcileExpiredLocks(undefined, user.organizationId),
  ]);
  return NextResponse.json({
    data: { lostAttempts, releasedLocks, reclaimedWakeups: 0 },
  });
}
