import { NextResponse } from "next/server";
import { isAaspaiWorkspace, listRecentSessions } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

/** `GET /api/sessions?agentId=agent/developer&limit=20` — recent sessions. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const rawAgent = searchParams.get("agentId") ?? "";
  const agentId = rawAgent.startsWith("agent/")
    ? rawAgent
    : rawAgent
      ? `agent/${rawAgent}`
      : undefined;
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const sessions = await listRecentSessions(limit, agentId);
  return NextResponse.json({ sessions });
}
