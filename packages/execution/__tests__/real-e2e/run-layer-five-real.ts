import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompanyControlPlaneService, CompanyOperationsService } from "@aaspai/company";
import type { ExecutionPlan } from "@aaspai/contracts/execution";
import { createDb, runMigrations } from "@aaspai/db";
import { LocalGitRepository } from "@aaspai/git";
import { runProcess } from "@aaspai/harness";
import { compileProcessDefinition } from "@aaspai/loops";
import {
  AutonomousWorkExecutor,
  ExecutionStore,
  LocalExecutionWorkspaceManager,
  OperatorService,
} from "../../src/index.js";

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const evidenceRoot = join(repoRoot, "workspace", "layer-05-functional-work", runId);
const repositoryPath = join(evidenceRoot, "repository");
const databasePath = join(evidenceRoot, "execution.db");
const organizationId = `org/layer-five/${runId}`;
const context = { organizationId, actorId: "worker/real", correlationId: runId };
const codexCommand =
  process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "codex.cmd")
    : "codex";
const now = () => new Date().toISOString();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function gitCommand(args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd });
  assert(result.exitCode === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  await mkdir(repositoryPath, { recursive: true });
  await gitCommand(["init", "-b", "main"], repositoryPath);
  await gitCommand(["config", "user.email", "layer-five-real@example.test"], repositoryPath);
  await gitCommand(["config", "user.name", "Layer Five Real Test"], repositoryPath);
  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await mkdir(join(repositoryPath, "test"), { recursive: true });
  await writeFile(
    join(repositoryPath, "package.json"),
    '{"type":"module","scripts":{"test":"node --test"}}\n',
  );
  await writeFile(
    join(repositoryPath, "src", "math.mjs"),
    "export function add(a, b) { return a + b; }\n",
  );
  await writeFile(
    join(repositoryPath, "test", "math.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  await gitCommand(["add", "."], repositoryPath);
  await gitCommand(["commit", "-m", "real layer five base"], repositoryPath);
  return gitCommand(["rev-parse", "HEAD"], repositoryPath);
}

async function writeEvidence(
  store: ExecutionStore,
  attemptId: string,
  stepId: string,
  result: unknown,
): Promise<void> {
  const attempt = await store.getAttempt(attemptId);
  const events = await store.listEvents(attemptId);
  const raw = await store.listRawOutputs(attemptId);
  const sessionEvents = attempt?.harnessSessionId
    ? await store.listHarnessSessionEvents(attempt.harnessSessionId)
    : [];
  const evidencePath = join(evidenceRoot, "evidence", "attempts", `${stepId}.json`);
  await mkdir(join(evidenceRoot, "evidence", "attempts"), { recursive: true });
  const body = JSON.stringify({ stepId, result, attempt, events, raw, sessionEvents }, null, 2);
  await writeFile(evidencePath, body, "utf8");
  const bytes = await stat(evidencePath);
  await store.createArtifact({
    organizationId,
    attemptId,
    kind: "result",
    path: evidencePath,
    mediaType: "application/json",
    sizeBytes: bytes.size,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}

async function main(): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(join(evidenceRoot, "evidence", "work-graph"), { recursive: true });
  await mkdir(join(evidenceRoot, "evidence", "claims"), { recursive: true });
  await mkdir(join(evidenceRoot, "evidence", "checkers"), { recursive: true });
  await mkdir(join(evidenceRoot, "evidence", "recovery"), { recursive: true });
  await mkdir(join(evidenceRoot, "evidence", "governance"), { recursive: true });
  const baseCommit = await createRepository();
  const handle = createDbForRun(databasePath);
  const store = new ExecutionStore(handle.db);
  const company = new CompanyOperationsService(handle.db);
  const control = new CompanyControlPlaneService(handle.db);
  const department = await company.createDepartment({
    organizationId,
    name: "Real Delivery",
    description: "The real planner, developer, and tester department.",
    managerAgentId: "agent/operator",
  });
  for (const agentId of ["agent/operator", "agent/planner", "agent/developer", "agent/tester"]) {
    await company.registerServiceAgent({
      organizationId,
      agentId,
      departmentId: department.id,
      metadata: {
        capabilities: [agentId.replace("agent/", "")],
        roles: [agentId.replace("agent/", "")],
        availability: "available",
      },
    });
  }
  await control.setAuthorityEdge({
    organizationId,
    fromAgentId: "agent/operator",
    toAgentId: "agent/planner",
    relation: "manages",
  });
  await control.setAuthorityEdge({
    organizationId,
    fromAgentId: "agent/operator",
    toAgentId: "agent/developer",
    relation: "manages",
  });
  await control.setAuthorityEdge({
    organizationId,
    fromAgentId: "agent/operator",
    toAgentId: "agent/tester",
    relation: "manages",
  });
  for (const stepId of ["planner", "developer", "tester"]) {
    const routing = await control.route({
      organizationId,
      requestedByAgentId: "agent/operator",
      targetAgentId: `agent/${stepId}`,
      departmentId: department.id,
      requiredRole: stepId,
      capability: stepId,
      risk: "low",
      priority: 50,
      title: `Route ${stepId}`,
      description: `Route the real ${stepId} step`,
      idempotencyKey: `real-route:${runId}:${stepId}`,
    });
    assert(
      routing.status === "routed" && routing.selectedAgentId === `agent/${stepId}`,
      `${stepId}: company routing failed`,
    );
  }
  const git = new LocalGitRepository();
  const goal = await store.createGoal({
    organizationId,
    title: "Real Layer Five task",
    status: "active",
  });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "Real calculator change",
  });
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: repositoryPath,
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: baseCommit,
    sourcePath: ".",
    contentHash: baseCommit,
  });
  const definition = compileProcessDefinition({
    id: "process/real-layer-five",
    organizationId,
    name: "Real calculator change",
    description: "A real planner, developer, and tester task executed by Codex.",
    steps: [
      {
        id: "tester",
        agent: "agent/tester",
        dependsOn: ["developer"],
        prompt:
          "Run the test suite. If it passes, write TEST-RESULT.md with the command and result, then commit all changes.",
        skills: [],
        tools: [],
        timeoutMs: 180_000,
        maxAttempts: 1,
        acceptanceCriteria: "node --test passes and TEST-RESULT.md exists",
        failureAction: "stop",
        approvalPolicy: {},
      },
      {
        id: "developer",
        agent: "agent/developer",
        dependsOn: ["planner"],
        prompt:
          "Read PLAN.md. Implement multiply(a, b) in src/math.mjs and add a focused test. Run node --test, then commit all changes.",
        skills: [],
        tools: [],
        timeoutMs: 180_000,
        maxAttempts: 1,
        acceptanceCriteria: "multiply is implemented and tests pass",
        failureAction: "stop",
        approvalPolicy: {},
      },
      {
        id: "planner",
        agent: "agent/planner",
        dependsOn: [],
        prompt:
          "Inspect this small repository and write PLAN.md describing the exact implementation and verification steps for adding multiply(a, b). Commit PLAN.md.",
        skills: [],
        tools: [],
        timeoutMs: 180_000,
        maxAttempts: 1,
        acceptanceCriteria: "PLAN.md exists with an actionable implementation plan",
        failureAction: "stop",
        approvalPolicy: {},
      },
    ],
  });
  const operator = new OperatorService(store);
  const started = await operator.startProcess({
    context,
    operatorAgentId: "agent/operator",
    scopeType: "goal",
    scopeId: goal.id,
    definition,
    goalId: goal.id,
    projectId: project.id,
    repositoryId: repository.id,
    definitionRevisionId: revision.id,
    sourceCommitSha: baseCommit,
    idempotencyKey: `real:${runId}`,
  });
  const executor = new AutonomousWorkExecutor(store);
  const workspaces = new LocalExecutionWorkspaceManager(git, store, async () => repositoryPath);
  let sourceCommit = baseCommit;
  const steps = ["planner", "developer", "tester"] as const;
  const runEvidence: Record<string, unknown>[] = [];

  for (const stepId of steps) {
    const decisionResult = await operator.tick(context, started.run.id);
    assert(
      decisionResult.decision?.action === "dispatch",
      `${stepId}: operator did not dispatch work`,
    );
    const workItem = await store.getWorkItem(decisionResult.decision.targetId ?? "", context);
    assert(workItem, `${stepId}: dispatch target missing`);
    assert(workItem.title === stepId, `${stepId}: expected ${stepId}, got ${workItem.title}`);
    const dispatched = await store.dispatchWorkItem({
      workflowRunId: started.workflowRunId,
      workItemId: workItem.id,
      agentId: `agent/${stepId}`,
      harness: "codex_local",
      organizationConcurrency: 1,
      projectConcurrency: 1,
      repositoryConcurrency: 1,
      agentConcurrency: 1,
    });
    assert(dispatched, `${stepId}: WorkItem claim failed`);
    const attempt = await store.startScheduledAttempt(dispatched.attempt.id);
    const workspace = await workspaces.prepare({
      organizationId,
      attemptId: attempt.id,
      repositoryId: repository.id,
      repositoryPath,
      baseCommitSha: sourceCommit,
      workspaceRoot: join(evidenceRoot, "workspaces"),
      branchName: `layer-five/${stepId}-${attempt.id}`,
    });
    const plan: ExecutionPlan = await store.createPlan({
      organizationId,
      definitionRevisionId: revision.id,
      workItemId: workItem.id,
      attemptId: attempt.id,
      sourceSnapshot: {
        repositoryId: repository.id,
        commitSha: sourceCommit,
        branchName: "main",
        capturedAt: now(),
      },
      target: { kind: "local", cwd: workspace.path, envPassthrough: false },
      harness: "codex_local",
      agentId: `agent/${stepId}`,
      idempotencyKey: `real-plan:${runId}:${stepId}`,
      prompt: String(workItem.description),
      timeoutMs: 180_000,
      harnessConfig: {
        command: codexCommand,
        sandbox: "workspace-write",
        approvalMode: "never",
      },
    });
    const execution = await executor.execute({
      organizationId,
      workflowRunId: started.workflowRunId,
      workItemId: workItem.id,
      agentId: `agent/${stepId}`,
      harness: "codex_local",
      attempt,
      plan,
      workspace,
      agent: {
        id: `agent/${stepId}`,
        name: stepId,
        adapterType: "codex_local",
        adapterConfig: {},
      },
    });
    assert(
      execution.providerResult?.exitCode === 0,
      `${stepId}: Codex failed: ${execution.providerResult?.errorMessage ?? execution.providerResult?.summary}`,
    );
    const committed =
      (await git.commit(workspace.path, `real layer five ${stepId}`)) ??
      (await git.resolveCommit(workspace.path));
    assert(
      committed && committed !== sourceCommit,
      `${stepId}: Codex produced no committed change`,
    );
    await gitCommand(["merge", "--ff-only", committed], repositoryPath);
    sourceCommit = await git.resolveCommit(repositoryPath);
    await writeEvidence(store, attempt.id, stepId, execution.providerResult);
    runEvidence.push({
      stepId,
      attemptId: attempt.id,
      sessionId: execution.providerResult?.sessionId,
      commit: sourceCommit,
      workItemStatus: execution.workItem.status,
    });
    if (stepId === "planner")
      assert(
        (await readFile(join(repositoryPath, "PLAN.md"), "utf8")).includes("multiply"),
        "planner did not create PLAN.md",
      );
    if (stepId === "developer")
      assert(
        (await readFile(join(repositoryPath, "src", "math.mjs"), "utf8")).includes("multiply"),
        "developer did not implement multiply",
      );
    if (stepId === "tester")
      assert(
        /(?:node --test|npm(?:\.cmd)? test)/.test(
          await readFile(join(repositoryPath, "TEST-RESULT.md"), "utf8"),
        ),
        "tester did not create TEST-RESULT.md",
      );
    await workspaces.release(workspace.id);
  }
  const completed = await operator.tick(context, started.run.id);
  assert(completed.run.status === "completed", `operator ended as ${completed.run.status}`);
  const finalItems = await store.listWorkItems(organizationId, goal.id);
  assert(
    finalItems.length === 3 && finalItems.every((item) => item.status === "completed"),
    "not all WorkItems completed",
  );
  const result = {
    status: "passed",
    runId,
    organizationId,
    workflowRunId: started.workflowRunId,
    operatorRunId: started.run.id,
    sourceCommit,
    evidence: runEvidence,
    finishedAt: now(),
  };
  await writeFile(
    join(evidenceRoot, "environment-snapshot.json"),
    JSON.stringify(
      {
        node: process.version,
        codex: await runProcess({
          command: codexCommand,
          args: ["--version"],
        }),
        repositoryPath,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(evidenceRoot, "RESULT.md"),
    `# Layer Five real task\n\nStatus: passed\n\nRun: ${runId}\n\nWorkflowRun: ${started.workflowRunId}\n\nSource commit: ${sourceCommit}\n`,
  );
  await writeFile(join(evidenceRoot, "SUMMARY.json"), JSON.stringify(result, null, 2));
  await handle.close();
  console.log(JSON.stringify({ ...result, evidenceRoot }, null, 2));
}

function createDbForRun(path: string) {
  process.env.AASPAI_DB = `sqlite:${path}`;
  const handle = createDb();
  runMigrations(handle);
  return handle;
}

main().catch(async (error) => {
  await writeFile(
    join(evidenceRoot, "RESULT.md"),
    `# Layer Five real task\n\nStatus: failed\n\n${String(error)}\n`,
  ).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
