import { join } from "node:path";
import { getDefaultDb } from "@aaspai/db";
import { ExecutionStore, OperatorService } from "@aaspai/execution";
import { FileAgentConfigSource, FileKnowledgeSource } from "@aaspai/file-loader";
import { Sessions } from "@aaspai/sessions";
import { loadSkillDirectory } from "@aaspai/skills";
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
  const agentSource = new FileAgentConfigSource(join(root, "agents"));
  const knowledgeSource = new FileKnowledgeSource(join(root, "knowledge"));
  const sessions = new Sessions({
    agentSource,
    knowledgeSource,
    skillRegistry: await loadSkillDirectory(join(root, "skills")),
  });
  await agentSource.start();
  const agent = await agentSource.get("agent/developer").catch(() => null);
  if (!agent)
    return NextResponse.json({ error: "Developer agent is not configured" }, { status: 409 });
  let result: Awaited<ReturnType<Sessions["execute"]>> | null = null;
  const execution = await new OperatorService(store).executeWorkItem(
    executionContext,
    item.workflowRunId,
    item.id,
    {
      agentId: agent.id,
      harness: agent.adapter,
      runProvider: async () => {
        result = await sessions.execute({
          organizationId: user.organizationId,
          agentId: agent.id,
          adapter: agent.adapter,
          runtime: { kind: "local" },
          cwd: root,
          prompt: `Work item: ${item.title}\n\nGoal: ${goal.title}\n\nReport what you did, what you could not do, and the next action.`,
          config: {},
          skills: [],
          budget: {},
          idempotencyKey: `frontend-run:${item.id}`,
        });
        return result.status === "succeeded" ? "succeeded" : "failed";
      },
    },
  );
  await agentSource.stop();
  await knowledgeSource.stop();
  return NextResponse.json({ data: { result, execution, workItemId: item.id } });
}
