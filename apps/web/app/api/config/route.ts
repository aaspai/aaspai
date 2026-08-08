import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { type AaspaiConfig, readConfig, writeConfig } from "@/lib/config-store";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

/** Top-level config sections shown in the editor, in display order. */
export const CONFIG_CATEGORIES = [
  { key: "organization", label: "Organization" },
  { key: "database", label: "Database" },
  { key: "agents", label: "Agents" },
  { key: "knowledge", label: "Knowledge" },
  { key: "loops", label: "Loops" },
  { key: "runtime", label: "Runtime" },
] as const;

/**
 * `GET /api/config` — returns the workspace config + a static schema so
 * the UI can render a dynamic form (Hermes ConfigPage pattern).
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const config = await readConfig();
  return NextResponse.json({ config, categories: CONFIG_CATEGORIES });
}

/** `PUT /api/config` — deep-merges the supplied patch into config.json. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  let patch: unknown;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }
  await writeConfig(patch as AaspaiConfig);
  const next = await readConfig();
  return NextResponse.json({ config: next });
}
