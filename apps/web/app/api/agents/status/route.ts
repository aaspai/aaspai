import { NextResponse } from "next/server";
import { isAaspaiWorkspace } from "@/lib/aaspai";
import { currentUser } from "@/lib/local-auth";
import { isAgentUp, listLiveSandboxes } from "@/lib/sandboxes";

export const dynamic = "force-dynamic";

/**
 * Per-agent status: is this agent currently "up" (has a live ready
 * sandbox + session)? Returns the live sandbox summary if so.
 *
 * `GET /api/agents/status?agentId=agent/developer` (or `developer`).
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!isAaspaiWorkspace()) {
    return NextResponse.json({ error: "no aaspai workspace" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("agentId") ?? "";
  const agentId = raw.startsWith("agent/") ? raw : `agent/${raw}`;
  const live = await listLiveSandboxes();
  const sandbox = live.find((s) => s.agentId === agentId) ?? null;
  return NextResponse.json({
    agentId,
    up: Boolean(sandbox) || (await isAgentUp(agentId)),
    sandbox,
  });
}
