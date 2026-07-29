import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, runMigrations } from "@aaspai/db";
import { ExecutionStore } from "@aaspai/execution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch, LoopRunner, type ResolvedLoopPattern, type WorkItem } from "../src/index";

describe("durable LoopRunner", () => {
  let store: ExecutionStore;
  let close: () => Promise<void>;
  let testDirectory: string;
  let lineage: {
    goalId: string;
    projectId: string;
    repositoryId: string;
    definitionRevisionId: string;
  };

  beforeEach(async () => {
    testDirectory = path.resolve("workspace", "m4", `loop-runner-${randomUUID()}`);
    await mkdir(testDirectory, { recursive: true });
    const handle = createDbForTest(path.join(testDirectory, "state.db"));
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
    close = handle.close;
    const organizationId = "org_loop_runner";
    const goal = await store.createGoal({ organizationId, title: "Loop goal" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Loop project",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: path.join(testDirectory, "project"),
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: ".",
      contentHash: "loop-fixture",
    });
    lineage = {
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      definitionRevisionId: revision.id,
    };
  });

  afterEach(async () => {
    await close();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("coalesces a trigger and turns L2 actions into governed work", async () => {
    const loop = pattern("L2", [
      {
        ref: { kind: "session", id: "sess_failed", title: "Failed session" },
        title: "Repair failed session",
        description: "Investigate and fix the failure",
        data: { branchName: "loop/repair", priority: 7, maxAttempts: 2 },
        discoveredAt: new Date().toISOString(),
      },
    ]);
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
    });

    const first = await runner.run(loop, { triggerKey: "tick-1" });
    const second = await runner.run(loop, { triggerKey: "tick-1" });

    expect(first.runId).toBe(second.runId);
    expect(first.workItems).toHaveLength(1);
    expect(second.workItems).toHaveLength(1);
    expect(first.workItems[0]).toMatchObject({
      branchName: "loop/repair",
      maxAttempts: 2,
      status: "proposed",
    });
    expect(first.workItems[0]).toMatchObject({
      governance: {
        approval: { required: true },
        verification: { required: true },
      },
    });
    await expect(store.getWorkflowRun(first.runId)).resolves.toMatchObject({
      sourceType: "loop",
      sourceId: loop.pattern.id,
    });
  });

  it("persists reports and escalations and enforces report-only autonomy", async () => {
    const loop = pattern("L1", [
      {
        ref: { kind: "session", id: "sess_report" },
        title: "Report item",
        discoveredAt: new Date().toISOString(),
      },
    ]);
    loop.decide = async () => ({ kind: "report", payload: { title: "Report", body: "Details" } });
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
    });
    const report = await runner.run(loop, { triggerKey: "report-1" });
    expect(report.outputs).toHaveLength(1);
    expect(report.outputs[0]).toMatchObject({ kind: "report", title: "Report" });

    const escalationLoop = pattern("L1", [
      {
        ref: { kind: "wakeup", id: "wake_critical" },
        title: "Critical wakeup",
        discoveredAt: new Date().toISOString(),
      },
    ]);
    escalationLoop.decide = async () => ({
      kind: "escalate",
      reason: "Needs operator",
      severity: "critical",
    });
    const escalation = await runner.run(escalationLoop, { triggerKey: "escalation-1" });
    expect(escalation.outputs[0]).toMatchObject({ kind: "escalation", severity: "critical" });
    await expect(store.listLoopOutputs("org_loop_runner")).resolves.toHaveLength(2);
  });

  it("creates a cancelled run without discovering when the kill switch is active", async () => {
    const killSwitch = new KillSwitch();
    const loop = pattern("L2", []);
    killSwitch.pauseLoop(loop.pattern.id, "operator stop");
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
      killSwitch,
    });
    const result = await runner.run(loop, { triggerKey: "paused-1" });
    expect(result.stopped).toBe(true);
    await expect(store.getWorkflowRun(result.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("passes durable state through discovery and decision", async () => {
    const loop = pattern("L1", [
      {
        ref: { kind: "wakeup", id: "wake_state" },
        title: "State item",
        discoveredAt: new Date().toISOString(),
      },
    ]);
    const seen: unknown[] = [];
    loop.discover = async (state) => {
      seen.push(state);
      return [
        {
          ref: { kind: "wakeup", id: "wake_state" },
          title: "State item",
          discoveredAt: new Date().toISOString(),
        },
      ];
    };
    loop.decide = async (_item, state) => {
      seen.push(state);
      return { kind: "noop", reason: "State observed" };
    };
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
      stateStore: {
        view: async () => ({
          loopId: loop.pattern.id,
          highPriority: [],
          watch: [],
          noise: [],
          workItems: [{ id: "work_prior", status: "failed", title: "Prior", updatedAt: "now" }],
          attempts: [],
          humanOverrides: [],
          recentRuns: [],
          paused: false,
        }),
      },
    });

    await runner.run(loop, { triggerKey: "state-1" });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      workflowRunId: expect.any(String),
      workItems: [{ id: "work_prior", status: "failed" }],
    });
    expect(seen[1]).toEqual(seen[0]);
  });

  it("marks the durable run failed when discovery throws", async () => {
    const loop = pattern("L1", []);
    loop.discover = async () => {
      throw new Error("discovery unavailable");
    };
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
    });

    await expect(runner.run(loop, { triggerKey: "failure-1" })).rejects.toThrow(
      "discovery unavailable",
    );
    await expect(
      store.getWorkflowRunByIdempotency("org_loop_runner", `loop:${loop.pattern.id}:failure-1`),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("switches L2 actions to report-only at the daily soft budget", async () => {
    const loop = pattern("L2", [
      {
        ref: { kind: "session", id: "budgeted" },
        title: "Budgeted action",
        discoveredAt: new Date().toISOString(),
      },
    ]);
    loop.pattern.budgetJson = JSON.stringify({
      perRun: { tokens: 10 },
      perDay: { tokens: 100 },
      soft: 0.8,
      hard: 1,
    });
    const runner = new LoopRunner({
      organizationId: "org_loop_runner",
      execution: { store, lineage },
      stateStore: {
        view: async () => ({
          loopId: loop.pattern.id,
          highPriority: [],
          watch: [],
          noise: [],
          workItems: [],
          attempts: [],
          humanOverrides: [],
          recentRuns: [],
          paused: false,
          budgetToday: { tokens: 80, costUsd: 0, runs: 1 },
        }),
      },
    });

    const result = await runner.run(loop, { triggerKey: "soft-budget" });
    expect(result.workItems).toHaveLength(0);
    expect(result.outputs[0]).toMatchObject({ kind: "report" });
  });
});

function pattern(autonomyLevel: "L1" | "L2", items: WorkItem[]): ResolvedLoopPattern {
  const resolved: ResolvedLoopPattern = {
    pattern: {
      id: `loop/test-${randomUUID()}`,
      type: "LoopPattern",
      title: "Test loop",
      description: "Loop test",
      timestamp: new Date().toISOString(),
      schedule: { kind: "manual" },
      agent: "agent/test",
      autonomyLevel,
      status: "enabled",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      configJson: "{}",
      gateJson: "{}",
      budgetJson: "{}",
    },
    discover: async () => items,
    decide: async () => ({ kind: "act", reason: "Act on item" }),
  };
  return resolved;
}

function createDbForTest(filePath: string) {
  process.env.AASPAI_DB = `sqlite:${filePath}`;
  return createDb();
}
