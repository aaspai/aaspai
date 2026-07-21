import type { AuditEvent, AuditQuery } from "@aaspai/contracts/audit";
import { AUDIT_PROTOCOL_VERSION } from "@aaspai/contracts/audit";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../src/adapters/in-memory";
import { AuditImmutabilityError } from "../src/errors";

function makeEvent(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    protocolVersion: AUDIT_PROTOCOL_VERSION,
    id,
    organizationId: overrides.organizationId ?? "org-1",
    correlationId: overrides.correlationId ?? `corr-${id}`,
    actorId: overrides.actorId ?? "actor-1",
    action: overrides.action ?? "test.action",
    targetType: overrides.targetType ?? "test",
    targetId: overrides.targetId ?? id,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    recordedAt: overrides.recordedAt ?? new Date().toISOString(),
    metadata: overrides.metadata ?? { key: "value" },
    ip: overrides.ip,
    userAgent: overrides.userAgent,
  };
}

describe("AuditStore port contract", () => {
  it("appends and retrieves a single event", async () => {
    const store = new InMemoryAuditStore();
    const event = makeEvent("evt-1");
    await store.append(event);
    const found = await store.get("evt-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("evt-1");
  });

  it("returns null for unknown ID", async () => {
    const store = new InMemoryAuditStore();
    expect(await store.get("unknown")).toBeNull();
  });

  it("appends multiple events atomically", async () => {
    const store = new InMemoryAuditStore();
    const events = [makeEvent("evt-1"), makeEvent("evt-2")];
    await store.appendMany(events);
    expect(await store.get("evt-1")).not.toBeNull();
    expect(await store.get("evt-2")).not.toBeNull();
  });

  it("rejects duplicate append (immutability)", async () => {
    const store = new InMemoryAuditStore();
    const event = makeEvent("evt-1");
    await store.append(event);
    await expect(store.append(event)).rejects.toThrow(AuditImmutabilityError);
  });

  it("queries by organizationId", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent("evt-1", { organizationId: "org-1" }),
      makeEvent("evt-2", { organizationId: "org-2" }),
    ]);
    const results = await store.query({
      organizationId: "org-1",
      limit: 100,
      offset: 0,
      order: "desc",
    } satisfies AuditQuery);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("evt-1");
  });

  it("queries by action prefix", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent("evt-1", { action: "service.create" }),
      makeEvent("evt-2", { action: "service.deploy" }),
      makeEvent("evt-3", { action: "org.action" }),
    ]);
    const results = await store.query({
      organizationId: "org-1",
      actionPrefix: "service",
      limit: 100,
      offset: 0,
      order: "desc",
    } satisfies AuditQuery);
    expect(results).toHaveLength(2);
  });

  it("counts events matching a query", async () => {
    const store = new InMemoryAuditStore();
    await store.appendMany([
      makeEvent("evt-1", { action: "service.create" }),
      makeEvent("evt-2", { action: "service.deploy" }),
    ]);
    const count = await store.count({
      organizationId: "org-1",
      actionPrefix: "service",
      limit: 100,
      offset: 0,
      order: "desc",
    } satisfies AuditQuery);
    expect(count).toBe(2);
  });

  it("supports pagination", async () => {
    const store = new InMemoryAuditStore();
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent(`evt-${i}`, { action: "test.action" }),
    );
    await store.appendMany(events);
    const page1 = await store.query({
      organizationId: "org-1",
      actionPrefix: "test",
      limit: 3,
      offset: 0,
      order: "asc",
    } satisfies AuditQuery);
    expect(page1).toHaveLength(3);
    const page2 = await store.query({
      organizationId: "org-1",
      actionPrefix: "test",
      limit: 3,
      offset: 3,
      order: "asc",
    } satisfies AuditQuery);
    expect(page2[0]!.id).toBe("evt-3");
  });

  it("prunes old events", async () => {
    const store = new InMemoryAuditStore();
    const oldRecordedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const oldEvt = makeEvent("evt-old");
    (oldEvt as Record<string, unknown>).recordedAt = oldRecordedAt;
    const recentEvt = makeEvent("evt-recent");
    await store.appendMany([oldEvt as never, recentEvt as never]);
    const deleted = await store.prune(365);
    expect(deleted).toBe(1);
  });
});
