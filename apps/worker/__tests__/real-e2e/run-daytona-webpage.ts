import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getDefaultDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { WorkerDaemon } from "../../src/daemon.js";

const execFileAsync = promisify(execFile);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const evidenceRoot = join(repoRoot, "workspace", "worker-daytona", runId);
const repositoryPath = join(evidenceRoot, "repository");
const agentsDir = join(evidenceRoot, "definitions", "agents");
const skillsDir = join(evidenceRoot, "definitions", "skills");
const knowledgeDir = join(evidenceRoot, "definitions", "knowledge");
const loopsDir = join(evidenceRoot, "definitions", "loops");
const organizationId = `org_worker_daytona_${runId}`;
const agentId = "agent/web-builder";
const signature = "Built with the AASPAI Sunrise Standard";
const snapshot = process.env.DAYTONA_SNAPSHOT?.trim() || "aaspai-opencode-1-18-5-v3";
const controlToken = randomBytes(32).toString("hex");
let gateway: Sandbox | undefined;
let daemon: WorkerDaemon | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function git(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryPath,
    windowsHide: true,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function startGateway(): Promise<string> {
  const authPath =
    process.env.AASPAI_HOST_AUTH_PATH ??
    join(process.env.USERPROFILE ?? "", ".local", "share", "opencode", "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as {
    openrouter?: { key?: string };
  };
  assert(auth.openrouter?.key, "OpenRouter credential missing from host OpenCode auth");
  const daytona = new Daytona();
  gateway = await daytona.create(
    {
      snapshot,
      ephemeral: true,
      public: true,
      labels: { "aaspai-role": "attempt-credential-gateway", "aaspai-run": runId },
    },
    { timeout: 180 },
  );
  const gatewayScript = join(repoRoot, "scripts", "attempt-gateway.mjs");
  await gateway.fs.uploadFile(gatewayScript, "/tmp/aaspai-attempt-gateway.mjs");
  const launch = await gateway.process.executeCommand(
    [
      `GATEWAY_CONTROL_TOKEN=${quote(controlToken)}`,
      `OPENROUTER_API_KEY=${quote(auth.openrouter.key)}`,
      "nohup node /tmp/aaspai-attempt-gateway.mjs",
      ">/tmp/aaspai-attempt-gateway.log 2>&1 </dev/null &",
    ].join(" "),
    "/",
    undefined,
    30,
  );
  assert(launch.exitCode === 0, "Credential gateway failed to launch");
  const preview = await gateway.getPreviewLink(8787);
  const baseUrl = preview.url.replace(/\/+$/, "");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await fetch(`${baseUrl}/health`).catch(() => null))?.ok) return baseUrl;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Credential gateway did not become healthy");
}

