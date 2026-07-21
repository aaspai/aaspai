import type { JsonObject } from "@aaspai/contracts";
import { AUDIT_PROTOCOL_VERSION } from "@aaspai/contracts/audit";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../src/adapters/in-memory";
import { AuditImmutabilityError } from "../src/errors";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: AUDIT_PROTOCOL_VERSION,
    id: (overrides.id as string) ?? `evt-${Math.random().toString(36).slice(2)}`,
    organizationId: (overrides.organizationId as string) ?? "org-1",
    correlationId: (overrides.correlationId as string) ?? "corr-1",
    actorId: (overrides.actorId as string) ?? "actor-1",
    action: (overrides.action as string) ?? "service.create",
    targetType: (overrides.targetType as string) ?? "service",
    targetId: (overrides.targetId as string) ?? "svc-1",
    occurredAt: (overrides.occurredAt as string) ?? new Date().toISOString(),
    recordedAt: (overrides.recordedAt as string) ?? new Date().toISOString(),
    metadata: (overrides.metadata as JsonObject) ?? ({ key: "value" } as JsonObject),
  };
}

describe("InMemoryAuditStore", () => {
  it("appends a single event", async () => {
    const store = new InMemoryAuditStore();
    const event = makeEvent({ id: "evt-1" });
    await store.append(event);
    expect(store.all()).toHaveLength(1);
  });

  it("enforces immutability on duplicate append", async () => {
    const store = new InMemoryAuditStore();
    const event = makeEvent({ id: "evt-1" });
    await store.append(event);
    await expect(store.append(event)).rejects.toThrow(AuditImmutabilityError);
  });

  it("appends multiple events atomically", async () => {
    const store = new InMemoryAuditStore();
    const events = [
      makeEvent({ id: "evt-1", action: "service.create" }),
      makeEvent({ id: "evt-2", action: "service.deploy" }),
    ];
    await store.appendMany(events);
    expect(store.all()).toHaveLength(2);
  });

  it("queries by organizationId", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent({ id: "evt-1", organizationId: "org-1" }),
      makeEvent({ id: "evt-2", organizationId: "org-2" }),
    ]);
    const results = await store.query({
      organizationId: "org-1",
      limit: 100,
      offset: 0,
      order: "desc",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("evt-1");
  });

  it("queries by action prefix", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent({ id: "evt-1", action: "service.create" }),
      makeEvent({ id: "evt-2", action: "service.deploy" }),
      makeEvent({ id: "evt-3", action: "org.createProject" }),
    ]);
    const results = await store.query({
      organizationId: "org-1",
      actionPrefix: "service.",
      limit: 100,
      offset: 0,
      order: "desc",
    });
    expect(results).toHaveLength(2);
  });

  it("supports pagination", async () => {
    const store = new InMemoryAuditStore();
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, action: "test.action" }),
    );
    await store.appendMany(events);
    const page1 = await store.query({
      organizationId: "org-1",
      actionPrefix: "test",
      limit: 3,
      offset: 0,
      order: "asc",
    });
    expect(page1).toHaveLength(3);
    const page2 = await store.query({
      organizationId: "org-1",
      actionPrefix: "test",
      limit: 3,
      offset: 3,
      order: "asc",
    });
    expect(page2).toHaveLength(3);
    expect(page2[0]!.id).toBe("evt-3");
  });

  it("counts events matching a query", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent({ id: "evt-1", action: "service.create" }),
      makeEvent({ id: "evt-2", action: "service.deploy" }),
    ]);
    const count = await store.count({
      organizationId: "org-1",
      actionPrefix: "service",
      limit: 100,
      offset: 0,
      order: "desc",
    });
    expect(count).toBe(2);
  });

  it("gets a single event by ID", async () => {
    const store = new InMemoryAuditStore();
    const event = makeEvent({ id: "evt-1" });
    await store.append(event);
    const found = await store.get("evt-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("evt-1");
  });

  it("returns null for unknown event ID", async () => {
    const store = new InMemoryAuditStore();
    const found = await store.get("unknown-id");
    expect(found).toBeNull();
  });

  it("prunes old events", async () => {
    const store = new InMemoryAuditStore();
    const oldRecordedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const oldEvt = makeEvent({ id: "evt-old" });
    (oldEvt as Record<string, unknown>).recordedAt = oldRecordedAt;
    const recentEvt = makeEvent({ id: "evt-recent" });
    await store.appendMany([oldEvt as never, recentEvt as never]);
    const deleted = await store.prune(365);
    expect(deleted).toBe(1);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.id).toBe("evt-recent");
  });
});
