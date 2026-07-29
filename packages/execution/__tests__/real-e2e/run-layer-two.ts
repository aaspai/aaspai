import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
import { createDb, runMigrations } from "@aaspai/db";
import { runProcess } from "@aaspai/harness";
import { HarnessExecutionPlanRunner } from "../../src/harness-runner.js";
import { ExecutionPlanRunner } from "../../src/plan-runner.js";
import { ExecutionStore } from "../../src/store.js";

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const phase = process.argv[2] ?? "all";
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const root = join(repoRoot, "workspace", "layer-02-execution", runId);
const dbPath = join(root, "db", "execution.db");
const organizationId = "org_layer_two_real";
const now = () => new Date().toISOString();
const cases: Array<Record<string, unknown>> = [];

await mkdir(join(root, "db"), { recursive: true });
await mkdir(join(root, "evidence"), { recursive: true });
await mkdir(join(root, "raw"), { recursive: true });
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "commands.txt"), `${process.argv.join(" ")}\n`, "utf8");
await writeFile(
  join(root, "config-snapshot.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      dockerImage: process.env.AASPAI_LAYER_TWO_DOCKER_IMAGE ?? "aaspai-opencode-test:latest",
      opencodeModel: process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5",
    },
    null,
    2,
  ),
  "utf8",
);
await writeFile(
  join(root, "environment-snapshot.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      docker: await runProcess({
        command: "docker",
        args: ["version", "--format", "{{.Server.Version}}"],
      }),
      codex: await runProcess({ command: "codex", args: ["--version"] }),
      opencode: await runProcess({ command: "opencode", args: ["--version"] }),
    },
    null,
    2,
  ),
  "utf8",
);

process.env.AASPAI_DB = `sqlite:${dbPath}`;
const handle = createDb();
runMigrations(handle);
const store = new ExecutionStore(handle.db);

const nodeScript =
  "const fs=require('node:fs');fs.writeFileSync('runtime-marker.txt',process.cwd());console.log(JSON.stringify({cwd:process.cwd(),pid:process.pid}));";
const failScript = "process.stderr.write('intentional-real-failure\\n');process.exit(17);";
const sleepScript = "setTimeout(()=>console.log('finished'),30000);";

async function makePlan(
  name: string,
  target: ExecutionTarget,
  harness: string,
  prompt: string,
  timeoutMs: number | null,
  harnessConfig: Record<string, unknown> = {},
): Promise<{ plan: ExecutionPlan; workspace: ExecutionWorkspace; dir: string }> {
  const attemptId = `attempt_${name}_${randomUUID().slice(0, 8)}`;
  const workItemId = `work_${name}_${randomUUID().slice(0, 8)}`;
  const workflowRunId = `run_${name}_${randomUUID().slice(0, 8)}`;
  const dir = join(root, "workspace", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "input.txt"), `real input for ${name}\n`, "utf8");
  await store.createAttempt({
    id: attemptId,
    organizationId,
    workflowRunId,
    workItemId,
    agentId: `agent_${harness}`,
    harness,
    timeoutMs,
  });
  const workspaceRow = await store.createWorkspace({
    id: `workspace_${name}_${randomUUID().slice(0, 8)}`,
    organizationId,
    attemptId,
    repositoryId: "repo_layer_two_real",
    path: dir,
    branchName: `layer-two/${name}`,
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
  });
  await store.updateWorkspaceStatus(workspaceRow.id, "creating");
  const readyRow = await store.updateWorkspaceStatus(workspaceRow.id, "ready");
  const plan = await store.createPlan({
    id: `plan_${name}_${randomUUID().slice(0, 8)}`,
    organizationId,
    definitionRevisionId: "revision_layer_two_real",
    workItemId,
    attemptId,
    sourceSnapshot: {
      repositoryId: "repo_layer_two_real",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branchName: "main",
      capturedAt: now(),
    },
    target,
    harness,
    agentId: `agent_${harness}`,
    idempotencyKey: `idempotency_${name}`,
    prompt,
    timeoutMs,
    harnessConfig,
    workspacePolicy: { restore: "changes", cleanup: "always" },
  });
  return { plan, workspace: readyRow, dir };
}

