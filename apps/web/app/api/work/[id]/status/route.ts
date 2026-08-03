import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const bodySchema = z.object({
  status: z.enum([
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
  ]),
  blockedReason: z.string().nullable().optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid task status" }, { status: 400 });
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
    parsed.data.status,
    { blockedReason: parsed.data.blockedReason ?? null },
    executionContext,
  );
  return NextResponse.json({
    data: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt },
  });
}
