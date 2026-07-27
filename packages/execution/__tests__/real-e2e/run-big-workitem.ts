import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AgentAttempt, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import { closeDefaultDb, createDb, runMigrations } from "@aaspai/db";
import { runProcess } from "@aaspai/harness";
import { HarnessExecutionPlanRunner } from "../../src/harness-runner.js";
import { ExecutionStore } from "../../src/store.js";

const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const root = join(repoRoot, "workspace", "layer-02-execution", "big-workitem", runId);
const dbPath = join(root, "db", "execution.db");
const organizationId = "org_layer_two_big_workitem";
const fakeCli = join(repoRoot, "packages", "harness", "__tests__", "fixtures", "fake-opencode.cjs");
const now = () => new Date().toISOString();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
) {
  const result = await runProcess({ command: executable, args, ...options });
  assert(result.exitCode === 0, `${executable} ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createSourceRepository(sourceRepo: string): Promise<string> {
  await mkdir(sourceRepo, { recursive: true });
  await command("git", ["init", "-b", "main"], { cwd: sourceRepo });
  await command("git", ["config", "user.email", "layer-two@example.test"], { cwd: sourceRepo });
  await command("git", ["config", "user.name", "Layer Two Test"], { cwd: sourceRepo });
  await writeFile(join(sourceRepo, "README.md"), "# Real Layer Two WorkItem\n", "utf8");
  await command("git", ["add", "README.md"], { cwd: sourceRepo });
  await command("git", ["commit", "-m", "layer two real base"], { cwd: sourceRepo });
  return (await command("git", ["rev-parse", "HEAD"], { cwd: sourceRepo })).stdout.trim();
}

async function createMcpServer(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "const fs = require('node:fs');",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk.toString();",
      "  for (const line of buffer.split(/\\r?\\n/).slice(0, -1)) {",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'tools/call') {",
      "      fs.writeFileSync('mcp-tool-output.txt', JSON.stringify(request.params));",
      "      console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'MCP_TOOL_OK'}]}}));",
      "      process.exit(0);",
      "    }",
      "    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}}}}));",
      "  }",
      "});",
    ].join("\n"),
    "utf8",
  );
}

async function createLineage(store: ExecutionStore, sourceRepo: string, commitSha: string) {
  const goal = await store.createGoal({
    id: "goal_big_workitem",
    organizationId,
    title: "Layer Two real WorkItem verification",
    description: "Verify multi-step execution, tools, skills, MCP, sessions, and recovery.",
    status: "active",
  });
  const project = await store.createProject({
    id: "project_big_workitem",
    organizationId,
    goalId: goal.id,
    title: "Execution fabric",
  });
  const repository = await store.createRepository({
    id: "repo_big_workitem",
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: sourceRepo,
  });
  const revision = await store.createDefinitionRevision({
    id: "revision_big_workitem",
    organizationId,
    repositoryId: repository.id,
    commitSha,
    sourcePath: sourceRepo,
    contentHash: `sha256:${commitSha}`,
  });
  const workflowRun = await store.createWorkflowRun({
    id: "workflow_big_workitem",
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    sourceType: "real-e2e",
    idempotencyKey: `workflow:${runId}`,
  });
  return { goal, project, repository, revision, workflowRun };
}

async function prepareAttempt(
  store: ExecutionStore,
  lineage: Awaited<ReturnType<typeof createLineage>>,
  sourceRepo: string,
  title: string,
  attemptNumber = 1,
  parentAttemptId?: string,
): Promise<{
  workItem: Awaited<ReturnType<ExecutionStore["createWorkItem"]>>;
  attempt: AgentAttempt;
  workspace: ExecutionWorkspace;
  workspacePath: string;
}> {
  const workItem = await store.createWorkItem({
    id: attemptNumber === 1 ? "work_big_workitem" : `work_big_workitem_resume_${attemptNumber}`,
    organizationId,
    goalId: lineage.goal.id,
    projectId: lineage.project.id,
    repositoryId: lineage.repository.id,
    workflowRunId: lineage.workflowRun.id,
    title,
    description:
      "Execute multiple steps: inspect the skill, use an MCP server, invoke a tool, create files, run commands, preserve session evidence, then support resume and recovery.",
    definitionRevisionId: lineage.revision.id,
    sourceCommitSha: (
      await command("git", ["rev-parse", "HEAD"], { cwd: sourceRepo })
    ).stdout.trim(),
    branchName: `layer-two/${attemptNumber}`,
    maxAttempts: 2,
    idempotencyKey: `workitem:${runId}:${attemptNumber}`,
    metadata: {
      steps: [
        "read the pinned skill instructions",
        "load the configured MCP server",
        "invoke the bash tool",
        "create a file and run a command",
        "persist raw output, canonical events, and session history",
        "resume the provider session and reconcile a restart",
      ],
      skills: [{ key: "layer-two-real", version: "1.0.0" }],
      mcpServers: ["layer-two-mcp"],
      tools: ["bash"],
    },
  });
  const dispatched = await store.dispatchWorkItem({
    workItemId: workItem.id,
    workflowRunId: lineage.workflowRun.id,
    agentId: "agent_layer_two_big_workitem",
    harness: "opencode_cli",
    parentAttemptId,
  });
  assert(dispatched, `work item ${workItem.id} was not dispatched`);
  const attempt = dispatched.attempt;
  await store.startScheduledAttempt(attempt.id);
  const runningAttempt = await store.getAttempt(attempt.id);
  assert(runningAttempt, `attempt ${attempt.id} disappeared after start`);
  const workspacePath = join(root, "workspaces", attempt.id);
  await mkdir(join(root, "workspaces"), { recursive: true });
  await command("git", ["clone", "--no-hardlinks", sourceRepo, workspacePath]);
  const workspace = await store.createWorkspace({
    id: `workspace_${attempt.id}`,
    organizationId,
    attemptId: attempt.id,
    repositoryId: lineage.repository.id,
    path: workspacePath,
    branchName: `layer-two/${attemptNumber}`,
    baseCommitSha: lineage.revision.commitSha,
    status: "ready",
  });
  return { workItem, attempt: runningAttempt, workspace, workspacePath };
}

async function persistEvidence(
  store: ExecutionStore,
  label: string,
  attemptId: string,
  result: AdapterExecutionResult,
): Promise<Record<string, unknown>> {
  const attempt = await store.getAttempt(attemptId);
  const session = attempt?.harnessSessionId
    ? await store.getHarnessSession(attempt.harnessSessionId)
    : null;
  const sessionEvents = attempt?.harnessSessionId
    ? await store.listHarnessSessionEvents(attempt.harnessSessionId)
    : [];
  const raw = await store.listRawOutputs(attemptId);
  const events = await store.listEvents(attemptId);
  const evidence = {
    result,
    attempt,
    session,
    sessionEvents,
    raw,
    events,
    sessionEventKinds: sessionEvents.map((event) => event.kind),
    rawSequences: raw.map((event) => event.seq),
    eventSequences: events.map((event) => event.seq),
  };
  await writeFile(join(root, `${label}-evidence.json`), JSON.stringify(evidence, null, 2), "utf8");
  return evidence;
}

await mkdir(join(root, "db"), { recursive: true });
await mkdir(join(root, "evidence"), { recursive: true });
await mkdir(join(root, "raw"), { recursive: true });
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "commands.txt"), process.argv.join(" "), "utf8");

const sourceRepo = join(root, "source-repository");
const commitSha = await createSourceRepository(sourceRepo);
const mcpServer = join(root, "layer-two-mcp-server.cjs");
await createMcpServer(mcpServer);
process.env.AASPAI_DB = `sqlite:${dbPath}`;
const handle = createDb();
runMigrations(handle);
const store = new ExecutionStore(handle.db);
const lineage = await createLineage(store, sourceRepo, commitSha);
const main = await prepareAttempt(
  store,
  lineage,
  sourceRepo,
  "Execute the complete multi-step Layer Two WorkItem",
);
const skillDir = join(main.workspacePath, ".agents", "skills", "layer-two-real");
const configHome = join(main.workspacePath, ".opencode-config");
await mkdir(skillDir, { recursive: true });
await writeFile(
  join(skillDir, "SKILL.md"),
  "---\nname: layer-two-real\nversion: 1.0.0\n---\n# Layer Two Real Skill\nAlways preserve evidence and verify created files.\n",
  "utf8",
);
const mcpServers = {
  "layer-two-mcp": {
    type: "stdio" as const,
    command: process.execPath,
    args: [mcpServer],
  },
};
const harnessConfig = {
  command: process.execPath,
  commandArgs: [fakeCli],
  model: "opencode-go/mimo-v2.5",
  title: "Layer Two Big WorkItem",
  xdgConfigHome: configHome,
  skillsPaths: [skillDir],
  mcpServers,
};
const providerSessionId = `ses_layer_two_${randomUUID().slice(0, 8)}`;
const plan = await store.createPlan({
  id: "plan_big_workitem",
  organizationId,
  definitionRevisionId: lineage.revision.id,
  workItemId: main.workItem.id,
  attemptId: main.attempt.id,
  sourceSnapshot: {
    repositoryId: lineage.repository.id,
    commitSha,
    branchName: "main",
    capturedAt: now(),
  },
  target: { kind: "local", cwd: main.workspacePath, envPassthrough: false },
  harness: "opencode_cli",
  agentId: "agent_layer_two_big_workitem",
  idempotencyKey: `plan:${runId}:main`,
  prompt: `Complete every step in the WorkItem. <e2e:success:multi> <e2e:thinking> <e2e:tool> <e2e:response:BIG_WORKITEM_DONE> <e2e:session:${providerSessionId}>`,
  timeoutMs: 120_000,
  harnessConfig,
  workspacePolicy: { restore: "changes", cleanup: "always" },
});
const toolInvocations: string[] = [];
const tools = {
  async invoke(name: string, input: unknown) {
    assert(name === "bash", `unexpected tool ${name}`);
    toolInvocations.push(name);
    const commandResult = await command(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync('command-output.txt', 'real command completed\\n'); console.log('COMMAND_OK');",
      ],
      { cwd: main.workspacePath },
    );
    const mcpResult = await command(process.execPath, [mcpServer], {
      cwd: main.workspacePath,
      stdin:
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_step", arguments: { step: "tool" } } })}\n`,
    });
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    await writeFile(
      join(main.workspacePath, "tool-output.json"),
      JSON.stringify(
        { input, skill, command: commandResult.stdout.trim(), mcp: mcpResult.stdout.trim() },
        null,
        2,
      ),
      "utf8",
    );
    return {
      command: "COMMAND_OK",
      mcp: "MCP_TOOL_OK",
      skillLoaded: skill.includes("preserve evidence"),
    };
  },
};
const mainResult = await new HarnessExecutionPlanRunner(store).run({
  plan,
  workspace: main.workspace,
  agent: {
    id: "agent_layer_two_big_workitem",
    name: "Layer Two Big WorkItem Agent",
    adapterType: "opencode_cli",
    adapterConfig: {},
    tools,
  },
});
const mainEvidence = (await persistEvidence(store, "main", main.attempt.id, mainResult)) as {
  sessionEventKinds: string[];
  rawSequences: number[];
};
const mainSettlement = await store.completeScheduledAttempt({
  attemptId: main.attempt.id,
  status: "succeeded",
  usage: { tokens: (mainResult.usage?.inputTokens ?? 0) + (mainResult.usage?.outputTokens ?? 0) },
});
const configJson = JSON.parse(await readFile(join(configHome, "opencode", "config.json"), "utf8"));
const mcpJson = JSON.parse(await readFile(join(configHome, "opencode", "mcp.json"), "utf8"));
assert(mainResult.exitCode === 0, "main WorkItem did not succeed");
assert(toolInvocations.length === 1, "tool dispatcher was not invoked exactly once");
assert(await exists(join(main.workspacePath, "tool-output.json")), "tool output file missing");
assert(await exists(join(main.workspacePath, "command-output.txt")), "command output file missing");
assert((configJson.skills?.paths ?? []).includes(skillDir), "skill path was not configured");
assert(mcpJson.mcpServers["layer-two-mcp"], "MCP server was not configured");
assert(mainEvidence.sessionEventKinds.includes("tool_result"), "tool_result was not persisted");
assert(
  mainEvidence.rawSequences.join(",") ===
    [...mainEvidence.rawSequences].sort((a, b) => a - b).join(","),
  "raw sequence is not monotonic",
);
assert(
  mainSettlement.workItem.status === "completed",
  `WorkItem remained ${mainSettlement.workItem.status}`,
);