async function record(
  name: string,
  target: ExecutionTarget,
  fn: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  let status = "passed";
  let error: string | undefined;
  let value: unknown;
  try {
    value = await fn();
  } catch (caught) {
    status = "failed";
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const result = { name, target, status, durationMs: Date.now() - started, error, value };
  cases.push(result);
  await writeFile(join(root, "evidence", `${name}.json`), JSON.stringify(result, null, 2), "utf8");
  console.log(
    `[${status}] ${name} ${(result.durationMs / 1000).toFixed(1)}s${error ? `: ${error}` : ""}`,
  );
}

async function persistCaseEvidence(
  name: string,
  attemptId: string,
): Promise<Record<string, unknown>> {
  const attempt = await store.getAttempt(attemptId);
  const events = await store.listEvents(attemptId);
  const raw = await store.listRawOutputs(attemptId);
  await writeFile(
    join(root, "raw", `${name}.jsonl`),
    raw.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "evidence", `${name}-events.jsonl`),
    events.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );
  const sessionEvents = attempt?.harnessSessionId
    ? await store.listHarnessSessionEvents(attempt.harnessSessionId)
    : [];
  await writeFile(
    join(root, "evidence", `${name}-session-events.jsonl`),
    sessionEvents.map((line) => JSON.stringify(line)).join("\n"),
    "utf8",
  );
  return {
    attempt,
    eventCount: events.length,
    rawOutputCount: raw.length,
    rawSequences: raw.map((line) => line.seq),
    sessionEventCount: sessionEvents.length,
  };
}

async function runProcessCase(
  name: string,
  target: ExecutionTarget,
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs: number | null = 10_000,
): Promise<void> {
  const { plan, workspace } = await makePlan(name, target, "process", name, timeoutMs);
  const result = await new ExecutionPlanRunner(store).run({
    plan,
    workspace,
    command,
    args,
    signal,
  });
  const evidence = await persistCaseEvidence(name, plan.attemptId);
  if (name.endsWith("-success") && result.exitCode !== 0)
    throw new Error(`expected success, got ${result.exitCode}: ${result.stderr}`);
  if (name.endsWith("-failure") && result.exitCode === 0) throw new Error("expected non-zero exit");
  if (name.endsWith("-cancel") && !result.signal && !signal?.aborted)
    throw new Error("expected cancellation signal");
  if (name.endsWith("-success") && !result.runtimeIdentity?.cwd)
    throw new Error("missing runtime identity");
  await writeFile(
    join(root, "evidence", `${name}-result.json`),
    JSON.stringify({ result, evidence }, null, 2),
    "utf8",
  );
}

