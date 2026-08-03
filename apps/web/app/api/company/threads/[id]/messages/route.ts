import { CompanyCommandService } from "@aaspai/company";
import { companyCommandSchema } from "@aaspai/contracts";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  const { id } = await context.params;
  return NextResponse.json({
    data: await new CompanyCommandService(db.db).listThreadMessages(user.organizationId, id),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = companyCommandSchema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    type: "add_thread_message",
    threadId: id,
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey:
      body &&
      typeof body === "object" &&
      "idempotencyKey" in body &&
      typeof body.idempotencyKey === "string"
        ? body.idempotencyKey
        : `message:${Date.now()}`,
  });
  if (!parsed.success) return NextResponse.json({ error: "body is required" }, { status: 400 });
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  try {
    const data = await new CompanyCommandService(db.db).execute(parsed.data);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Message failed" },
      { status: 400 },
    );
  }
}
