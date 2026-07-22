import { NextResponse } from "next/server";
import { getAgent, getAgentSystemPrompt, listRecentSessions } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
