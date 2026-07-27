import { describe, expect, it } from "vitest";
import { compileProcess } from "../src/process";

const base = {
  id: "loop/process",
  type: "LoopPattern" as const,
  title: "Process",
  description: "A bounded process",
  timestamp: "2026-07-27T00:00:00.000Z",
  schedule: { kind: "manual" as const },
  agent: "agent/a",
  autonomyLevel: "L2" as const,
  status: "enabled" as const,
  concurrencyPolicy: "coalesce_if_active" as const,
  catchUpPolicy: "skip_missed" as const,
  configJson: JSON.stringify({
    steps: [
      {
        id: "b",
        agent: "agent/b",
        dependsOn: ["a"],
        timeoutMs: 20,
        maxAttempts: 2,
        acceptanceCriteria: "done",
        failureAction: "stop",
      },
      {
        id: "a",
        agent: "agent/a",
        dependsOn: [],
        timeoutMs: 10,
        maxAttempts: 1,
        acceptanceCriteria: "done",
        failureAction: "continue",
      },
    ],
  }),
  gateJson: "{}",
  budgetJson: "{}",
};

describe("bounded process compiler", () => {
  it("emits deterministic dependency order and bounds", () => {
    const process = compileProcess(base);
    expect(process.order).toEqual(["a", "b"]);
    expect(process.maxAttempts).toBe(3);
    expect(process.maxDurationMs).toBe(30);
  });

  it("rejects cycles and unbounded attempts", () => {
    expect(() =>
      compileProcess({
        ...base,
        configJson: JSON.stringify({
          steps: [
            {
              id: "a",
              agent: "agent/a",
              dependsOn: ["b"],
              timeoutMs: 1,
              maxAttempts: 1,
              acceptanceCriteria: "done",
              failureAction: "stop",
            },
            {
              id: "b",
              agent: "agent/b",
              dependsOn: ["a"],
              timeoutMs: 1,
              maxAttempts: 0,
              acceptanceCriteria: "done",
              failureAction: "stop",
            },
          ],
        }),
      }),
    ).toThrow(/invalid maxAttempts/);
    expect(() =>
      compileProcess({
        ...base,
        configJson: JSON.stringify({
          steps: [
            {
              id: "a",
              agent: "agent/a",
              dependsOn: ["b"],
              timeoutMs: 1,
              maxAttempts: 1,
              acceptanceCriteria: "done",
              failureAction: "stop",
            },
            {
              id: "b",
              agent: "agent/b",
              dependsOn: ["a"],
              timeoutMs: 1,
              maxAttempts: 1,
              acceptanceCriteria: "done",
              failureAction: "stop",
            },
          ],
        }),
      }),
    ).toThrow(/cycle/);
  });
});
