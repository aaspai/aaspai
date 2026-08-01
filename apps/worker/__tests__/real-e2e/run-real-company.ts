import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CompanyCommandService } from "@aaspai/company";
import {
  agentAttempts,
  companyProfiles,
  delegations,
  executionVerifications,
  getDefaultDb,
  loopOutputs,
  runMigrations,
  serviceAgents,
  sessions,
  wakeups,
  workflowRuns,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { observeExecution } from "@aaspai/observability";
import { eq } from "drizzle-orm";
import { WorkerDaemon } from "../../src/daemon.js";

const execFileAsync = promisify(execFile);
const targetName = process.argv[2];
if (targetName !== "local" && targetName !== "simulation") {
  throw new Error("Usage: run-real-company.ts <local|simulation> [acceptance|zedblock]");
}
const scenarioName = process.argv[3] ?? "acceptance";
if (!["acceptance", "zedblock"].includes(scenarioName)) {
  throw new Error("Scenario must be acceptance or zedblock");
}
const zedblock = scenarioName === "zedblock";
const simulated = targetName === "simulation";
if (simulated && zedblock) throw new Error("ZedBlock is a real-agent scenario; use acceptance");
const adapter = simulated ? "dry_run_local" : "opencode_cli";
const employeeSlug = simulated
  ? "market-researcher"
  : zedblock
    ? "growth-director"
    : "evidence-specialist";
const employeeAgentId = `agent/${employeeSlug}`;
const employeeSkill = zedblock ? "zedblock-growth" : "employee-evidence";
const completionMarker = simulated
  ? "# Plan (dry-run)"
  : zedblock
    ? "ZEDBLOCK_GROWTH_PACKAGE_READY"
    : "REAL_EMPLOYEE_COMPLETED";
const employeeTitle = simulated
  ? "Market Researcher"
  : zedblock
    ? "Growth Director"
    : "Evidence Specialist";
const employeeRole = zedblock ? "cmo" : "researcher";
const employeeDescription = zedblock
  ? "Researches qualified professional-services leads and builds evidence-backed campaigns and sales playbooks."
  : "Uses pinned skills and real tools to produce verified operational evidence.";
const workTitle = zedblock
  ? "Build ZedBlock lead and campaign pipeline"
  : "Produce verified employee evidence";
const workDescription = zedblock
  ? "First load and follow the zedblock-growth skill. Use real public-web research and native tools to produce a sourced lead list, campaign plan, outreach drafts, qualification rubric, objection handling, and approval-gated sales pipeline for zedblock.com. Never contact prospects or claim a client was closed. End with ZEDBLOCK_GROWTH_PACKAGE_READY."
  : "First load and follow the employee-evidence skill. Use the native write and bash tools to create and verify employee-proof.txt. Your final response must include REAL_EMPLOYEE_COMPLETED and the exact SHA-256 reported by the command.";
const companyAction = {
  actions: [
    {
      type: "hire_and_delegate",
      agentId: employeeAgentId,
      title: employeeTitle,
      role: employeeRole,
      description: employeeDescription,
      workTitle,
      workDescription,
      ...(simulated
        ? {}
        : {
            skillKeys: [employeeSkill],
            artifactPaths: zedblock
              ? [
                  "zedblock-growth/lead-list.md",
                  "zedblock-growth/campaign.md",
                  "zedblock-growth/sales-playbook.md",
                  "zedblock-growth/operating-report.md",
                ]
              : ["employee-proof.txt"],
          }),
      ...(zedblock
        ? {
            citationPaths: ["zedblock-growth/lead-list.md"],
            commercialClaimPaths: [
              "zedblock-growth/campaign.md",
              "zedblock-growth/sales-playbook.md",
            ],
          }
        : {}),
    },
  ],
};

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const evidenceRoot = join(
  repoRoot,
  "workspace",
  simulated ? "company-simulation" : "company-real",
  scenarioName,
  targetName,
  runId,
);
const repositoryPath = join(evidenceRoot, "repository");
const agentsDir = join(evidenceRoot, "definitions", "agents");
const skillsDir = join(evidenceRoot, "definitions", "skills");
const knowledgeDir = join(evidenceRoot, "definitions", "knowledge");
const loopsDir = join(evidenceRoot, "definitions", "loops");
const organizationId = `org_company_${targetName}_${runId}`;
const model = process.env.AASPAI_REAL_E2E_MODEL?.trim() || "opencode-go/mimo-v2.5";
let daemon: WorkerDaemon | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function git(args: string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd: repositoryPath,
      windowsHide: true,
      encoding: "utf8",
    })
  ).stdout.trim();
}

