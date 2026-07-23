import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations, sessionEvents } from "@aaspai/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessExecutionPlanRunner } from "../src/harness-runner";
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
    const fixtureCode = [
      "const emit = (value) => console.log(JSON.stringify(value));",
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
