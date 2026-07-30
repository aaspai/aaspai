import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDefaultDb, runMigrations, sessions, wakeups } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { DEFAULT_AGENTS_DIR, FileAgentConfigSource } from "@aaspai/file-loader";
import { ensureWorkspaceEnv, workspaceRoot } from "@/lib/aaspai";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

export async function createFrontendGoal(input: {
  organizationId: string;
  companyName: string;
  title: string;
  description?: string;
  projectTitle?: string;
  mandate: string;
  requestedByActorId: string;
}) {
  ensureWorkspaceEnv();
  await ensureFrontendWorkspace(input.companyName);
  const db = getDefaultDb();
  runMigrations(db);
  const store = new ExecutionStore(db.db);
  const goal = await store.createGoal({
    organizationId: input.organizationId,
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
  });
  const project = await store.createProject({
    organizationId: input.organizationId,
    goalId: goal.id,
    title: input.projectTitle?.trim() || `${goal.title} delivery`,
  });
  const repository = await store.createRepository({
    organizationId: input.organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: `projects/${project.id}`,
  });
  const revision = await store.createDefinitionRevision({
    organizationId: input.organizationId,
    repositoryId: repository.id,
    commitSha: "0000000",
    sourcePath: ".",
    dirty: true,
    contentHash: "frontend-definition",
  });
  const run = await store.createWorkflowRun({
    organizationId: input.organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    sourceType: "frontend",
    sourceId: goal.id,
    idempotencyKey: `frontend:${goal.id}`,
  });
  const workItem = await store.createWorkItem({
    organizationId: input.organizationId,
    goalId: goal.id,
    projectId: project.id,
    repositoryId: repository.id,
    workflowRunId: run.id,
    definitionRevisionId: revision.id,
    title: input.mandate.trim(),
    description: [
      `Company objective: ${goal.title}`,
      goal.description ? `Success outcome: ${goal.description}` : "",
      "Create the operating plan, do the next useful work, and flag capability gaps or founder decisions that block progress.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    status: "ready",
    priority: 1,
    idempotencyKey: `frontend:${goal.id}:ceo-mandate`,
    metadata: { ownerAgentId: "agent/ceo" },
    workKind: "general",
    deliveryMode: "none",
  });
  const queued = await queueAgentWork({
    organizationId: input.organizationId,
    actorId: input.requestedByActorId,
    goalId: goal.id,
    workItemId: workItem.id,
    agentId: "agent/ceo",
  });
  return { goal, project, repository, run, workItems: [workItem], queued };
}

export async function queueAgentWork(input: {
  organizationId: string;
  actorId: string;
  goalId: string;
  workItemId: string;
  agentId: string;
}) {
  ensureWorkspaceEnv();
  const db = getDefaultDb();
  const store = new ExecutionStore(db.db);
  const goal = await store.getGoal(input.goalId);
  const item = await store.getWorkItem(input.workItemId);
  if (!goal || !item || item.organizationId !== input.organizationId || !item.workflowRunId)
    throw new Error("Work item is not runnable");

  const source = new FileAgentConfigSource(join(workspaceRoot(), DEFAULT_AGENTS_DIR));
  await source.start();
  try {
    const agent = await source.get(input.agentId);
    const runtime =
      typeof agent.runtimeConfig.default === "object" && agent.runtimeConfig.default
        ? agent.runtimeConfig.default
        : { kind: "local" };
    const sessionId = `sess_${randomUUID()}`;
    const wakeupId = `wake_${randomUUID()}`;
    const prompt = `${item.description}\n\nMandate: ${item.title}\n\nUse the company mission and operating principles in your agent definition.`;
    const now = new Date().toISOString();
    db.db.transaction((tx) => {
      tx.insert(wakeups)
        .values({
          id: wakeupId,
          organizationId: input.organizationId,
          loopId: "manual",
          source: "web",
          triggerDetail: "company-direction",
          reason: `CEO mandate ${item.id}`,
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
          requestedByActorId: input.actorId,
          requestedByActorType: "user",
        } as never)
        .run();
      tx.insert(sessions)
        .values({
          id: sessionId,
          organizationId: input.organizationId,
          wakeupId,
          agentId: agent.id,
          adapter: agent.adapter,
          runtimeJson: JSON.stringify(runtime),
          prompt,
          configJson: "{}",
          status: "queued",
        })
        .run();
    });
    return { sessionId, wakeupId, status: "queued" as const };
  } finally {
    await source.stop();
  }
}