if (phase === "all" || phase === "runtime") {
  await record(
    "local-success",
    { kind: "local", cwd: join(root, "workspace", "local-success"), envPassthrough: false },
    async () =>
      runProcessCase("local-success", { kind: "local", envPassthrough: false }, process.execPath, [
        "-e",
        nodeScript,
      ]),
  );
  await record("local-failure", { kind: "local", envPassthrough: false }, async () =>
    runProcessCase("local-failure", { kind: "local", envPassthrough: false }, process.execPath, [
      "-e",
      failScript,
    ]),
  );
  const localCancel = new AbortController();
  setTimeout(() => localCancel.abort(), 500).unref();
  await record("local-cancel", { kind: "local", envPassthrough: false }, async () =>
    runProcessCase(
      "local-cancel",
      { kind: "local", envPassthrough: false },
      process.execPath,
      ["-e", sleepScript],
      localCancel.signal,
      10_000,
    ),
  );

  const dockerImage = process.env.AASPAI_LAYER_TWO_DOCKER_IMAGE ?? "aaspai-opencode-test:latest";
  const dockerTargetSpec: ExecutionTarget = {
    kind: "docker",
    image: dockerImage,
    network: "bridge",
    remoteCwd: "/workspace",
  };
  await record("docker-success", dockerTargetSpec, async () =>
    runProcessCase("docker-success", dockerTargetSpec, "node", ["-e", nodeScript]),
  );
  await record("docker-failure", dockerTargetSpec, async () =>
    runProcessCase("docker-failure", dockerTargetSpec, "node", ["-e", failScript]),
  );
  const dockerCancel = new AbortController();
  setTimeout(() => dockerCancel.abort(), 6_000).unref();
  await record("docker-cancel", dockerTargetSpec, async () =>
    runProcessCase(
      "docker-cancel",
      dockerTargetSpec,
      "node",
      ["-e", sleepScript],
      dockerCancel.signal,
      10_000,
    ),
  );

  const sshHost = process.env.AASPAI_LAYER_TWO_SSH_HOST;
  const sshPort = Number(process.env.AASPAI_LAYER_TWO_SSH_PORT ?? "22222");
  const sshKey = process.env.AASPAI_LAYER_TWO_SSH_KEY;
  if (!sshHost || !sshKey) {
    throw new Error(
      "real SSH evidence requires AASPAI_LAYER_TWO_SSH_HOST and AASPAI_LAYER_TWO_SSH_KEY; provision the test sshd container first",
    );
  }
  const sshTargetSpec: ExecutionTarget = {
    kind: "ssh",
    host: sshHost,
    port: sshPort,
    username: process.env.AASPAI_LAYER_TWO_SSH_USER ?? "root",
    privateKey: sshKey,
    remoteCwd: "/tmp/aaspai-layer-two",
    strictHostKeyChecking: true,
    ...(process.env.AASPAI_LAYER_TWO_SSH_KNOWN_HOSTS
      ? { knownHosts: process.env.AASPAI_LAYER_TWO_SSH_KNOWN_HOSTS }
      : {}),
    shellCommand: "sh",
  };
  await record("ssh-success", sshTargetSpec, async () =>
    runProcessCase("ssh-success", sshTargetSpec, "node", ["-e", nodeScript]),
  );
  await record("ssh-failure", sshTargetSpec, async () =>
    runProcessCase("ssh-failure", sshTargetSpec, "node", ["-e", failScript]),
  );
}

async function runHarnessCase(
  name: string,
  harness: "codex_local" | "opencode_cli",
  target: ExecutionTarget,
  config: Record<string, unknown>,
  expectation: "success" | "failure" | "cancel" = "success",
): Promise<void> {
  const { plan, workspace } = await makePlan(
    name,
    target,
    harness,
    `Reply with exactly REAL-${name.toUpperCase()}.`,
    expectation === "cancel" ? 60_000 : 120_000,
    config,
  );
  const signal = expectation === "cancel" ? AbortSignal.timeout(1_000) : undefined;
  const result = await new HarnessExecutionPlanRunner(store).run({
    plan,
    workspace,
    agent: {
      id: `agent_${harness}`,
      name: harness,
      adapterType: harness,
      adapterConfig: config as never,
    },
    signal,
  });
  const evidence = await persistCaseEvidence(name, plan.attemptId);
  const attempt = evidence.attempt as { harnessSessionId?: string } | null;
  const session = attempt?.harnessSessionId
    ? await store.getHarnessSession(attempt.harnessSessionId)
    : null;
  await writeFile(
    join(root, "evidence", `${name}-session.json`),
    JSON.stringify({ result, session, evidence }, null, 2),
    "utf8",
  );
  if (expectation === "success" && result.exitCode !== 0)
    throw new Error(
      `${harness} failed: ${result.errorMessage ?? result.summary ?? result.exitCode}`,
    );
  if (expectation === "success" && !result.sessionId)
    throw new Error(`${harness} did not return a provider session ID`);
  const attemptResult = await store.getAttempt(plan.attemptId);
  if (
    expectation === "success" &&
    (evidence.rawOutputCount === 0 ||
      evidence.sessionEventCount === 0 ||
      attemptResult?.status !== "succeeded")
  ) {
    throw new Error(`${harness} did not persist complete successful execution evidence`);
  }
  if (expectation === "failure" && result.exitCode === 0)
    throw new Error(`${harness} invalid invocation unexpectedly succeeded`);
  if (expectation === "cancel" && attemptResult?.status !== "cancelled")
    throw new Error(`${harness} cancellation ended as ${attemptResult?.status ?? "missing"}`);
}

