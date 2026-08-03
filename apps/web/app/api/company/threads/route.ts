import { CompanyCommandService } from "@aaspai/company";
import { companyCommandSchema } from "@aaspai/contracts";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  const url = new URL(request.url);
  const data = await new CompanyCommandService(db.db).listThreads(
    user.organizationId,
    url.searchParams.get("entityType") ?? undefined,
    url.searchParams.get("entityId") ?? undefined,
  );
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = companyCommandSchema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    type: "create_thread",
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey:
      body &&
      typeof body === "object" &&
      "idempotencyKey" in body &&
      typeof body.idempotencyKey === "string"
        ? body.idempotencyKey
        : `thread:${Date.now()}`,
  });
  if (!parsed.success)
    return NextResponse.json({ error: "entityType and entityId are required" }, { status: 400 });
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  try {
    const data = await new CompanyCommandService(db.db).execute(parsed.data);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Thread failed" },
      { status: 400 },
    );
  }
}
