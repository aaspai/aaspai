import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const allowed = new Set([
  "proposed",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "awaiting_verification",
  "completed",
  "failed",
  "cancelled",
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = (await request.json()) as { status?: string; blockedReason?: string | null };
  if (!body.status || !allowed.has(body.status))
    return NextResponse.json({ error: "Invalid task status" }, { status: 400 });
  ensureWorkspaceEnv();
  const { id } = await context.params;
  const store = new ExecutionStore(getDefaultDb().db);
  const executionContext = {
    organizationId: user.organizationId,
    actorId: user.id,
    correlationId: `web-work-status:${id}`,
  } as const;
  const item = await store.getWorkItem(decodeURIComponent(id), executionContext);
  if (!item) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  const updated = await store.updateWorkItemStatus(
    item.id,
    body.status as never,
    { blockedReason: body.blockedReason ?? null },
    executionContext,
  );
  return NextResponse.json({
    data: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt },
  });
}