async function prepareFiles(gatewayUrl: string): Promise<void> {
  for (const directory of [
    repositoryPath,
    agentsDir,
    skillsDir,
    knowledgeDir,
    loopsDir,
    join(agentsDir, "web-builder"),
    join(skillsDir, "sunrise-web"),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "worker-daytona@example.test"]);
  await git(["config", "user.name", "Worker Daytona Acceptance"]);
  await writeFile(join(repositoryPath, "README.md"), "# Sunrise landing page\n", "utf8");
  await writeFile(
    join(repositoryPath, "verify.mjs"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const html = await readFile("index.html", "utf8");
const css = await readFile("styles.css", "utf8");
assert.match(html, /<main[\\s>]/i);
assert.match(html, /<a[\\s>]/i);
assert.ok(html.includes("${signature}"));
assert.match(css, /:focus-visible/i);
assert.match(css, /@media/i);
console.log("PASS: semantic main, CTA, skill signature, focus style, responsive CSS");
`,
    "utf8",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "acceptance base"]);

  await writeFile(
    join(agentsDir, "web-builder", "AGENT.md"),
    `---
id: agent/web-builder
type: Agent
title: Web Builder
description: Builds and verifies a small static webpage.
timestamp: 2026-07-29T00:00:00.000Z
adapter: opencode_cli
model: aaspai/poolside/laguna-s-2.1:free
role: engineer
reportsTo: null
manages: []
peers: []
knowledge: { include: [], exclude: [] }
budget: {}
---

Build the requested webpage, follow selected skills, and verify the output.
`,
    "utf8",
  );
  await writeFile(
    join(agentsDir, "web-builder", "config.yaml"),
    JSON.stringify(
      {
        adapterConfig: {
          dangerouslySkipPermissions: true,
          providers: {
            aaspai: {
              npm: "@ai-sdk/openai-compatible",
              name: "AASPAI attempt gateway",
              options: {
                baseURL: `${gatewayUrl}/v1`,
                apiKey: "{env:AASPAI_ATTEMPT_TOKEN}",
              },
              models: {
                "poolside/laguna-s-2.1:free": {
                  name: "Laguna S 2.1 free via attempt gateway",
                  limit: { context: 128_000, output: 2_048 },
                },
              },
            },
          },
        },
        runtimeConfig: {
          default: {
            kind: "sandbox",
            provider: "daytona",
            remoteCwd: "/workspace",
            timeoutMs: 300_000,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(agentsDir, "web-builder", "tools.yaml"),
    "allow: [Read, Write, Edit, Bash]\ndeny: []\nrequire_approval_for: []\n",
    "utf8",
  );
  await writeFile(
    join(agentsDir, "web-builder", "skills.lock.json"),
    '[{"key":"sunrise-web","version":"1.0.0"}]\n',
    "utf8",
  );
  await writeFile(
    join(skillsDir, "sunrise-web", "SKILL.md"),
    `---
key: sunrise-web
version: 1.0.0
name: Sunrise Web Standard
description: Build a warm, accessible static landing page and verify it.
adapterTypes: [opencode_cli]
owner: acceptance
visibility: private
createdAt: 2026-07-29T00:00:00.000Z
updatedAt: 2026-07-29T00:00:00.000Z
---

You must use a semantic main element, a keyboard-focusable CTA link, a visible \`:focus-visible\` style, responsive CSS with \`@media\`, and this exact footer signature:
${signature}
`,
    "utf8",
  );
}

async function main(): Promise<void> {
  assert(process.env.DAYTONA_API_KEY, "DAYTONA_API_KEY is required");
  await mkdir(evidenceRoot, { recursive: true });
  const gatewayUrl = await startGateway();
  await prepareFiles(gatewayUrl);
  const databasePath = join(evidenceRoot, "state.db");
  process.env.AASPAI_DB = `sqlite:${databasePath}`;
  process.env.AASPAI_AGENTS_DIR = agentsDir;
  process.env.AASPAI_SKILLS_DIR = skillsDir;
  process.env.AASPAI_KNOWLEDGE_DIR = knowledgeDir;
  process.env.AASPAI_LOOPS_DIR = loopsDir;
  process.env.AASPAI_DEFINITIONS_DIR = repositoryPath;
  process.env.AASPAI_WORKSPACE_ROOT = join(evidenceRoot, "workspaces");
  process.env.AASPAI_ARTIFACTS_ROOT = join(evidenceRoot, "artifacts");
  process.env.AASPAI_GATEWAY_CONTROL_URL = gatewayUrl;
  process.env.AASPAI_GATEWAY_CONTROL_TOKEN = controlToken;
  process.env.DAYTONA_SNAPSHOT = snapshot;
  delete process.env.AASPAI_HOST_AUTH_PATH;

  const handle = getDefaultDb();
  runMigrations(handle);
  const store = new ExecutionStore(handle.db);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  const goal = await store.createGoal({
    organizationId,
    title: "Build a real Daytona webpage",
    status: "active",
  });
  const project = await store.createProject({
    organizationId,
    goalId: goal.id,
    title: "Sunrise webpage",
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
    sourceType: "acceptance",
    idempotencyKey: `worker-daytona:${runId}`,
  });
  const branchName = `acceptance/${runId}`;
  const workItem = await store.createWorkItem({
    organizationId,
    goalId: goal.id,
    projectId: project.id,
    repositoryId: repository.id,
    workflowRunId: workflow.id,
    title: "Build an accessible sunrise landing page",
    description:
      "First load and follow the selected sunrise-web skill. Build index.html and styles.css for a responsive sunrise-themed landing page. Run `node verify.mjs`; fix every failure until it exits 0. Write its exact PASS output to verification.txt. Do not commit; the worker owns persistence.",
    status: "ready",
    definitionRevisionId: revision.id,
    sourceCommitSha: baseCommit,
    branchName,
    maxAttempts: 1,
    idempotencyKey: `work:${runId}`,
    metadata: {
      declaredArtifacts: [
        { path: "index.html", kind: "result", mediaType: "text/html" },
        { path: "styles.css", kind: "result", mediaType: "text/css" },
        { path: "verification.txt", kind: "test_result", mediaType: "text/plain" },
      ],
    },
  });

  daemon = new WorkerDaemon({
    organizationId,
    tickIntervalMs: 3_600_000,
    wakeupPollIntervalMs: 3_600_000,
  });
  await daemon.start();
  await (
    daemon as unknown as {
      executeWorkItems(workflowRunId: string, requestedAgentId: string): Promise<void>;
    }
  ).executeWorkItems(workflow.id, agentId);

  const finalWorkItem = await store.getWorkItem(workItem.id);
  const attempts = await store.listAttemptsForWorkItem(workItem.id);
  const attempt = attempts[0];
  assert(finalWorkItem?.status === "completed", `WorkItem ended as ${finalWorkItem?.status}`);
  assert(attempt?.status === "succeeded", `attempt ended as ${attempt?.status}`);
  const artifacts = await store.listArtifacts(attempt.id);
  assert(artifacts.length === 4, `expected patch + 3 declared artifacts, got ${artifacts.length}`);
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact.path);
    assert((await stat(artifact.path)).isFile(), `artifact missing: ${artifact.path}`);
    assert(
      createHash("sha256").update(bytes).digest("hex") === artifact.sha256,
      `artifact hash mismatch: ${artifact.path}`,
    );
  }
  const html = await git(["show", `${branchName}:index.html`]);
  const css = await git(["show", `${branchName}:styles.css`]);
  const verification = await git(["show", `${branchName}:verification.txt`]);
  assert(html.includes(signature), "selected skill signature missing from webpage");
  assert(/<main[\s>]/i.test(html), "semantic main element missing");
  assert(/:focus-visible/i.test(css), "keyboard focus style missing");
  assert(/pass/i.test(verification), "verification artifact does not record a pass");
  const branchFiles = await git(["ls-tree", "-r", "--name-only", branchName]);
  assert(
    !branchFiles.includes(".opencode_cli/skills/"),
    "runtime skill materialization leaked into the source branch",
  );

  const gatewayAudit = await fetch(`${gatewayUrl}/audit`, {
    headers: { authorization: `Bearer ${controlToken}` },
  }).then((response) => response.json() as Promise<Record<string, number>>);
  assert(gatewayAudit.issued === 1, "attempt credential was not issued exactly once");
  assert(gatewayAudit.revoked === 1, "attempt credential was not revoked exactly once");
  assert((gatewayAudit.proxied ?? 0) > 0, "agent did not use the credential gateway");
  const attemptToken = createHmac("sha256", controlToken)
    .update(`${organizationId}:${attempt.id}`)
    .digest("hex");
  assert(
    !(await readFile(databasePath)).includes(Buffer.from(attemptToken)),
    "attempt credential leaked into the durable database",
  );
  for (const artifact of artifacts) {
    assert(
      !(await readFile(artifact.path)).includes(Buffer.from(attemptToken)),
      `attempt credential leaked into artifact: ${artifact.path}`,
    );
  }

  const rawOutput = await store.listRawOutputs(attempt.id);
  const sessionEvents = attempt.harnessSessionId
    ? await store.listHarnessSessionEvents(attempt.harnessSessionId)
    : [];
  assert(
    sessionEvents.some(
      (event) =>
        event.payloadJson.includes('\\"tool\\":\\"skill\\"') &&
        event.payloadJson.includes("Sunrise Web Standard"),
    ),
    "persisted session evidence does not prove selected skill use",
  );
  const result = {
    status: "passed",
    runId,
    organizationId,
    workflowRunId: workflow.id,
    workItemId: workItem.id,
    attemptId: attempt.id,
    branchName,
    commit: await git(["rev-parse", branchName]),
    snapshot,
    artifacts,
    gatewayAudit,
    rawOutputCount: rawOutput.length,
    sessionEventCount: sessionEvents.length,
    evidenceRoot,
  };
  await writeFile(join(evidenceRoot, "SUMMARY.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(
    join(evidenceRoot, "RESULT.md"),
    `# Worker Daytona webpage acceptance\n\nStatus: passed\n\nAttempt: ${attempt.id}\n\nBranch: ${branchName}\n\nArtifacts: ${artifacts.length}\n`,
    "utf8",
  );
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(async (error) => {
    await writeFile(
      join(evidenceRoot, "RESULT.md"),
      `# Worker Daytona webpage acceptance\n\nStatus: failed\n\n${String(error)}\n`,
      "utf8",
    ).catch(() => undefined);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await daemon?.stop().catch(() => undefined);
    await gateway?.delete(120).catch(() => undefined);
  });
