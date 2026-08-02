import { CompanyCommandService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    typeof body?.title !== "string" ||
    !body.title.trim() ||
    typeof body.mandate !== "string" ||
    !body.mandate.trim()
  ) {
    return NextResponse.json(
      { error: "An objective and direction for the CEO are required" },
      { status: 400 },
    );
  }
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  const result = await new CompanyCommandService(db.db).execute({
    type: "create_objective",
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey: `web-objective:${user.organizationId}:${body.title.trim().toLowerCase()}`,
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description : "",
    successCriteria: [body.mandate],
  });
  return NextResponse.json({ data: result }, { status: 201 });
}
