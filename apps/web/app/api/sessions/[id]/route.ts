import { NextResponse } from "next/server";
import { getSessionDetail, isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: `session ${sessionId} not found` }, { status: 404 });
  }
  return NextResponse.json(session);
}
