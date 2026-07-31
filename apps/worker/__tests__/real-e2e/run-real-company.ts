import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  agentAttempts,
  delegations,
  getDefaultDb,
  loopOutputs,
  runMigrations,
  serviceAgents,
  sessions,
  wakeups,
} from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { eq } from "drizzle-orm";
import { WorkerDaemon } from "../../src/daemon.js";

const execFileAsync = promisify(execFile);
const targetName = process.argv[2];
if (!["docker", "daytona"].includes(targetName)) {
  throw new Error("Usage: run-real-company.ts <docker|daytona> [acceptance|zedblock]");
}
const scenarioName = process.argv[3] ?? "acceptance";
if (!["acceptance", "zedblock"].includes(scenarioName)) {
  throw new Error("Scenario must be acceptance or zedblock");
}
const zedblock = scenarioName === "zedblock";
const employeeSlug = zedblock ? "growth-director" : "evidence-specialist";
const employeeAgentId = `agent/${employeeSlug}`;
const employeeSkill = zedblock ? "zedblock-growth" : "employee-evidence";
const completionMarker = zedblock ? "ZEDBLOCK_GROWTH_PACKAGE_READY" : "REAL_EMPLOYEE_COMPLETED";
const employeeTitle = zedblock ? "Growth Director" : "Evidence Specialist";
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
      skillKeys: [employeeSkill],
      artifactPaths: zedblock
        ? [
            "zedblock-growth/lead-list.md",
            "zedblock-growth/campaign.md",
            "zedblock-growth/sales-playbook.md",
            "zedblock-growth/operating-report.md",
          ]
        : ["employee-proof.txt"],
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
const evidenceRoot = join(repoRoot, "workspace", "company-real", scenarioName, targetName, runId);
const repositoryPath = join(evidenceRoot, "repository");
const agentsDir = join(evidenceRoot, "definitions", "agents");
const skillsDir = join(evidenceRoot, "definitions", "skills");
const knowledgeDir = join(evidenceRoot, "definitions", "knowledge");
const loopsDir = join(evidenceRoot, "definitions", "loops");
const organizationId = `org_company_${targetName}_${runId}`;
const controlToken = randomBytes(32).toString("hex");
const upstreamModel = process.env.AASPAI_REAL_E2E_MODEL?.trim() || "poolside/laguna-s-2.1:free";
const model = `aaspai/${upstreamModel}`;
const snapshot = process.env.DAYTONA_SNAPSHOT?.trim() || "aaspai-opencode-1-18-5-v3";
let daemon: WorkerDaemon | undefined;
let gatewayProcess: ChildProcess | undefined;
let gatewaySandbox: Sandbox | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

async function openRouterKey(): Promise<string> {
  const authPath =
    process.env.AASPAI_HOST_AUTH_PATH ??
    join(process.env.USERPROFILE ?? "", ".local", "share", "opencode", "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as {
    openrouter?: { key?: string };
  };
  assert(auth.openrouter?.key, "OpenRouter credential missing from host OpenCode auth");
  return auth.openrouter.key;
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if ((await fetch(`${url}/health`).catch(() => null))?.ok) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Attempt credential gateway did not become healthy");
}

async function startGateway(): Promise<{ controlUrl: string; agentUrl: string }> {
  const upstreamKey = await openRouterKey();
  const script = join(repoRoot, "scripts", "attempt-gateway.mjs");
  if (targetName === "docker") {
    const port = 18_787;
    gatewayProcess = spawn(process.execPath, [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GATEWAY_CONTROL_TOKEN: controlToken,
        OPENROUTER_API_KEY: upstreamKey,
        GATEWAY_PORT: String(port),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const controlUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(controlUrl);
    return { controlUrl, agentUrl: `http://host.docker.internal:${port}` };
  }

  assert(process.env.DAYTONA_API_KEY, "DAYTONA_API_KEY is required for the Daytona run");
  gatewaySandbox = await new Daytona().create(
    {
      snapshot,
      ephemeral: true,
      public: true,
      labels: { "aaspai-role": "attempt-credential-gateway", "aaspai-run": runId },
    },
    { timeout: 180 },
  );
  await gatewaySandbox.fs.uploadFile(script, "/tmp/aaspai-attempt-gateway.mjs");
  const launch = await gatewaySandbox.process.executeCommand(
    [
      `GATEWAY_CONTROL_TOKEN=${quote(controlToken)}`,
      `OPENROUTER_API_KEY=${quote(upstreamKey)}`,
      "nohup node /tmp/aaspai-attempt-gateway.mjs",
      ">/tmp/aaspai-attempt-gateway.log 2>&1 </dev/null &",
    ].join(" "),
    "/",
    undefined,
    30,
  );
  assert(launch.exitCode === 0, "Daytona credential gateway failed to launch");
  const preview = await gatewaySandbox.getPreviewLink(8787);
  const url = preview.url.replace(/\/+$/, "");
  await waitForHealth(url);
  return { controlUrl: url, agentUrl: url };
}

async function ensureDockerImage(): Promise<void> {
  if (targetName !== "docker") return;
  await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
    windowsHide: true,
  });
  const image = process.env.AASPAI_REAL_DOCKER_IMAGE ?? "aaspai-opencode-test:latest";
  try {
    await execFileAsync("docker", ["image", "inspect", image], { windowsHide: true });
  } catch {
    throw new Error(`Required local runtime image is missing: ${image}`);
  }
}

