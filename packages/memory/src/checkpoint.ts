import type { MemoryCheckpointInput, MemoryRecord } from "@aaspai/contracts/memory";
import { memoryCheckpointInputSchema } from "@aaspai/contracts/memory";
import type { MemoryProvider } from "./provider.js";

export async function captureCheckpoint(
  provider: MemoryProvider,
  input: MemoryCheckpointInput,
): Promise<MemoryRecord> {
  const checkpoint = memoryCheckpointInputSchema.parse(input);
  return provider.checkpoint({
    organizationId: checkpoint.organizationId,
    kind: "checkpoint",
    title: checkpoint.title,
    content: checkpoint.content,
    phase: checkpoint.phase,
    sourceType: checkpoint.sourceType,
    sourceId: checkpoint.sourceId,
    scope: checkpoint.scope,
    sensitivity: "internal",
    provenance: {
      sourceType: checkpoint.sourceType,
      sourceId: checkpoint.sourceId,
      capturedAt: new Date().toISOString(),
      actorId: checkpoint.agentId,
      extractor: "checkpoint",
    },
    evidence: checkpoint.evidence,
    retention: { policy: "standard", expiresAt: null },
    status: "active",
    tags: ["checkpoint", checkpoint.phase, ...checkpoint.tags],
    relatedIds: [checkpoint.sessionId, checkpoint.attemptId].filter(
      (id): id is string => id !== null,
    ),
    supersedesId: null,
    metadata: {
      ...checkpoint.metadata,
      sessionId: checkpoint.sessionId,
      attemptId: checkpoint.attemptId,
    },
  });
}

export async function appendDiary(
  provider: MemoryProvider,
  input: Omit<MemoryCheckpointInput, "phase" | "title"> & { title?: string },
): Promise<MemoryRecord> {
  return provider.ingest({
    organizationId: input.organizationId,
    kind: "diary",
    title: input.title ?? "Agent diary entry",
    content: input.content,
    scope: input.scope,
    sensitivity: "internal",
    provenance: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      capturedAt: new Date().toISOString(),
      actorId: input.agentId ?? null,
      extractor: "agent-diary",
    },
    evidence: input.evidence,
    retention: { policy: "long", expiresAt: null },
    status: "active",
    tags: ["diary", ...(input.tags ?? [])],
    relatedIds: [input.sessionId, input.attemptId].filter((id): id is string => id !== null),
    supersedesId: null,
    metadata: input.metadata ?? {},
  });
}
