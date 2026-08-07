import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";
import { destroySandbox } from "@/lib/sandboxes";

export const dynamic = "force-dynamic";

/**
 * Force-destroy a sandbox immediately (bypasses the archive/delete TTL).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const sandboxId = decodeURIComponent((await params).id);
  await destroySandbox(sandboxId);
  return NextResponse.json({ sandboxId, status: "deleted" });
}