async function prepareDefinitions(agentUrl: string): Promise<void> {
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

  const runtime =
    targetName === "docker"
      ? {
          default: {
            kind: "docker",
            image: process.env.AASPAI_REAL_DOCKER_IMAGE ?? "aaspai-opencode-test:latest",
            remoteCwd: "/workspace",
            network: "bridge",
          },
        }
      : {
          default: {
            kind: "sandbox",
            provider: "daytona",
            remoteCwd: "/workspace",
            timeoutMs: 300_000,
          },
        };
  const adapterConfig = {
    providers: {
      aaspai: {
        npm: "@ai-sdk/openai-compatible",
        name: "AASPAI attempt gateway",
        options: {
          baseURL: `${agentUrl}/v1`,
          apiKey: "{env:AASPAI_ATTEMPT_TOKEN}",
        },
        models: {
          [upstreamModel]: {
            name: `${upstreamModel} via attempt gateway`,
            limit: { context: 128_000, output: 4_096 },
          },
        },
      },
    },
  };
  await writeFile(
    join(agentsDir, "ceo", "AGENT.md"),
    `---
id: agent/ceo
type: Agent
title: Chief Executive Officer
description: Runs the company and hires only when the work requires it.
timestamp: 2026-07-29T00:00:00.000Z
adapter: opencode_cli
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
    `${JSON.stringify({ adapterConfig, runtimeConfig: runtime }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(agentsDir, "ceo", "tools.yaml"),
    "allow: [skill, read, write, bash, company_action]\ndeny: []\nrequire_approval_for: []\n",
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
adapterTypes: [opencode_cli]
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
adapterTypes: [opencode_cli]
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

async function waitForEmployee(store: ExecutionStore, workflowRunId: string) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const items = await store.listWorkItemsForWorkflow(organizationId, workflowRunId);
    if (items.length === 2 && items.every((item) => item.status === "completed")) return items;
    const failed = items.find((item) => ["failed", "blocked", "cancelled"].includes(item.status));
    if (failed)
      throw new Error(`Work ${failed.id} ended as ${failed.status}: ${failed.blockedReason}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Employee work did not complete within six minutes");
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
  await ensureDockerImage();
  const gateway = await startGateway();
  await prepareDefinitions(gateway.agentUrl);
  const databasePath = join(evidenceRoot, "state.db");
  process.env.AASPAI_DB = `sqlite:${databasePath}`;
  process.env.AASPAI_AGENTS_DIR = agentsDir;
  process.env.AASPAI_SKILLS_DIR = skillsDir;
  process.env.AASPAI_KNOWLEDGE_DIR = knowledgeDir;
  process.env.AASPAI_LOOPS_DIR = loopsDir;
  process.env.AASPAI_DEFINITIONS_DIR = repositoryPath;
  process.env.AASPAI_WORKSPACE_ROOT = join(evidenceRoot, "workspaces");
  process.env.AASPAI_ARTIFACTS_ROOT = join(evidenceRoot, "artifacts");
  process.env.AASPAI_GATEWAY_CONTROL_URL = gateway.controlUrl;
  process.env.AASPAI_GATEWAY_CONTROL_TOKEN = controlToken;
  process.env.DAYTONA_SNAPSHOT = snapshot;
  delete process.env.AASPAI_HOST_AUTH_PATH;

  const handle = getDefaultDb();
  runMigrations(handle);
  const store = new ExecutionStore(handle.db);
  const baseCommit = await git(["rev-parse", "HEAD"]);
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
  const parent = await store.createWorkItem({
    organizationId,
    goalId: goal.id,
    projectId: project.id,
    repositoryId: repository.id,
    workflowRunId: workflow.id,
    title: zedblock ? "Staff and operate ZedBlock growth" : "Hire and delegate with real tools",
    description: zedblock
      ? "Act as CEO of zedblock.com. First load and follow the company-operator skill. Hire the Growth Director through the structured company-action result and delegate the real lead-research, campaign, and sales-pipeline assignment. Your job ends after returning the structured action; do not execute the employee assignment. Never simulate outreach, a prospect reply, or a closed client."
      : "First load and follow the company-operator skill. Hire the required specialist through the structured company-action result and delegate the evidence assignment. Do not simulate any action.",
    status: "ready",
    definitionRevisionId: revision.id,
    sourceCommitSha: baseCommit,
    maxAttempts: 1,
    idempotencyKey: `parent:${runId}`,
    workKind: "general",
    deliveryMode: "none",
    metadata: {
      requiredCompanyActions: [{ type: "hire_and_delegate" }],
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
      adapter: "opencode_cli",
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
    adapter: "opencode_cli",
    runtimeJson: "{}",
    prompt: parent.description,
    configJson: "{}",
    status: "queued",
  });
  const workItems = await waitForEmployee(store, workflow.id);
  const child = workItems.find((item) => item.id !== parent.id);
  assert(child, "Delegated child work was not created");
  const attempts = await handle.db
    .select()
    .from(agentAttempts)
    .where(eq(agentAttempts.workflowRunId, workflow.id));
  const ceoAttempt = attempts.find((attempt) => attempt.agentId === "agent/ceo");
  const employeeAttempt = attempts.find((attempt) => attempt.agentId === employeeAgentId);
  assert(ceoAttempt?.status === "succeeded", "CEO attempt did not succeed");
  assert(employeeAttempt?.status === "succeeded", "Employee attempt did not succeed");
  assert(employeeAttempt.workItemId === child.id, "Employee did not own delegated work");

  const ceoEvents = ceoAttempt.harnessSessionId
    ? await store.listHarnessSessionEvents(ceoAttempt.harnessSessionId)
    : [];
  const employeeEvents = employeeAttempt.harnessSessionId
    ? await store.listHarnessSessionEvents(employeeAttempt.harnessSessionId)
    : [];
  assert(provesSkill(ceoEvents, "company-operator"), "CEO session does not prove real skill use");
  assert(provesTool(ceoEvents, "bash"), "CEO session does not prove real tool use");
  assert(
    provesSkill(employeeEvents, employeeSkill),
    "Employee session does not prove real skill use",
  );
  assert(provesTool(employeeEvents, "bash"), "Employee session does not prove real bash-tool use");

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

  const runtimeKind = targetName === "docker" ? "docker" : "sandbox";
  for (const attempt of [ceoAttempt, employeeAttempt]) {
    const events = await store.listEvents(attempt.id);
    assert(
      events.some(
        (event) =>
          event.type === "harness.session.completed" &&
          (event.payload.runtimeIdentity as { kind?: unknown } | undefined)?.kind === runtimeKind,
      ),
      `${attempt.agentId} did not execute in the selected ${runtimeKind} runtime`,
    );
  }
  const gatewayAudit = await fetch(`${gateway.controlUrl}/audit`, {
    headers: { authorization: `Bearer ${controlToken}` },
  }).then((response) => response.json() as Promise<Record<string, number>>);
  assert(gatewayAudit.issued === 2, `expected two credentials, got ${gatewayAudit.issued}`);
  assert(gatewayAudit.revoked === 2, `expected two revocations, got ${gatewayAudit.revoked}`);
  assert((gatewayAudit.proxied ?? 0) > 0, "Real provider traffic was not proxied");

  const result = {
    status: "passed",
    target: targetName,
    runId,
    organizationId,
    goalId: goal.id,
    workflowRunId: workflow.id,
    parentWorkItemId: parent.id,
    employeeWorkItemId: child.id,
    ceoAttemptId: ceoAttempt.id,
    employeeAttemptId: employeeAttempt.id,
    ceoSessionId: ceoAttempt.harnessSessionId,
    employeeSessionId: employeeAttempt.harnessSessionId,
    scenario: scenarioName,
    hiredAgentId: employeeAgentId,
    gatewayAudit,
    ceoSessionEventCount: ceoEvents.length,
    employeeSessionEventCount: employeeEvents.length,
    evidenceRoot,
  };
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
    gatewayProcess?.kill();
    await gatewaySandbox?.delete(120).catch(() => undefined);
  });
