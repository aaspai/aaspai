import { CompanyFullExportService } from "@aaspai/company";
import { companyImportBundleSchema } from "@aaspai/contracts";
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
    const parsed = companyImportBundleSchema.parse(await request.json());
    const data = await new CompanyFullExportService(handle.db).importCompany(
      user.organizationId,
      parsed,
    );
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed" },
      { status: 400 },
    );
  }
}
