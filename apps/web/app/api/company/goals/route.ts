import { CompanyCommandService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

const bodySchema = z.object({
  title: z.string().trim().min(1),
  mandate: z.string().trim().min(1),
  description: z.string().optional(),
});

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
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
    idempotencyKey: `web-objective:${user.organizationId}:${parsed.data.title.toLowerCase()}`,
    title: parsed.data.title,
    description: parsed.data.description ?? "",
    successCriteria: [parsed.data.mandate],
  });
  return NextResponse.json({ data: result }, { status: 201 });
}