const resumedAttempt = await prepareAttempt(
  store,
  lineage,
  sourceRepo,
  "Resume the provider session and verify lineage",
  2,
  main.attempt.id,
);
const resumePlan = await store.createPlan({
  id: "plan_big_workitem_resume",
  organizationId,
  definitionRevisionId: lineage.revision.id,
  workItemId: resumedAttempt.workItem.id,
  attemptId: resumedAttempt.attempt.id,
  sourceSnapshot: {
    repositoryId: lineage.repository.id,
    commitSha,
    branchName: "main",
    capturedAt: now(),
  },
  target: { kind: "local", cwd: resumedAttempt.workspacePath, envPassthrough: false },
  harness: "opencode_cli",
  agentId: "agent_layer_two_big_workitem",
  idempotencyKey: `plan:${runId}:resume`,
  prompt: `Resume and append verification. <e2e:response:RESUMED_OK> <e2e:session:${providerSessionId}>`,
  timeoutMs: 120_000,
  harnessConfig: {
    ...harnessConfig,
    xdgConfigHome: join(resumedAttempt.workspacePath, ".opencode-config"),
  },
});
const resumeArgv = join(root, "resume-argv.json");
process.env.AASPAI_FAKE_OPENCODE_DUMP_ARGV = resumeArgv;
const resumedResult = await new HarnessExecutionPlanRunner(store).run({
  plan: resumePlan,
  workspace: resumedAttempt.workspace,
  agent: {
    id: "agent_layer_two_big_workitem",
    name: "Layer Two Big WorkItem Agent",
    adapterType: "opencode_cli",
    adapterConfig: {},
    resumeSessionId: providerSessionId,
  },
});
await persistEvidence(store, "resume", resumedAttempt.attempt.id, resumedResult);
const resumeSettlement = await store.completeScheduledAttempt({
  attemptId: resumedAttempt.attempt.id,
  status: "succeeded",
});
const argv = JSON.parse(await readFile(resumeArgv, "utf8"));
const resumedSession = await store.getHarnessSession(
  (await store.getAttempt(resumedAttempt.attempt.id))!.harnessSessionId!,
);
assert(resumedResult.exitCode === 0, "resume did not succeed");
assert(
  argv.includes("--session") && argv.includes(providerSessionId),
  "resume session ID did not reach provider",
);
assert(
  JSON.parse(resumedSession!.sessionParamsJson!).resume === true,
  "resume lineage was not persisted",
);
assert(resumeSettlement.workItem.status === "completed", "resume WorkItem settlement failed");

