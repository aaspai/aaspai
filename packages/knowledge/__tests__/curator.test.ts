import { createDb, type DbHandle, memoryRecords, runMigrations } from "@aaspai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnowledgeCurator } from "../src/curator.js";

const organizationId = "org_knowledge_test";
const otherOrganizationId = "org_other_test";
const now = new Date().toISOString();
let handle: DbHandle;

beforeAll(async () => {
  process.env.AASPAI_DB = "sqlite::memory:";
  handle = createDb();
  runMigrations(handle);
  await handle.db
    .insert(memoryRecords)
    .values([
      memoryRow("memory_policy", organizationId, "The support window is nine months."),
      memoryRow("memory_policy_2", organizationId, "The support window is twelve months."),
      memoryRow("memory_other", otherOrganizationId, "Other company evidence."),
    ]);
});

afterAll(async () => {
  await handle.close();
  delete process.env.AASPAI_DB;
});

describe("knowledge curator", () => {
  it("creates temporal facts, atomically supersedes, and invalidates history", async () => {
    const curator = createKnowledgeCurator(handle.db);
    const original = await curator.createFact(
      factInput("fact_support_old", "9 months", "memory_policy"),
    );
    expect(original.status).toBe("proposed");

    const replacement = await curator.createFact({
      ...factInput("fact_support_new", "12 months", "memory_policy_2"),
      supersedesId: original.id,
    });
    expect(replacement.supersedesId).toBe(original.id);
    expect((await curator.getFact(organizationId, original.id))?.status).toBe("superseded");

    const invalidated = await curator.invalidateFact(
      organizationId,
      replacement.id,
      "Policy was retired",
    );
    expect(invalidated.status).toBe("invalidated");
    expect(invalidated.metadata.invalidationReason).toBe("Policy was retired");
  });

  it("detects contradictions and stale accepted facts", async () => {
    const curator = createKnowledgeCurator(handle.db);
    await curator.createFact({
      ...factInput("fact_contradiction_a", "9 months", "memory_policy"),
      status: "accepted",
      lastVerifiedAt: "2024-01-01T00:00:00Z",
    });
    await curator.createFact({
      ...factInput("fact_contradiction_b", "12 months", "memory_policy_2"),
      status: "accepted",
      lastVerifiedAt: "2024-01-01T00:00:00Z",
    });
    const signals = await curator.signals(organizationId, 30);
    expect(
      signals.some((signal) => signal.kind === "contradiction" && signal.severity === "critical"),
    ).toBe(true);
    expect(signals.some((signal) => signal.kind === "staleness")).toBe(true);
  });

  it("requires same-company evidence and turns accepted proposals into change requests", async () => {
    const curator = createKnowledgeCurator(handle.db);
    await expect(
      curator.createProposal({
        ...proposalInput("proposal_bad", ["memory_other"]),
        organizationId,
      }),
    ).rejects.toThrow(/same company/);

    const proposal = await curator.createProposal(
      proposalInput("proposal_support", ["memory_policy"]),
    );
    const review = await curator.reviewProposal({
      organizationId,
      proposalId: proposal.id,
      action: "accept",
      actorId: "agent_ceo",
      reason: "Evidence is sufficient for a reviewed runbook update.",
    });
    expect(review.proposal.status).toBe("accepted");
    expect(review.changeRequest?.status).toBe("proposed");
    expect(review.changeRequest?.targetPath).toBe("runbooks/support-window.md");

    const snapshot = await curator.snapshot(organizationId);
    expect(snapshot.proposals.some((item) => item.id === proposal.id)).toBe(true);
    expect(snapshot.changeRequests).toHaveLength(1);
  });
});

function memoryRow(id: string, organizationId: string, content: string) {
  return {
    id,
    organizationId,
    kind: "observation",
    title: id,
    content,
    contentHash: id.padEnd(64, "0"),
    scopeJson: JSON.stringify({
      organizationId,
      projectId: null,
      goalId: null,
      workItemId: null,
      agentId: null,
      topic: null,
    }),
    sensitivity: "internal",
    provenanceJson: JSON.stringify({
      sourceType: "session",
      sourceId: id,
      capturedAt: now,
      actorId: null,
      extractor: "test",
    }),
    evidenceJson: JSON.stringify([{ kind: "session", sourceId: id, label: id, uri: null }]),
    retentionJson: JSON.stringify({ policy: "standard", expiresAt: null }),
    status: "active",
    tagsJson: "[]",
    relatedIdsJson: "[]",
    supersedesId: null,
    metadataJson: "{}",
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    tokenCount: 5,
  } satisfies typeof memoryRecords.$inferInsert;
}

function factInput(id: string, value: string, sourceMemoryId: string) {
  return {
    id,
    organizationId,
    subject: "support",
    predicate: "window",
    value,
    valueType: "string" as const,
    validFrom: "2024-01-01T00:00:00Z",
    validTo: null,
    confidence: 0.9,
    status: "proposed" as const,
    sourceMemoryIds: [sourceMemoryId],
    provenance: {
      sourceType: "memory" as const,
      sourceId: sourceMemoryId,
      capturedAt: now,
      actorId: null,
      extractor: "test",
    },
    supersedesId: null,
    invalidatedAt: null,
    lastVerifiedAt: now,
    metadata: {},
  };
}

function proposalInput(id: string, sourceMemoryIds: string[]) {
  return {
    id,
    organizationId,
    title: "Support window",
    summary: "Document the current support window.",
    content: "---\ntitle: Support window\n---\nThe support window is nine months.",
    targetPath: "runbooks/support-window.md",
    knowledgeType: "runbook",
    tags: ["support"],
    sourceMemoryIds,
    factIds: [],
    provenance: {
      sourceType: "memory" as const,
      sourceId: sourceMemoryIds[0] ?? "missing",
      capturedAt: now,
      actorId: null,
      extractor: "test",
    },
    impactSummary: "Adds a reviewed support policy to the Blueprint.",
    status: "proposed" as const,
    reviewedBy: null,
    reviewReason: null,
    reviewedAt: null,
  };
}
