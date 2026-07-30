import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { queueAgentWork } from "@/lib/company-goals";
import { currentUser } from "@/lib/local-auth";

export async function POST(_request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  ensureWorkspaceEnv();
  const { id } = await routeContext.params;
  const db = getDefaultDb();
  const store = new ExecutionStore(db.db);
  const executionContext = {
    organizationId: user.organizationId,
    actorId: user.id,
    correlationId: `web-goal-run:${id}`,
  } as const;
  const goal = await store.getGoal(id, executionContext);
  if (!goal || goal.organizationId !== user.organizationId)
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  const items = await store.listWorkItems(user.organizationId, id);
  const item = items.find((candidate) => candidate.status === "ready");
  if (!item) return NextResponse.json({ error: "No ready work item" }, { status: 409 });
  if (!item.workflowRunId)
    return NextResponse.json({ error: "Work item has no workflow run" }, { status: 409 });
  const metadata = item.metadata as Record<string, unknown>;
  const agentId = typeof metadata.ownerAgentId === "string" ? metadata.ownerAgentId : "agent/ceo";
  const queued = await queueAgentWork({
    organizationId: user.organizationId,
    actorId: user.id,
    goalId: id,
    workItemId: item.id,
    agentId,
  });
  return NextResponse.json({ data: { ...queued, workItemId: item.id } }, { status: 202 });
}
