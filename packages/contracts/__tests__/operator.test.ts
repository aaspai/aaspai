import { describe, expect, it } from "vitest";
import { controlDecisionSchema, processDefinitionSchema } from "../src/operator";

describe("operator contracts", () => {
  it("rejects unbounded or unroutable process steps", () => {
    expect(() =>
      processDefinitionSchema.parse({
        id: "process/test",
        organizationId: "org/test",
        contentHash: "hash",
        name: "test",
        steps: [
          {
            id: "step",
            timeoutMs: 1,
            maxAttempts: 1,
            acceptanceCriteria: "done",
            failureAction: "stop",
          },
        ],
        maxDurationMs: 1,
        maxAttempts: 1,
        createdAt: "2026-07-28T00:00:00.000Z",
      }),
    ).toThrow(/agent or routingRule/);
  });

  it("bounds decision payloads and keeps action values explicit", () => {
    expect(
      controlDecisionSchema.safeParse({
        id: "decision/1",
        organizationId: "org/test",
        operatorRunId: "run/1",
        sequence: 1,
        observedStateVersion: 0,
        idempotencyKey: "run/1:1",
        action: "dispatch",
        targetType: "work_item",
        targetId: "work/1",
        parameters: {},
        rationale: "ready",
        createdAt: "2026-07-28T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
