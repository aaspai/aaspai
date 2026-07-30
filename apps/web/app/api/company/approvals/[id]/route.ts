import { getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const bodySchema = z.object({ status: z.enum(["approved", "rejected", "changes_requested"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  const store = new ExecutionStore(db.db);
  const { id } = await context.params;
  const approval = await store.getApproval(id);
  if (!approval || approval.organizationId !== user.organizationId)
    return NextResponse.json({ error: "Decision not found" }, { status: 404 });
  if (approval.actorType !== "human")
    return NextResponse.json({ error: "Approval requires a privileged actor" }, { status: 403 });
  try {
    const result = await store.decideApproval({
      approvalId: id,
      actorId: user.id,
      actorType: "human",
      status: parsed.data.status,
      reason:
        parsed.data.status === "approved"
          ? "Founder approved"
          : parsed.data.status === "changes_requested"
            ? "Founder requested changes"
            : "Founder rejected",
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Decision failed" },
      { status: 409 },
    );
  }
}
