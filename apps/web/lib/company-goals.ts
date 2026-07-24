import { getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { ensureWorkspaceEnv } from "@/lib/aaspai";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

export async function createFrontendGoal(input: {
  organizationId: string;
  companyName: string;
  title: string;
  description?: string;
  projectTitle?: string;
  steps: string[];
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
    commitSha: "frontend-definition",
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
  const workItems: Awaited<ReturnType<ExecutionStore["createWorkItem"]>>[] = [];
  let previous: string | undefined;
  for (const [index, step] of input.steps.entries()) {
    const item = await store.createWorkItem({
      organizationId: input.organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: run.id,
      title: step.trim(),
      status: index === 0 ? "ready" : "proposed",
      priority: input.steps.length - index,
      idempotencyKey: `frontend:${goal.id}:${index}`,
      metadata: { ownerAgentId: "agent/developer", validationOwnerAgentId: "agent/tester" },
    });
    if (previous) await store.addWorkItemDependency(input.organizationId, item.id, previous);
    workItems.push(item);
    previous = item.id;
  }
  return { goal, project, repository, run, workItems };
}