async function prepareDefinitions(): Promise<void> {
  for (const directory of [
    repositoryPath,
    agentsDir,
    skillsDir,
    knowledgeDir,
    loopsDir,
    join(agentsDir, "ceo"),
    join(skillsDir, "company-operator"),
    join(skillsDir, employeeSkill),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "company-real@example.test"]);
  await git(["config", "user.name", "Company Real Acceptance"]);
  await writeFile(join(repositoryPath, "README.md"), "# Real company acceptance\n", "utf8");
  await git(["add", "."]);
  await git(["commit", "-m", "acceptance base"]);

  const runtime = { default: { kind: "local", envPassthrough: false } };
  await writeFile(
    join(agentsDir, "ceo", "AGENT.md"),
    `---
id: agent/ceo
type: Agent
title: Chief Executive Officer
description: Runs the company and hires only when the work requires it.
timestamp: 2026-07-29T00:00:00.000Z
adapter: ${adapter}
model: ${model}
role: ceo
reportsTo: null
manages: []
peers: []
knowledge: { include: [], exclude: [] }
budget: {}
---

Use the company-operator skill for staffing decisions. Perform real tool calls and never claim an action happened unless the structured company-action result was returned.
`,
    "utf8",
  );
  await writeFile(
    join(agentsDir, "ceo", "config.yaml"),
    `${JSON.stringify({ adapterConfig: {}, runtimeConfig: runtime }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(agentsDir, "ceo", "tools.yaml"),
    simulated
      ? "allow: []\ndeny: []\nrequire_approval_for: []\n"
      : "allow: [skill, read, write, bash, websearch, browser_snapshot, company_action]\ndeny: []\nrequire_approval_for: []\n",
    "utf8",
  );
  await writeFile(
    join(agentsDir, "ceo", "skills.lock.json"),
    `${JSON.stringify([
      { key: "company-operator", version: "1.0.0" },
      { key: employeeSkill, version: "1.0.0" },
    ])}\n`,
    "utf8",
  );
  await writeFile(
    join(skillsDir, "company-operator", "SKILL.md"),
    `---
key: company-operator
version: 1.0.0
name: Company Operator
description: Hire a specialist and delegate durable work through the structured company-action result.
adapterTypes: [${adapter}]
owner: acceptance
visibility: private
createdAt: 2026-07-29T00:00:00.000Z
updatedAt: 2026-07-29T00:00:00.000Z
---

For this acceptance task, call the \`company_action\` tool once with \`payload\` set to this exact JSON string:

\`\`\`json
${JSON.stringify(companyAction)}
\`\`\`

Do not write a hiring manifest or perform the delegated employee assignment yourself. After the tool succeeds, end with REAL_CEO_ACTION_WRITTEN.
`,
    "utf8",
  );
  await writeFile(
    join(skillsDir, employeeSkill, "SKILL.md"),
    `---
key: ${employeeSkill}
version: 1.0.0
name: ${zedblock ? "ZedBlock Growth" : "Employee Evidence"}
description: ${zedblock ? "Build a sourced, approval-gated growth pipeline for ZedBlock." : "Produce and verify evidence using native runtime tools."}
adapterTypes: [${adapter}]
owner: acceptance
visibility: private
createdAt: 2026-07-29T00:00:00.000Z
updatedAt: 2026-07-29T00:00:00.000Z
---

${
  zedblock
    ? `You are the Growth Director for https://www.zedblock.com.

Use real native tools. Fetch ZedBlock's public website and research public company websites for potential professional-services prospects. Focus on law firms, accounting practices, and consultancies that plausibly suffer from manual document intake, client onboarding, compliance review, reporting, or CRM handoffs.

Create these files under \`zedblock-growth/\`:
- \`lead-list.md\`: at least 8 real organizations, public source URL, segment, observable evidence, likely automation pain, fit rationale, and confidence. Do not invent contacts or private data.
- \`campaign.md\`: positioning, offer, three-channel campaign, five-email sequence, LinkedIn drafts, CTA, KPIs, and experiment plan.
- \`sales-playbook.md\`: qualification rubric, discovery questions, objection handling, proposal path, approval gates, and explicit definition of what counts as closed.
- \`operating-report.md\`: actions taken, tool evidence, limitations, next actions, and the exact approval required before outreach.

Use bash to verify the files exist and report their line counts. Do not send messages, submit forms, book calls, or claim any prospect replied or became a client. End with ZEDBLOCK_GROWTH_PACKAGE_READY.`
    : `Use the native write tool to create employee-proof.txt containing exactly REAL_EMPLOYEE_TOOL_EVIDENCE.
Use the native bash tool to run \`sha256sum employee-proof.txt\`.
Read the file back. Your final response must include REAL_EMPLOYEE_COMPLETED and the exact SHA-256.`
}
`,
    "utf8",
  );
}

async function waitForEmployee(store: ExecutionStore, goalId: string, parentWorkItemId: string) {
  while (true) {
    const items = await store.listWorkItems(organizationId, goalId);
    const parent = items.find((item) => item.id === parentWorkItemId);
    const child = items.find((item) => item.parentWorkItemId === parentWorkItemId);
    if (parent?.status === "completed" && child?.status === "completed") return [parent, child];
    const failed = items.find((item) => ["failed", "blocked", "cancelled"].includes(item.status));
    if (failed)
      throw new Error(`Work ${failed.id} ended as ${failed.status}: ${failed.blockedReason}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
}

