import type { AuditStore } from "@aaspai/audit/port";
import { AUDIT_PROTOCOL_VERSION } from "@aaspai/contracts/audit";
import { describe, expect, it } from "vitest";

function makeTestEvent(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: AUDIT_PROTOCOL_VERSION,
    id: (overrides.id as string) ?? `test-evt-${Math.random().toString(36).slice(2)}`,
    organizationId: (overrides.organizationId as string) ?? "test-org",
    correlationId: (overrides.correlationId as string) ?? "test-corr",
    actorId: (overrides.actorId as string) ?? "test-actor",
    action: (overrides.action as string) ?? "test.action",
    targetType: (overrides.targetType as string) ?? "test",
    targetId: (overrides.targetId as string) ?? "target-1",
    occurredAt: (overrides.occurredAt as string) ?? new Date().toISOString(),
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Shared contract test suite for AuditStore implementations.
 *
 * Usage:
 * ```ts
 * import { describeAuditStoreContract } from "@aaspai/testing/contracts";
 *
 * describeAuditStoreContract("InMemory", () => new InMemoryAuditStore());
 * ```
 */
export function describeAuditStoreContract(label: string, factory: () => AuditStore): void {
  describe(`AuditStore contract: ${label}`, () => {
    it("appends and retrieves events", async () => {
      const store = factory();
      const event = makeTestEvent();
      await store.append(event);
      const found = await store.get(event.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(event.id);
    });

    it("queries by organization", async () => {
      const store = factory();
      await store.appendMany([
        makeTestEvent({ id: "evt-1", organizationId: "org-1" }),
        makeTestEvent({ id: "evt-2", organizationId: "org-2" }),
      ]);
      const results = await store.query({
        organizationId: "org-1",
        limit: 100,
        offset: 0,
        order: "desc",
      });
      expect(results).toHaveLength(1);
    });

    it("counts events", async () => {
      const store = factory();
      await store.appendMany([makeTestEvent({ id: "evt-a" }), makeTestEvent({ id: "evt-b" })]);
      const count = await store.count({
        organizationId: "test-org",
        limit: 100,
        offset: 0,
        order: "desc",
      });
      expect(count).toBe(2);
    });

    it("returns null for unknown id", async () => {
      const store = factory();
      const found = await store.get("non-existent");
      expect(found).toBeNull();
    });
  });
}
