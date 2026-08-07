import { NextResponse } from "next/server";
import {
  getAgent,
  getAgentSystemPrompt,
  isAaspaiWorkspace,
  listRecentSessions,
} from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { id } = await params;
  const agentId = decodeURIComponent(id);
  const [agent, systemPrompt, recentSessions] = await Promise.all([
    getAgent(agentId),
    getAgentSystemPrompt(agentId),
    listRecentSessions(20),
  ]);
  if (!agent) {
    return NextResponse.json({ error: `agent ${agentId} not found` }, { status: 404 });
  }
  return NextResponse.json({
    agent,
    systemPrompt,
    recentSessions: recentSessions.filter((s) => s.agentId === agentId).slice(0, 8),
  });
}
