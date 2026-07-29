import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createDb, type DbHandle, runMigrations } from "@aaspai/db";
import { compileProcessDefinition } from "@aaspai/loops";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorService } from "../src/operator";
import { ExecutionStore } from "../src/store";

describe("operator process vertical", () => {
  let handle: DbHandle;
  let store: ExecutionStore;
  let directory: string;

  beforeEach(async () => {
    directory = path.resolve("workspace", "layer-five", randomUUID());
    await mkdir(directory, { recursive: true });
    process.env.AASPAI_DB = `sqlite:${path.join(directory, "state.db")}`;
    handle = createDb();
    runMigrations(handle);
    store = new ExecutionStore(handle.db);
  });

  afterEach(async () => {
    await handle.close();
    delete process.env.AASPAI_DB;
    await rm(directory, { recursive: true, force: true });
  });

  it("pins a three-step file process and applies one start decision", async () => {
    const organizationId = "org/layer-five";
    const goal = await store.createGoal({ organizationId, title: "Proof" });
    const project = await store.createProject({
      organizationId,
      goalId: goal.id,
      title: "Proof project",
    });
    const repository = await store.createRepository({
      organizationId,
      projectId: project.id,
      purpose: "project",
      provider: "local",
      localPath: directory,
    });
    const revision = await store.createDefinitionRevision({
      organizationId,
      repositoryId: repository.id,
      commitSha: "abcdef1",
      sourcePath: "process.json",
      contentHash: "hash",
    });
    const definition = compileProcessDefinition({
      id: "process/proof",
      organizationId,
      name: "Proof",
      steps: [
        {
          id: "tester",
          agent: "agent/tester",
          dependsOn: ["developer"],
          prompt: "test",
          skills: [],
          tools: [],
          timeoutMs: 10,
          maxAttempts: 1,
          acceptanceCriteria: "pass",
          failureAction: "stop",
          approvalPolicy: {},
        },
        {
          id: "developer",
          agent: "agent/developer",
          dependsOn: ["planner"],
          prompt: "develop",
          skills: [],
          tools: [],
          timeoutMs: 10,
          maxAttempts: 1,
          acceptanceCriteria: "build",
          failureAction: "stop",
          approvalPolicy: {},
        },
        {
          id: "planner",
          agent: "agent/planner",
          dependsOn: [],
          prompt: "plan",
          skills: [],
          tools: [],
          timeoutMs: 10,
          maxAttempts: 1,
          acceptanceCriteria: "plan",
          failureAction: "stop",
          approvalPolicy: {},
        },
      ],
    });
    const service = new OperatorService(store);
    const started = await service.startProcess({
      context: { organizationId, actorId: "worker/1", correlationId: "corr/1" },
      operatorAgentId: "agent/operator",
      scopeType: "goal",
      scopeId: goal.id,
      definition,
      goalId: goal.id,
      projectId: project.id,
      repositoryId: repository.id,
      definitionRevisionId: revision.id,
      sourceCommitSha: "abcdef1",
      idempotencyKey: "proof/run",
    });
    const items = await store.listWorkItems(organizationId, goal.id);
    expect(started.workItemIds).toHaveLength(3);
    expect(items).toHaveLength(3);
    expect(
      (await store.listWorkItemDependencies(items.find((item) => item.title === "tester")!.id)).map(
        (edge) => edge.dependsOnWorkItemId,
      ),
    ).toHaveLength(1);
    expect(started.run.observedStateVersion).toBe(1);
    expect(started.run.latestDecisionId).toMatch(/^decision\//);

    const context = { organizationId, actorId: "worker/1", correlationId: "corr/1" };
    const runProvider = async ({
      attempt,
      workItem,
    }: {
      attempt: { id: string };
      workItem: { id: string };
    }) => {
      await store.recordDeliveryCommit(workItem.id, attempt.id, "1".repeat(40));
      return "succeeded" as const;
    };
    await service.tick(context, started.run.id, { runProvider });
    await service.tick(context, started.run.id, { runProvider });
    await service.tick(context, started.run.id, { runProvider });
    const completed = await service.tick(context, started.run.id);
    expect(completed.run.status).toBe("completed");
    expect(
      (await store.listWorkItems(organizationId, goal.id)).every(
        (item) => item.status === "completed",
      ),
    ).toBe(true);
  });
});
