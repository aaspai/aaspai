import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ExecutionPlan, ExecutionWorkspace } from "@aaspai/contracts/execution";
import type { RunProcessResult } from "@aaspai/contracts/runtime";
import type { DbHandle } from "@aaspai/db";
import { createDb, runMigrations } from "@aaspai/db";
import type { RuntimeTarget } from "@aaspai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionPlanRunner } from "../src/plan-runner";
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
    await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: "run_test",
      workItemId: "work_test",
      agentId: "agent_test",
      harness: "dry_run",
      id: attemptId,
    });
    const workspace = readyWorkspace(attemptId, testDirectory);
    const result: RunProcessResult = {
      exitCode: 0,
      timedOut: false,
      stdout: "done",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 4,
    };
    const run = vi.fn(async (target, options) => {
      expect(target.cwd).toBe(workspace.path);
      expect(options.cwd).toBe(workspace.path);
      return result;
    });
    const targetPicker = vi.fn((): RuntimeTarget => ({ run }) as unknown as RuntimeTarget);
    const runner = new ExecutionPlanRunner(store, targetPicker);

    await expect(
      runner.run({
        plan: planFor(attemptId),
        workspace,
        command: "node",
        args: ["-e", "console.log('done')"],
      }),
    ).resolves.toEqual(result);

    expect(run).toHaveBeenCalledTimes(1);
    const stored = await store.transitionAttempt(attemptId, "failed").catch(() => null);
    expect(stored).toBeNull();
  });

  it("rejects a plan assigned to a different workspace", async () => {
    const attemptId = "attempt_runner";
    await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: "run_test",
      workItemId: "work_test",
      agentId: "agent_test",
      harness: "dry_run",
      id: attemptId,
    });
    await expect(
      new ExecutionPlanRunner(store, () => ({ run: vi.fn() }) as unknown as RuntimeTarget).run({
        plan: planFor(attemptId),
        workspace: readyWorkspace("attempt_other", testDirectory),
        command: "node",
      }),
    ).rejects.toThrow("attempt IDs must match");
  });

  it("persists cancellation when the runtime signal is aborted", async () => {
    const attemptId = "attempt_cancelled";
    await store.createAttempt({
      organizationId: "org_test",
      workflowRunId: "run_test",
      workItemId: "work_test",
      agentId: "agent_test",
      harness: "dry_run",
      id: attemptId,
    });
    const controller = new AbortController();
    const result: RunProcessResult = {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 10,
    };
    const run = vi.fn(async (_target, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return result;
    });
    const runner = new ExecutionPlanRunner(store, () => ({ run }) as unknown as RuntimeTarget);

    await runner.run({
      plan: planFor(attemptId),
      workspace: readyWorkspace(attemptId, testDirectory),
      command: "node",
      signal: controller.signal,
    });

    await expect(store.getAttempt(attemptId)).resolves.toMatchObject({ status: "cancelled" });
  });
});

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
    harness: "dry_run",
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