const stale = await store.createAttempt({
  id: "attempt_big_workitem_restart",
  organizationId,
  workflowRunId: lineage.workflowRun.id,
  workItemId: main.workItem.id,
  agentId: "agent_layer_two_big_workitem",
  harness: "opencode_cli",
});
await store.transitionAttempt(stale.id, "preparing");
await store.transitionAttempt(stale.id, "running");
const reconciled = await store.reconcileLostAttempts(new Date(Date.now() + 60_000).toISOString());
const restarted = await store.getAttempt(stale.id);
assert(
  reconciled >= 1 && restarted?.status === "lost",
  "restart reconciliation did not mark stale attempt lost",
);

await closeDefaultDb();
const { Sessions } = await import("@aaspai/sessions");
const { SkillRegistry } = await import("@aaspai/skills");
const lifecycleSessions = new Sessions({
  agentSource: {
    async get() {
      return {
        id: "agent_layer_two_session",
        type: "Agent",
        title: "Layer Two Session Agent",
        description: "real lifecycle probe",
        timestamp: now(),
        adapter: "opencode_cli",
        model: "opencode-go/mimo-v2.5",
        role: "general",
        reportsTo: null,
        manages: [],
        peers: [],
        systemPrompt: "",
        adapterConfig: { command: process.execPath, commandArgs: [fakeCli] },
        runtimeConfig: {},
        runtime: {},
        tools: {},
        skills: [],
        knowledge: { include: [], exclude: [] },
        budget: {},
        relations: {},
      } as never;
    },
    async has() {
      return true;
    },
    async list() {
      return ["agent_layer_two_session"];
    },
  } as never,
  knowledgeSource: {
    async get() {
      throw new Error("not found");
    },
    async has() {
      return false;
    },
    async list() {
      return [];
    },
    async search() {
      return [];
    },
  } as never,
  skillRegistry: new SkillRegistry(),
});
const sessionWorkspace = join(root, "session-workspace");
await mkdir(sessionWorkspace, { recursive: true });
const liveSessionPromise = lifecycleSessions.execute({
  organizationId,
  agentId: "agent_layer_two_session",
  adapter: "opencode_cli",
  runtime: { kind: "local", envPassthrough: false },
  cwd: sessionWorkspace,
  prompt: "Pause, resume, then cancel this live session. <e2e:hang>",
  config: { command: process.execPath, commandArgs: [fakeCli] },
  skills: [],
  budget: {},
  idempotencyKey: `session-lifecycle:${runId}`,
});
let liveSession = null as Awaited<ReturnType<typeof lifecycleSessions.get>>;
for (let attempt = 0; attempt < 30 && !liveSession; attempt += 1) {
  await delay(100);
  liveSession =
    (await lifecycleSessions.list()).find((session) => session.status === "running") ?? null;
}
assert(liveSession, "live session was not persisted");
await lifecycleSessions.pause(liveSession.id, "waiting for tool approval");
assert(
  (await lifecycleSessions.get(liveSession.id))?.status === "paused_for_question",
  "pause was not persisted",
);
await lifecycleSessions.resume(liveSession.id, "approved");
assert(
  (await lifecycleSessions.get(liveSession.id))?.status === "running",
  "resume was not persisted",
);
await lifecycleSessions.cancel(liveSession.id, "real lifecycle cancellation");
const lifecycleResult = await liveSessionPromise;
const lifecycleFinal = await lifecycleSessions.get(liveSession.id);
assert(lifecycleResult.status === "cancelled", `live session returned ${lifecycleResult.status}`);
assert(lifecycleFinal?.status === "cancelled", `live session ended as ${lifecycleFinal?.status}`);

