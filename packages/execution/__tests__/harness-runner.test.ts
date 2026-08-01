import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations, sessionEvents } from "@aaspai/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGovernedRuntimeIsolation,
  assertRuntimeIdentity,
  HarnessExecutionPlanRunner,
} from "../src/harness-runner";
import { ExecutionStore } from "../src/store";

describe("HarnessExecutionPlanRunner", () => {
  let handle: DbHandle;
  let store: ExecutionStore;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `harness-runner-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.AASPAI_DB;
    delete process.env.OPENCODE_CLI;
    delete process.env.AASPAI_TEST_WORKER_SECRET;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("runs codex_local in the assigned workspace and links the HarnessSession", async () => {
    const attemptId = "attempt_codex_fixture";
    const workspace = await makeAttemptAndWorkspace(attemptId, "codex_local");
    const fixture = path.join(workspace.path, "exec");
    await writeFile(
      fixture,
      [
        "const emit = (value) => console.log(JSON.stringify(value));",
        'emit({ type: "thread.started", thread_id: "thread_fixture" });',
        'emit({ type: "item.completed", item: { type: "agent_message", text: `cwd=${process.cwd()}` } });',
        'emit({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 7 } });',
      ].join("\n"),
      "utf8",
    );

    const result = await new HarnessExecutionPlanRunner(store).run({
      plan: planFor(attemptId, "codex_local"),
      workspace,
      agent: {
        id: "agent_codex",
        name: "Codex fixture",
        adapterType: "codex_local",
        adapterConfig: { command: process.execPath },
      },
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.sessionId).toBe("thread_fixture");
    const attempt = await store.getAttempt(attemptId);
    expect(attempt).toMatchObject({ status: "succeeded" });
    expect(attempt?.harnessSessionId).toBeTruthy();
    const session = await store.getHarnessSession(attempt?.harnessSessionId ?? "missing");
    expect(session).toMatchObject({ adapter: "codex_local", sessionId: "thread_fixture" });
    const events = await handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, attempt?.harnessSessionId ?? "missing"))
      .orderBy(asc(sessionEvents.seq));
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.payloadJson.includes("assigned-workspace"))).toBe(true);
    await expect(store.listEvents(attemptId)).resolves.toMatchObject([
      { type: "harness.session.started" },
      { type: "harness.session.completed" },
    ]);
  });

  it("runs opencode_cli in the assigned workspace and preserves its provider session ID", async () => {
    const attemptId = "attempt_opencode_fixture";
    const workspace = await makeAttemptAndWorkspace(attemptId, "opencode_cli");
    process.env.AASPAI_TEST_WORKER_SECRET = "worker-only";
    const fixtureCode = [
      "const emit = (value) => console.log(JSON.stringify(value));",
      "require('node:fs').writeFileSync('environment-seen.json', JSON.stringify({token:process.env.AASPAI_ATTEMPT_TOKEN,secret:process.env.AASPAI_TEST_WORKER_SECRET,path:Boolean(process.env.PATH ?? process.env.Path)}));",
      'emit({ type: "session.created", sessionID: "oc_fixture" });',
      'emit({ type: "text", sessionID: "oc_fixture", part: { type: "text", text: `cwd=${process.cwd()}` } });',
      'emit({ type: "step_finish", sessionID: "oc_fixture", part: { tokens: { input: 3, output: 4 }, cost: 0 } });',
    ].join("\n");
    const result = await new HarnessExecutionPlanRunner(store).run({
      plan: planFor(attemptId, "opencode_cli"),
      workspace,
      agent: {
        id: "agent_opencode",
        name: "OpenCode fixture",
        adapterType: "opencode_cli",
        adapterConfig: {
          model: "fixture/model",
          title: "Fixture",
          command: process.execPath,
          commandArgs: ["-e", fixtureCode],
        },
      },
      ephemeralEnv: { AASPAI_ATTEMPT_TOKEN: "short-lived-test-token" },
      onExecuted: async () => {
        const seen = await import("node:fs/promises").then((fs) =>
          fs.readFile(path.join(workspace.path, "environment-seen.json"), "utf8"),
        );
        expect(JSON.parse(seen)).toEqual({
          token: "short-lived-test-token",
          path: true,
        });
      },
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.sessionId).toBe("oc_fixture");
    const attempt = await store.getAttempt(attemptId);
    const session = await store.getHarnessSession(attempt?.harnessSessionId ?? "missing");
    expect(session).toMatchObject({ adapter: "opencode_cli", sessionId: "oc_fixture" });
    const events = await handle.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, attempt?.harnessSessionId ?? "missing"));
    expect(events.some((event) => event.payloadJson.includes("assigned-workspace"))).toBe(true);
  });

  it("fails the attempt when restored output cannot be persisted", async () => {
    const attemptId = "attempt_evidence_failure";
    const workspace = await makeAttemptAndWorkspace(attemptId, "opencode_cli");
    const result = await new HarnessExecutionPlanRunner(store).run({
      plan: planFor(attemptId, "opencode_cli"),
      workspace,
      agent: {
        id: "agent_opencode",
        name: "OpenCode fixture",
        adapterType: "opencode_cli",
        adapterConfig: {
          model: "fixture/model",
          command: process.execPath,
          commandArgs: [
            "-e",
            "console.log(JSON.stringify({type:'session.created',sessionID:'oc_fixture'}))",
          ],
        },
      },
      onExecuted: async () => {
        throw new Error("artifact store unavailable");
      },
    });

    expect(result.errorCode).toBe("evidence_persistence_failed");
    await expect(store.getAttempt(attemptId)).resolves.toMatchObject({ status: "failed" });
  });

  it("interrupts a silent CLI session for a resumable retry", async () => {
    const attemptId = "attempt_stalled_opencode";
    const workspace = await makeAttemptAndWorkspace(attemptId, "opencode_cli");
    const result = await new HarnessExecutionPlanRunner(store).run({
      plan: planFor(attemptId, "opencode_cli"),
      workspace,
      agent: {
        id: "agent_opencode",
        name: "OpenCode fixture",
        adapterType: "opencode_cli",
        adapterConfig: {
          model: "fixture/model",
          command: process.execPath,
          commandArgs: [
            "-e",
            "console.log(JSON.stringify({type:'session.created',sessionID:'oc_stalled'}));setInterval(()=>{},1000)",
          ],
          stuckAfterMs: 1_000,
        },
      },
    });

    expect(result).toMatchObject({ timedOut: true, errorCode: "session_stalled" });
    await expect(store.getAttempt(attemptId)).resolves.toMatchObject({ status: "timed_out" });
    const attempt = await store.getAttempt(attemptId);
    await expect(
      store.getHarnessSession(attempt?.harnessSessionId ?? "missing"),
    ).resolves.toMatchObject({
      sessionId: "oc_stalled",
    });
  });

  async function makeAttemptAndWorkspace(
    attemptId: string,
    harness: string,
  ): Promise<ExecutionWorkspace> {
    await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: `run_${attemptId}`,
      workItemId: `work_${attemptId}`,
      agentId: `agent_${harness}`,
      harness,
      id: attemptId,
    });
    const workspacePath = path.join(testDirectory, "assigned-workspace");
    await mkdir(workspacePath, { recursive: true });
    return {
      id: `workspace_${attemptId}`,
      organizationId: "org_test",
      attemptId,
      repositoryId: "repo_project",
      path: workspacePath,
      branchName: `work/${attemptId}`,
      baseCommitSha: "abcdef1",
      status: "ready",
      createdAt: new Date().toISOString(),
      releasedAt: null,
    };
  }
});

describe("assertRuntimeIdentity", () => {
  it("allows governed local CLI sessions only with a managed environment", () => {
    expect(() =>
      assertGovernedRuntimeIsolation(
        "opencode_cli",
        { kind: "local", envPassthrough: false },
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertGovernedRuntimeIsolation("codex_local", { kind: "local", envPassthrough: true }, true),
    ).toThrow(/managed environment/);
  });

  it("accepts the selected local workspace", () => {
    expect(() =>
      assertRuntimeIdentity({ kind: "local", envPassthrough: false }, "F:/workspace", {
        kind: "local",
        cwd: "F:/workspace",
      }),
    ).not.toThrow();
  });

  it("rejects a different runtime kind", () => {
    expect(() =>
      assertRuntimeIdentity({ kind: "local", envPassthrough: false }, "F:/workspace", {
        kind: "docker",
        cwd: "/workspace",
        containerId: "container-1",
      }),
    ).toThrow(/requested local, got docker/);
  });

  it("rejects a sandbox from a different provider", () => {
    expect(() =>
      assertRuntimeIdentity(
        { kind: "sandbox", provider: "daytona", remoteCwd: "/workspace" },
        "F:/workspace",
        {
          kind: "sandbox",
          cwd: "/workspace",
          remoteCwd: "/workspace",
          connectionIdentity: "e2b:lease-1",
        },
      ),
    ).toThrow(/sandbox target/);
  });

  it("accepts an isolated SSH workspace under the requested remote root", () => {
    expect(() =>
      assertRuntimeIdentity(
        {
          kind: "ssh",
          host: "worker.example.test",
          port: 22,
          username: "runner",
          remoteCwd: "/tmp/aaspai",
          strictHostKeyChecking: true,
          shellCommand: "bash",
        },
        "F:/workspace",
        {
          kind: "ssh",
          cwd: "/tmp/aaspai/aaspai-ssh-123",
          host: "worker.example.test",
          remoteCwd: "/tmp/aaspai/aaspai-ssh-123",
          connectionIdentity: "runner@worker.example.test:22",
        },
      ),
    ).not.toThrow();
  });
});

function planFor(attemptId: string, harness: string): ExecutionPlan {
  return {
    id: `plan_${attemptId}`,
    organizationId: "org_test",
    definitionRevisionId: "revision_test",
    workItemId: `work_${attemptId}`,
    attemptId,
    sourceSnapshot: {
      repositoryId: "repo_project",
      commitSha: "abcdef1",
      branchName: "main",
      capturedAt: new Date().toISOString(),
    },
    target: { kind: "local", envPassthrough: false },
    harness,
    prompt: "Run the fixture",
    timeoutMs: null,
    runtimeConfig: {},
    createdAt: new Date().toISOString(),
  };
}
