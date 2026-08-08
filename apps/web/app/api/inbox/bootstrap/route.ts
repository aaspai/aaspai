import { NextResponse } from "next/server";
import { isAaspaiWorkspace, listAgents } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";
import { listFrontendRuntimes } from "@/lib/provider-status";

export const dynamic = "force-dynamic";

/**
 * Bootstrap data for the persistent chat host (rendered in the dashboard
 * layout so conversations survive navigation). Returns agents + runtimes
 * the same way the `/inbox` server page used to.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const [agents, runtimes] = await Promise.all([listAgents(), listFrontendRuntimes()]);
  return NextResponse.json({
    agents: agents.map((agent) => ({
      id: agent.id,
      title: agent.title,
      role: agent.role,
      adapter: agent.adapter,
      model: agent.model,
      runtime: agent.runtime,
    })),
    runtimes,
  });
}
