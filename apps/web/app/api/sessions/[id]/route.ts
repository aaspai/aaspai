import { NextResponse } from "next/server";
import { getSessionDetail, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = decodeURIComponent(id);
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const session = await getSessionDetail(sessionId);
  if (!session) {
    return NextResponse.json({ error: `session ${sessionId} not found` }, { status: 404 });
  }
  return NextResponse.json(session);
}
