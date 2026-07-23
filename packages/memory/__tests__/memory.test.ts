import { createDb, type DbHandle, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendDiary,
  ContextAssembler,
  captureCheckpoint,
  createLocalMemoryProvider,
} from "../src/index.js";

const organizationId = "org_memory_test";
const scope = {
  organizationId,
  projectId: "project_alpha",
  goalId: "goal_alpha",
  workItemId: "work_memory",
  agentId: "agent_engineer",
  topic: "reliability",
};
const evidence = [
  { kind: "session" as const, sourceId: "session_memory", label: "Memory test session", uri: null },
];

let handle: DbHandle;
const provider = () => createLocalMemoryProvider(handle.db);

beforeAll(() => {
  process.env.AASPAI_DB = "sqlite::memory:";
  handle = createDb();
  runMigrations(handle);
});

afterAll(async () => {
  await handle.close();
  delete process.env.AASPAI_DB;
});

describe("local operational memory", () => {
  it("stores canonical evidence and retrieves it by company and scope", async () => {
    const memory = provider();
    const record = await memory.ingest({
      organizationId,
      kind: "observation",
      title: "Retry budget protects the worker",
      content: "The worker should stop retrying after the bounded retry budget is exhausted.",
      scope,
      sensitivity: "internal",
      provenance: {
        sourceType: "session",
        sourceId: "session_memory",
        capturedAt: new Date().toISOString(),
        actorId: "agent_engineer",
        extractor: "test",
      },
      evidence,
      tags: ["retry", "worker"],
    });

    expect(record.contentHash).toHaveLength(64);
    const results = await memory.search({
      organizationId,
      query: "retry worker",
      scope: { organizationId, projectId: "project_alpha" },
      filters: {},
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.record.id).toBe(record.id);
    expect(results[0]?.record.evidence[0]?.sourceId).toBe("session_memory");

    const duplicate = await memory.ingest({
      organizationId,
      kind: "observation",
      title: "Retry budget protects the worker",
      content: "The worker should stop retrying after the bounded retry budget is exhausted.",
      scope,
      sensitivity: "internal",
      provenance: { ...record.provenance },
      evidence,
    });
    expect(duplicate.id).toBe(record.id);
  });

  it("captures checkpoints and diaries with lineage metadata", async () => {
    const memory = provider();
    const checkpoint = await captureCheckpoint(memory, {
      organizationId,
      phase: "before_compaction",
      title: "Before compaction checkpoint",
      content: "The next step is to verify the retry policy against the worker logs.",
      sourceType: "attempt",
      sourceId: "attempt_memory",
      sessionId: "session_memory",
      attemptId: "attempt_memory",
      agentId: "agent_engineer",
      scope,
      evidence,
      tags: ["compaction"],
    });
    expect(checkpoint.kind).toBe("checkpoint");
    expect(checkpoint.metadata.checkpointPhase).toBe("before_compaction");
    expect(checkpoint.relatedIds).toContain("attempt_memory");

    const diary = await appendDiary(memory, {
      organizationId,
      title: "Engineer diary",
      content: "I found the retry policy in the execution definition and linked it to the session.",
      sourceType: "session",
      sourceId: "session_memory",
      sessionId: "session_memory",
      attemptId: null,
      agentId: "agent_engineer",
      scope,
      evidence,
      tags: ["daily"],
    });
    expect(diary.kind).toBe("diary");
    expect(diary.retention.policy).toBe("long");
    expect(diary.tags).toContain("diary");
  });

  it("rebuilds the derived index and assembles bounded, untrusted context", async () => {
    const memory = provider();
    const healthBefore = await memory.health(organizationId);
    expect(healthBefore.canonicalRecords).toBeGreaterThanOrEqual(3);
    const rebuilt = await memory.rebuild(organizationId);
    expect(rebuilt.indexedRecords).toBe(healthBefore.canonicalRecords);
    const healthAfter = await memory.health(organizationId);
    expect(healthAfter.indexedRecords).toBe(healthAfter.canonicalRecords);

    const context = await new ContextAssembler(memory).assemble({
      organizationId,
      definitionContext: "Definitions are authoritative system inputs.",
      executiveContext: "The company is improving execution reliability.",
      projectId: "project_alpha",
      query: "retry",
      tokenBudget: 220,
    });
    expect(context.text).toContain("L0");
    expect(context.text).toContain("untrusted operational evidence");
    expect(context.text).toContain("<memory");
    expect(context.tokensUsed).toBeLessThanOrEqual(220);
  });
});
