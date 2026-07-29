import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDefaultDb, sessions, wakeups } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { DEFAULT_AGENTS_DIR, FileAgentConfigSource } from "@aaspai/file-loader";
import { NextResponse } from "next/server";
import { ensureWorkspaceEnv, workspaceRoot } from "@/lib/aaspai";
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
  const root = workspaceRoot();
  const agentSource = new FileAgentConfigSource(join(root, DEFAULT_AGENTS_DIR));
  await agentSource.start();
  const agent = await agentSource.get("agent/developer").catch(() => null);
  if (!agent)
    return NextResponse.json({ error: "Developer agent is not configured" }, { status: 409 });
  const sessionId = `sess_${randomUUID()}`;
  const wakeupId = `wake_${randomUUID()}`;
  const prompt = `Work item: ${item.title}\n\nGoal: ${goal.title}\n\nReport what you did, what you could not do, and the next action.`;
  const runtime =
    typeof agent.runtimeConfig.default === "object" && agent.runtimeConfig.default
      ? agent.runtimeConfig.default
      : { kind: "local" };
  const now = new Date().toISOString();
  await db.db.insert(wakeups).values({
    id: wakeupId,
    organizationId: user.organizationId,
    loopId: "manual",
    source: "web",
    triggerDetail: "goal-run",
    reason: `Run ready work item ${item.id}`,
    agentId: agent.id,
    payloadJson: JSON.stringify({
      prompt,
      adapter: agent.adapter,
      runtime,
      sessionId,
      workItemId: item.id,
      workflowRunId: item.workflowRunId,
      traceId: sessionId,
    }),
    status: "queued",
    idempotencyKey: `frontend-run:${item.id}`,
    requestedAt: now,
    requestedByActorId: user.id,
    requestedByActorType: "user",
  } as never);
  await db.db.insert(sessions).values({
    id: sessionId,
    organizationId: user.organizationId,
    wakeupId,
    agentId: agent.id,
    adapter: agent.adapter,
    runtimeJson: JSON.stringify(runtime),
    prompt,
    configJson: "{}",
    status: "queued",
  });
  await agentSource.stop();
  return NextResponse.json(
    { data: { sessionId, wakeupId, status: "queued", workItemId: item.id } },
    { status: 202 },
  );
}
