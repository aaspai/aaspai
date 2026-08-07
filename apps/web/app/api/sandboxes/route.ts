import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";
import { listSandboxes } from "@/lib/sandboxes";

export const dynamic = "force-dynamic";

/**
 * List the sandbox registry for the org — every sandbox ever provisioned
 * for a session, with its lifecycle status and TTL.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const sandboxes = await listSandboxes();
  return NextResponse.json({ sandboxes });
}
