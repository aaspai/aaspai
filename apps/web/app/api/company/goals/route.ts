import { getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/local-auth";
import { ensureFrontendWorkspace } from "@/lib/workspace-bootstrap";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const steps = Array.isArray(body?.steps)
    ? body.steps.filter(
        (step): step is string => typeof step === "string" && step.trim().length > 0,
      )
    : [];
  if (typeof body?.title !== "string" || !body.title.trim() || steps.length === 0) {
    return NextResponse.json(
      { error: "A goal title and at least one pipeline step are required" },
      { status: 400 },
    );
  }
  await ensureFrontendWorkspace(user.companyName);
  const db = getDefaultDb();
  runMigrations(db);
  const store = new ExecutionStore(db.db);
  const goal = await store.createGoal({
    organizationId: user.organizationId,
    title: body.title.trim(),
    description: typeof body.description === "string" ? body.description : undefined,
  });
  const project = await store.createProject({
    organizationId: user.organizationId,
    goalId: goal.id,
    title:
      typeof body.projectTitle === "string" && body.projectTitle.trim()
        ? body.projectTitle.trim()
        : `${goal.title} delivery`,
  });
  const repository = await store.createRepository({
    organizationId: user.organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: `projects/${project.id}`,
  });
  await ensureFrontendWorkspace(user.companyName);
  const revision = await store.createDefinitionRevision({
    organizationId: user.organizationId,
    repositoryId: repository.id,
    commitSha: "frontend-definition",
    sourcePath: ".",
    dirty: true,
    contentHash: "frontend-definition",
  });
  const run = await store.createWorkflowRun({
    organizationId: user.organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    sourceType: "frontend",
    sourceId: goal.id,
    idempotencyKey: `frontend:${goal.id}`,
  });
  const workItems: Awaited<ReturnType<ExecutionStore["createWorkItem"]>>[] = [];
  let previous: string | undefined;
  for (const [index, step] of steps.entries()) {
    const item = await store.createWorkItem({
      organizationId: user.organizationId,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      workflowRunId: run.id,
      title: step.trim(),
      status: index === 0 ? "ready" : "proposed",
      priority: steps.length - index,
      idempotencyKey: `frontend:${goal.id}:${index}`,
      metadata: { ownerAgentId: "agent/developer", validationOwnerAgentId: "agent/tester" },
    });
    if (previous) await store.addWorkItemDependency(user.organizationId, item.id, previous);
    workItems.push(item);
    previous = item.id;
  }
  return NextResponse.json(
    { data: { goal, project, repository, run, workItems } },
    { status: 201 },
  );
}