if (phase === "all" || phase === "providers") {
  await record("codex-local-success", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "codex-local-success",
      "codex_local",
      { kind: "local", envPassthrough: false },
      { command: "codex", sandbox: "workspace-write", approvalMode: "never" },
    ),
  );
  await record("opencode-local-success", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "opencode-local-success",
      "opencode_cli",
      { kind: "local", envPassthrough: false },
      {
        model: process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5",
        dangerouslySkipPermissions: true,
      },
    ),
  );
  await record("codex-local-failure", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "codex-local-failure",
      "codex_local",
      { kind: "local", envPassthrough: false },
      { command: "codex", extraArgs: ["--definitely-invalid-layer-two-flag"] },
      "failure",
    ),
  );
  await record("opencode-local-failure", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "opencode-local-failure",
      "opencode_cli",
      { kind: "local", envPassthrough: false },
      { commandArgs: ["--definitely-invalid-layer-two-flag"] },
      "failure",
    ),
  );
  await record("codex-local-cancel", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "codex-local-cancel",
      "codex_local",
      { kind: "local", envPassthrough: false },
      { command: "codex", sandbox: "workspace-write", approvalMode: "never" },
      "cancel",
    ),
  );
  await record("opencode-local-cancel", { kind: "local", envPassthrough: false }, () =>
    runHarnessCase(
      "opencode-local-cancel",
      "opencode_cli",
      { kind: "local", envPassthrough: false },
      { model: process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5" },
      "cancel",
    ),
  );
}

if (phase === "daytona") {
  const daytonaTarget: ExecutionTarget = {
    kind: "sandbox",
    provider: "daytona",
    remoteCwd: "/workspace",
    timeoutMs: 240_000,
  };
  await record("opencode-daytona-success", daytonaTarget, () =>
    runHarnessCase("opencode-daytona-success", "opencode_cli", daytonaTarget, {
      model: process.env.AASPAI_OPENCODE_MODEL ?? "opencode-go/mimo-v2.5",
    }),
  );
}

if (phase === "all" || phase === "runtime") {
  const stale = await makePlan(
    "restart-recovery",
    { kind: "local", envPassthrough: false },
    "process",
    "recovery",
    10_000,
  );
  await store.transitionAttempt(stale.plan.attemptId, "preparing");
  await store.transitionAttempt(stale.plan.attemptId, "running");
  const reconciled = await store.reconcileLostAttempts(new Date(Date.now() + 60_000).toISOString());
  await writeFile(
    join(root, "evidence", "restart-recovery.json"),
    JSON.stringify({ reconciled, attempt: await store.getAttempt(stale.plan.attemptId) }, null, 2),
    "utf8",
  );
  if (reconciled !== 1) throw new Error(`expected one stale attempt, got ${reconciled}`);
}

const summary = { runId, phase, root, database: dbPath, organizationId, cases, finishedAt: now() };
await writeFile(
  join(root, "RESULT.md"),
  `# Layer Two real execution evidence\n\nRun: ${runId}\n\nCases: ${cases.map((item) => `${item.name}: ${item.status}`).join(", ")}\n\nDatabase: ${dbPath}\n`,
  "utf8",
);
await writeFile(join(root, "SUMMARY.json"), JSON.stringify(summary, null, 2), "utf8");
await handle.close();
if (cases.some((item) => item.status !== "passed")) process.exitCode = 1;
console.log(JSON.stringify(summary, null, 2));