async function waitForSimulatedProcess(store: ExecutionStore, goalId: string) {
  while (true) {
    const runs = await getDefaultDb()
      .db.select()
      .from(workflowRuns)
      .where(eq(workflowRuns.organizationId, organizationId));
    const processRun = runs.find((run) => run.sourceType === "operator");
    if (processRun?.status === "failed") throw new Error("Simulated manager process failed");
    if (processRun?.status === "succeeded") {
      const items = (await store.listWorkItems(organizationId, goalId)).filter(
        (item) => item.workflowRunId === processRun.id,
      );
      const verifications = await getDefaultDb()
        .db.select()
        .from(executionVerifications)
        .where(eq(executionVerifications.organizationId, organizationId));
      assert(items.length > 0, "Simulated process created no work");
      assert(
        items.every((item) => item.status === "completed"),
        "Process work is incomplete",
      );
      assert(
        verifications.some(
          (verification) =>
            items.some((item) => item.id === verification.workItemId) &&
            verification.status === "passed",
        ),
        "Process work did not pass independent verification",
      );
      return processRun;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

function provesTool(events: Array<{ payloadJson: string }>, tool: string): boolean {
  return events.some((event) =>
    event.payloadJson.toLowerCase().includes(`\\"tool\\":\\"${tool}\\"`),
  );
}

function provesSkill(events: Array<{ payloadJson: string }>, slug: string): boolean {
  return (
    provesTool(events, "skill") ||
    events.some((event) =>
      event.payloadJson.toLowerCase().includes(`/skills/${slug.toLowerCase()}/skill.md`),
    )
  );
}

async function main(): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  await prepareDefinitions();
  const databasePath = join(evidenceRoot, "state.db");
  process.env.AASPAI_DB = `sqlite:${databasePath}`;
  process.env.AASPAI_AGENTS_DIR = agentsDir;
  process.env.AASPAI_SKILLS_DIR = skillsDir;
  process.env.AASPAI_KNOWLEDGE_DIR = knowledgeDir;
  process.env.AASPAI_LOOPS_DIR = loopsDir;
  process.env.AASPAI_DEFINITIONS_DIR = repositoryPath;
  process.env.AASPAI_WORKSPACE_ROOT = join(evidenceRoot, "workspaces");
  process.env.AASPAI_ARTIFACTS_ROOT = join(evidenceRoot, "artifacts");

  const handle = getDefaultDb();
  runMigrations(handle);
  const store = new ExecutionStore(handle.db);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  const createdAt = new Date().toISOString();
  await handle.db.insert(companyProfiles).values({
    organizationId,
    description: zedblock ? "ZedBlock autonomous growth company" : "Real company acceptance",
    lifecycleStatus: "active",
    ceoAgentId: "agent/ceo",
    createdAt,
    updatedAt: createdAt,
  });
  const goal = await store.createGoal({
    organizationId,
    title: zedblock
      ? `Build ZedBlock's real growth pipeline on ${targetName}`
      : `Run a real company on ${targetName}`,
    status: "active",
  });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: zedblock ? "ZedBlock growth company" : "Real company acceptance",
  });
  if (simulated) {
    await new CompanyCommandService(handle.db).execute({
      type: "appoint_project_manager",
      organizationId,
      actorId: "agent/ceo",
      idempotencyKey: `simulation-manager:${runId}`,
      projectId: project.id,
      agentId: "agent/ceo",
    });
  }
  const repository = await store.createRepository({
    organizationId,
    projectId: project.id,
    purpose: "project",
    provider: "local",
    localPath: repositoryPath,
    defaultBranch: "main",
  });
  const revision = await store.createDefinitionRevision({
    organizationId,
    repositoryId: repository.id,
    commitSha: baseCommit,
    sourcePath: ".",
    contentHash: baseCommit,
  });
  const workflow = await store.createWorkflowRun({
    organizationId,
    goalId: goal.id,
    definitionRevisionId: revision.id,
    sourceType: "real-company-acceptance",
    idempotencyKey: `real-company:${targetName}:${runId}`,
  });
  const simulationActions = [
    ...companyAction.actions.map((action) => ({ ...action, projectId: project.id })),
    {
      type: "create_milestone",
      projectId: project.id,
      title: "Validate the first operating outcome",
      outcome: "One evidence-backed research report is completed",
      sequence: 1,
      acceptance: { reports: 1 },
    },
    {
      type: "define_and_start_process",
      projectId: project.id,
      milestoneSequence: 1,
      definition: {
        id: "process/simulation-research",
        organizationId,
        revision: 1,
        contentHash: "simulation-research-v1",
        name: "Simulation research",
        description: "Exercise a bounded company process without a model call.",
        steps: [
          {
            id: "step/research",
            agent: employeeAgentId,
            routingRule: null,
            dependsOn: [],
            prompt: "Produce one simulated research report.",
            skills: [],
            tools: [],
            workKind: "general",
            deliveryMode: "none",
            timeoutMs: 60_000,
            maxAttempts: 2,
            acceptanceCriteria: "A report is durably recorded.",
            failureAction: "escalate",
            approvalPolicy: {},
          },
        ],
        maxDurationMs: 300_000,
        maxAttempts: 3,
        createdAt,
      },
      policy: {},
    },
  ];
  const parentDescription = simulated
    ? `Exercise every company control through the deterministic simulator.\nAASPAI_SIMULATION_COMPANY_ACTIONS=${JSON.stringify(simulationActions)}`
    : zedblock
      ? "Act as CEO of zedblock.com. First load and follow the company-operator skill. Hire the Growth Director through the structured company-action result and delegate the real lead-research, campaign, and sales-pipeline assignment. Your job ends after returning the structured action; do not execute the employee assignment. Never simulate outreach, a prospect reply, or a closed client."
      : "First load and follow the company-operator skill. Hire the required specialist through the structured company-action result and delegate the evidence assignment. Do not simulate any action.";
  const parent = await store.createWorkItem({
    organizationId,
    goalId: goal.id,
    projectId: project.id,
    repositoryId: repository.id,
    workflowRunId: workflow.id,
    title: zedblock ? "Staff and operate ZedBlock growth" : "Hire and delegate with real tools",
    description: parentDescription,
    status: "ready",
    definitionRevisionId: revision.id,
    sourceCommitSha: baseCommit,
    maxAttempts: 1,
    idempotencyKey: `parent:${runId}`,
    workKind: "general",
    deliveryMode: "none",
    metadata: {
      requiredCompanyActions: simulated
        ? [
            { type: "create_milestone", projectId: project.id },
            { type: "define_and_start_process", projectId: project.id },
            { type: "hire_and_delegate", projectId: project.id },
          ]
        : [{ type: "hire_and_delegate" }],
    },
  });

  daemon = new WorkerDaemon({
    organizationId,
    tickIntervalMs: 3_600_000,
    wakeupPollIntervalMs: 500,
  });
  await daemon.start();
  const requestedAt = new Date().toISOString();
  const initialWakeupId = `wake_${randomUUID()}`;
  const initialSessionId = `sess_${randomUUID()}`;
  await handle.db.insert(wakeups).values({
    id: initialWakeupId,
    organizationId,
    loopId: "manual",
    source: "founder",
    triggerDetail: "real-company-acceptance",
    reason: "Founder requested a real hire and delegation",
    agentId: "agent/ceo",
    payloadJson: JSON.stringify({
      prompt: parent.description,
      adapter,
      sessionId: initialSessionId,
      workItemId: parent.id,
      workflowRunId: workflow.id,
    }),
    status: "queued",
    idempotencyKey: `initial:${runId}`,
    requestedAt,
    requestedByActorId: "acceptance",
    requestedByActorType: "user",
  });
  await handle.db.insert(sessions).values({
    id: initialSessionId,
    organizationId,
    wakeupId: initialWakeupId,
    agentId: "agent/ceo",
    adapter,
    runtimeJson: "{}",
    prompt: parent.description,
    configJson: "{}",
    status: "queued",
  });
  const workItems = await waitForEmployee(store, goal.id, parent.id);
  const simulationProcess = simulated ? await waitForSimulatedProcess(store, goal.id) : null;
  const child = workItems.find((item) => item.id !== parent.id);
  assert(child, "Delegated child work was not created");
  const attempts = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.organizationId, organizationId));
  const ceoAttempt = attempts.find((attempt) => attempt.workItemId === parent.id);
  const employeeAttempt = attempts.find((attempt) => attempt.workItemId === child.id);
  assert(ceoAttempt?.status === "succeeded", "CEO attempt did not succeed");
  assert(employeeAttempt?.status === "succeeded", "Employee attempt did not succeed");
  assert(employeeAttempt.workItemId === child.id, "Employee did not own delegated work");

  const ceoEvents = ceoAttempt.harnessSessionId
    ? await store.listHarnessSessionEvents(ceoAttempt.harnessSessionId)
    : [];
  const employeeEvents = employeeAttempt.harnessSessionId
    ? await store.listHarnessSessionEvents(employeeAttempt.harnessSessionId)
    : [];
  if (!simulated) {
    assert(provesSkill(ceoEvents, "company-operator"), "CEO session does not prove real skill use");
    assert(provesTool(ceoEvents, "company_action"), "CEO session does not prove typed action use");
    assert(
      provesSkill(employeeEvents, employeeSkill),
      "Employee session does not prove real skill use",
    );
    assert(
      provesTool(employeeEvents, "bash"),
      "Employee session does not prove real bash-tool use",
    );
  }

  const employeeOutputs = await handle.db
    .select()
    .from(loopOutputs)
    .where(eq(loopOutputs.workItemId, child.id));
  assert(employeeOutputs.length === 1, "Employee report was not persisted");
  assert(
    employeeOutputs[0]?.body.includes(completionMarker) ||
      employeeEvents.some((event) => event.payloadJson.includes(completionMarker)),
    "Employee report does not contain the real completion marker",
  );
  const hired = await handle.db
    .select()
    .from(serviceAgents)
    .where(eq(serviceAgents.agentId, employeeAgentId));
  const durableDelegations = await handle.db
    .select()
    .from(delegations)
    .where(eq(delegations.workItemId, child.id));
  assert(hired.length === 1, "Hired employee was not registered");
  assert(durableDelegations.length === 1, "Delegation was not persisted");
  assert(
    (await stat(join(agentsDir, employeeSlug, "AGENT.md"))).isFile(),
    "Hired employee definition was not materialized",
  );

  if (!simulated) {
    for (const attempt of [ceoAttempt, employeeAttempt]) {
      const events = await store.listEvents(attempt.id);
      assert(
        events.some(
          (event) =>
            event.type === "harness.session.completed" &&
            (event.payload.runtimeIdentity as { kind?: unknown } | undefined)?.kind === "local",
        ),
        `${attempt.agentId} did not execute in the selected local runtime`,
      );
    }
  }
  const timelines = await Promise.all(
    [ceoAttempt, employeeAttempt].map(async (attempt) => ({
      attemptId: attempt.id,
      agentId: attempt.agentId,
      events: observeExecution({
        executionEvents: (await store.listEvents(attempt.id)).map((event) => ({
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          type: event.type,
          payload: event.payload,
        })),
        sessionEvents: (attempt.agentId === "agent/ceo" ? ceoEvents : employeeEvents).map(
          (event) => ({
            id: event.id,
            seq: event.seq,
            ts: event.ts,
            kind: event.kind,
            payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
          }),
        ),
      }),
    })),
  );
  const result = {
    status: "passed",
    target: targetName,
    runId,
    organizationId,
    goalId: goal.id,
    workflowRunId: workflow.id,
    parentWorkItemId: parent.id,
    employeeWorkItemId: child.id,
    processWorkflowRunId: simulationProcess?.id ?? null,
    ceoAttemptId: ceoAttempt.id,
    employeeAttemptId: employeeAttempt.id,
    ceoSessionId: ceoAttempt.harnessSessionId,
    employeeSessionId: employeeAttempt.harnessSessionId,
    scenario: scenarioName,
    hiredAgentId: employeeAgentId,
    ceoSessionEventCount: ceoEvents.length,
    employeeSessionEventCount: employeeEvents.length,
    companyEventCount: timelines
      .flatMap((timeline) => timeline.events)
      .filter((event) => event.lane === "company").length,
    workEventCount: timelines
      .flatMap((timeline) => timeline.events)
      .filter((event) => event.lane === "work").length,
    evidenceRoot,
  };
  await writeFile(join(evidenceRoot, "TIMELINE.json"), `${JSON.stringify(timelines, null, 2)}\n`);
  await writeFile(join(evidenceRoot, "SUMMARY.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(
    join(evidenceRoot, "RESULT.md"),
    `# Real company acceptance\n\nStatus: passed\n\nScenario: ${scenarioName}\n\nTarget: ${targetName}\n\nEmployee: ${employeeAgentId}\n\nWork: ${child.id}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(async (error) => {
    await mkdir(evidenceRoot, { recursive: true }).catch(() => undefined);
    await writeFile(
      join(evidenceRoot, "RESULT.md"),
      `# Real company acceptance\n\nStatus: failed\n\n${String(error)}\n`,
    ).catch(() => undefined);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await daemon?.stop().catch(() => undefined);
  });
