import { CompanyFullExportService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  try {
    const bundle = new CompanyFullExportService(handle.db).validateImport(await request.json());
    return NextResponse.json({ data: { valid: true, protocolVersion: bundle.protocolVersion } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid export" },
      { status: 400 },
    );
  }
}
