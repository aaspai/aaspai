import { ProcessImprovementService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceEnv, isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const bodySchema = z.object({ staleAfterDays: z.number().int().positive().optional() });

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  if (!isAaspaiWorkspace())
    return NextResponse.json({ error: "No aaspai workspace" }, { status: 404 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid evaluation options" }, { status: 400 });
  const handle = getDefaultDb();
  runMigrations(handle);
  try {
    const data = await new ProcessImprovementService(handle.db).evaluate({
      organizationId: user.organizationId,
      actorId: user.id,
      staleAfterDays: parsed.data.staleAfterDays,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Evaluation failed" },
      { status: 400 },
    );
  }
}
