import { CompanyFullExportService } from "@aaspai/company";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const handle = getDefaultDb();
  runMigrations(handle);
  return NextResponse.json({
    data: await new CompanyFullExportService(handle.db).exportCompany(user.organizationId),
  });
}
