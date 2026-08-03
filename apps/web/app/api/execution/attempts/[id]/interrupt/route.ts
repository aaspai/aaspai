import { agentAttempts, eq, getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  const { id } = await params;
  const attemptId = decodeURIComponent(id);
  const [attempt] = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.id, attemptId))
    .limit(1);
  if (!attempt) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  if (attempt.organizationId !== user.organizationId)
    return NextResponse.json({ error: "Organization access denied" }, { status: 403 });
  try {
    return NextResponse.json({
      data: await new ExecutionStore(handle.db).requestInterruptAttempt(attemptId),
    });
  } catch (error) {
    if (String(error).includes("has not started")) {
      return NextResponse.json({ error: String(error) }, { status: 409 });
    }
    throw error;
  }
}
