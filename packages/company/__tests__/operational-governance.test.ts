import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  authorityEdges,
  closeDefaultDb,
  definitionRevisions,
  executionGovernanceEvents,
  getDefaultDb,
  goals,
  loopOutputs,
  repositories,
  runMigrations,
  serviceAgents,
  workflowRuns,
} from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanyOperationsError, OperationalGovernanceService } from "../src/index.js";

const root = resolve("workspace", "company-operational-governance");
const previousDb = process.env.AASPAI_DB;

describe("operational governance", () => {
  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${join(root, "state.db")}`;
    runMigrations(getDefaultDb());
  });

  afterAll(async () => {
    await closeDefaultDb();
    if (previousDb === undefined) delete process.env.AASPAI_DB;
    else process.env.AASPAI_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });

  it("validates and reconciles file agents into service agents and authority edges", async () => {
    const service = new OperationalGovernanceService(getDefaultDb().db);
    await expect(
      service.reconcileAgentDefinitions("org/relations", [
        { id: "agent/worker", reportsTo: "agent/missing" },
      ]),
    ).rejects.toBeInstanceOf(CompanyOperationsError);

    await expect(
      service.reconcileAgentDefinitions("org/relations", [
        { id: "agent/a", reportsTo: "agent/b" },
        { id: "agent/b", reportsTo: "agent/a" },
      ]),
    ).rejects.toThrow("cycle");

    expect(
      await service.reconcileAgentDefinitions("org/relations", [
        { id: "agent/lead", manages: ["agent/worker"] },
        { id: "agent/worker", reportsTo: "agent/lead" },
      ]),
    ).toEqual({ serviceAgents: 2, authorityEdges: 1 });

    expect(
      (await getDefaultDb().db.select().from(serviceAgents)).map((row) => row.agentId),
    ).toEqual(expect.arrayContaining(["agent/lead", "agent/worker"]));
    expect(await getDefaultDb().db.select().from(authorityEdges)).toHaveLength(1);

    await service.reconcileAgentDefinitions("org/relations", [{ id: "agent/lead" }]);
    const retired = (await getDefaultDb().db.select().from(serviceAgents)).find(
      (row) => row.agentId === "agent/worker",
    );
    expect(retired?.status).toBe("retired");
  });

  it("records feedback and calculates bounded readiness metrics", async () => {
    const db = getDefaultDb().db;
    const timestamp = new Date().toISOString();
    await db.insert(goals).values({
      id: "goal/metrics",
      organizationId: "org/metrics",
      title: "Metrics",
      description: "",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(repositories).values({
      id: "repo/metrics",
      organizationId: "org/metrics",
      projectId: null,
      purpose: "definitions",
      provider: "local",
      localPath: root,
      remoteUrl: null,
      defaultBranch: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(definitionRevisions).values({
      id: "revision/metrics",
      organizationId: "org/metrics",
      repositoryId: "repo/metrics",
      commitSha: "abc",
      sourcePath: ".aaspai/loops/triage/LOOP.md",
      dirty: false,
      contentHash: "hash",
      createdAt: timestamp,
    });
    await db.insert(workflowRuns).values({
      id: "run/metrics",
      organizationId: "org/metrics",
      goalId: "goal/metrics",
      definitionRevisionId: "revision/metrics",
      sourceType: "loop",
      sourceId: "loop/triage",
      status: "completed",
      idempotencyKey: "run-metrics",
      createdAt: timestamp,
    });
    await db.insert(loopOutputs).values({
      id: "output/metrics",
      organizationId: "org/metrics",
      loopId: "loop/triage",
      workflowRunId: "run/metrics",
      kind: "report",
      sourceRef: "source/1",
      title: "Finding",
      body: "Body",
      severity: "medium",
      workItemId: null,
      createdAt: timestamp,
    });

    const service = new OperationalGovernanceService(db);
    await service.recordLoopFeedback({
      organizationId: "org/metrics",
      loopId: "loop/triage",
      outputId: "output/metrics",
      verdict: "valuable",
      actorId: "user/owner",
    });
    const metrics = await service.getLoopMetrics("org/metrics", "loop/triage");
    expect(metrics).toMatchObject({
      runs: 1,
      successfulRuns: 1,
      outputs: 1,
      feedback: 1,
      falsePositives: 0,
      valueRate: 1,
    });
    const readiness = await service.assessLoop("org/metrics", "loop/triage", "L1");
    expect(readiness.score).toBeGreaterThan(0);
    expect(readiness.eligibleFor).toBeNull();
    await service.recordLoopFeedback({
      organizationId: "org/metrics",
      loopId: "loop/triage",
      outputId: "output/metrics",
      verdict: "false_positive",
      actorId: "user/owner",
    });
    expect(await db.select().from(executionGovernanceEvents)).toHaveLength(1);
    await expect(
      service.recordLoopFeedback({
        organizationId: "org/metrics",
        loopId: "loop/triage",
        outputId: "output/missing",
        verdict: "valuable",
        actorId: "user/owner",
      }),
    ).rejects.toThrow("loop output not found");
  });
});
