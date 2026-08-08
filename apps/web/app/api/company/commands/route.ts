import { CompanyCommandService } from "@aaspai/company";
import { companyCommandSchema } from "@aaspai/contracts";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { deriveIdempotencyKey } from "@/lib/idempotency";
import { currentUser } from "@/lib/local-auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const parsed = companyCommandSchema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    organizationId: user.organizationId,
    actorId: user.id,
    idempotencyKey:
      body &&
      typeof body === "object" &&
      "idempotencyKey" in body &&
      typeof body.idempotencyKey === "string"
        ? body.idempotencyKey
        : deriveIdempotencyKey(body),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "A command type is required" }, { status: 400 });
  }
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  runMigrations(db);
  try {
    const result = await new CompanyCommandService(db.db).execute(parsed.data);
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Command failed" },
      { status: 400 },
    );
  }
}
