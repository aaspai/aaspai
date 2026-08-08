import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPlanRunner } from "../src/plan-runner";
import type { ManagedRuntimeBoundary } from "../src/runtime-boundary";
import { ExecutionStore } from "../src/store";

describe("ExecutionPlanRunner", () => {
  let handle: DbHandle;
  let store: ExecutionStore;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m1", `plan-runner-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(testDirectory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.AASPAI_DB;
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("forces the assigned worktree as cwd and completes the attempt", async () => {
    const attemptId = "attempt_runner";
    await createAttempt(store, attemptId);
    const workspace = readyWorkspace(attemptId, testDirectory);
    const result = successfulResult();
    const run = vi.fn(async (options: RunProcessOptions) => {
      expect(options.cwd).toBe(workspace.path);
      return result;
    });
    const close = vi.fn(async () => undefined);
    const runner = new ExecutionPlanRunner(store, async (_target, cwd) =>
      boundary(run, close, cwd),
    );

    await expect(
      runner.run({
        plan: planFor(attemptId),
        workspace,
        command: "node",
        args: ["-e", "console.log('done')"],
      }),
    ).resolves.toEqual(result);

    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(store.listEvents(attemptId)).resolves.toMatchObject([
      { seq: 1, type: "attempt.started" },
      { seq: 2, type: "process.completed" },
    ]);
  });

  it("rejects a plan assigned to a different workspace", async () => {
    const attemptId = "attempt_runner";
    await createAttempt(store, attemptId);
    await expect(
      new ExecutionPlanRunner(store, async () =>
        boundary(
          vi.fn(async () => successfulResult()),
          vi.fn(async () => undefined),
          testDirectory,
        ),
      ).run({
        plan: planFor(attemptId),
        workspace: readyWorkspace("attempt_other", testDirectory),
        command: "node",
      }),
    ).rejects.toThrow("attempt IDs must match");
  });

  it("persists cancellation when the runtime signal is aborted", async () => {
    const attemptId = "attempt_cancelled";
    await createAttempt(store, attemptId);
    const controller = new AbortController();
    const result = successfulResult({ exitCode: null, signal: "SIGTERM" });
    const run = vi.fn(async (options: RunProcessOptions) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return result;
    });
    const runner = new ExecutionPlanRunner(store, async (_target, cwd) =>
      boundary(
        run,
        vi.fn(async () => undefined),
        cwd,
      ),
    );

    await runner.run({
      plan: planFor(attemptId),
      workspace: readyWorkspace(attemptId, testDirectory),
      command: "node",
      signal: controller.signal,
    });

    await expect(store.getAttempt(attemptId)).resolves.toMatchObject({ status: "cancelled" });
  });
});

async function createAttempt(store: ExecutionStore, id: string): Promise<void> {
  await store.createAttempt({
    organizationId: "org_test",
    workflowRunId: "run_test",
    workItemId: "work_test",
    agentId: "agent_test",
    harness: "opencode_local",
    id,
  });
}

function boundary(
  run: (options: RunProcessOptions) => Promise<RunProcessResult>,
  close: () => Promise<void>,
  cwd: string,
): ManagedRuntimeBoundary {
  return {
    execution: { identity: { kind: "local", cwd }, run },
    close,
  };
}

function successfulResult(overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  const now = new Date().toISOString();
  return {
    exitCode: 0,
    timedOut: false,
    stdout: "done",
    stderr: "",
    startedAt: now,
    finishedAt: now,
    durationMs: 4,
    ...overrides,
  };
}

function planFor(attemptId: string): ExecutionPlan {
  return {
    id: "plan_test",
    organizationId: "org_test",
    definitionRevisionId: "revision_test",
    workItemId: "work_test",
    attemptId,
    sourceSnapshot: {
      repositoryId: "repo_company",
      commitSha: "abcdef1",
      branchName: "main",
      capturedAt: new Date().toISOString(),
    },
    target: { kind: "local", envPassthrough: false },
    harness: "opencode_local",
    prompt: "Run the task",
    timeoutMs: null,
    runtimeConfig: {},
    createdAt: new Date().toISOString(),
  };
}

function readyWorkspace(attemptId: string, root: string): ExecutionWorkspace {
  return {
    id: "workspace_test",
    organizationId: "org_test",
    attemptId,
    repositoryId: "repo_project",
    path: path.join(root, "execution", attemptId),
    branchName: `work/${attemptId}`,
    baseCommitSha: "abcdef1",
    status: "ready",
    createdAt: new Date().toISOString(),
    releasedAt: null,
  };
}