const finalAttemptHistory = await store.listAttemptsForWorkItem(main.workItem.id);
await writeFile(
  join(root, "RESULT.md"),
  `# Big WorkItem real evidence\n\nStatus: passed\n\nWorkItem: ${main.workItem.id}\n\nWorkItem status: ${mainSettlement.workItem.status}\n\nAttempts: ${finalAttemptHistory.length}\n\nProvider session: ${providerSessionId}\n\nTool invocations: ${toolInvocations.join(", ")}\n\nRestart reconciliation: ${reconciled}\n\nSession lifecycle: pause → resume → cancel passed\n\nDatabase: ${dbPath}\n`,
  "utf8",
);
await writeFile(
  join(root, "SUMMARY.json"),
  JSON.stringify(
    {
      runId,
      root,
      database: dbPath,
      sourceRepo,
      baseCommitSha: commitSha,
      workItemId: main.workItem.id,
      workItemStatus: mainSettlement.workItem.status,
      attempts: finalAttemptHistory,
      providerSessionId,
      toolInvocations,
      mainResult,
      resumedResult,
      lifecycleResult,
      lifecycleFinal,
      reconciled,
    },
    null,
    2,
  ),
  "utf8",
);
await handle.close();
console.log(JSON.stringify({ runId, root, workItemId: main.workItem.id, status: "passed" }));
