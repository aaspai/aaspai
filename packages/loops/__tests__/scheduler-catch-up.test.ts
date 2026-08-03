import type { LoopPattern } from "@aaspai/contracts/phase2";
import { describe, expect, it } from "vitest";
import { nextScheduledOccurrence, scheduledOccurrences } from "../src/scheduler";

describe("scheduler catch-up", () => {
  it("enqueues bounded missed interval occurrences", () => {
    const loop = pattern("enqueue_missed_with_cap", { catchUpCap: 3 });
    const occurrences = scheduledOccurrences(
      loop,
      new Date("2026-07-29T01:00:00.000Z"),
      new Date("2026-07-29T00:00:00.000Z"),
    );
    expect(occurrences.map((value) => value.toISOString())).toEqual([
      "2026-07-29T00:15:00.000Z",
      "2026-07-29T00:30:00.000Z",
      "2026-07-29T00:45:00.000Z",
    ]);
  });

  it("does not replay missed occurrences under skip_missed", () => {
    expect(
      scheduledOccurrences(
        pattern("skip_missed"),
        new Date("2026-07-29T01:07:00.000Z"),
        new Date("2026-07-29T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("calculates the next recurring process cadence", () => {
    const after = new Date("2026-07-29T01:07:00.000Z");
    expect(
      nextScheduledOccurrence(
        { schedule: { kind: "interval", seconds: 900 } },
        after,
      )?.toISOString(),
    ).toBe("2026-07-29T01:22:00.000Z");
    expect(
      nextScheduledOccurrence(
        { schedule: { kind: "cron", expression: "0 8 * * *", timezone: "UTC" } },
        after,
      )?.toISOString(),
    ).toBe("2026-07-29T08:00:00.000Z");
    expect(
      nextScheduledOccurrence({ schedule: { kind: "cron", expression: "not cron" } }, after),
    ).toBeNull();
  });
});

function pattern(
  catchUpPolicy: LoopPattern["catchUpPolicy"],
  config: Record<string, unknown> = {},
): LoopPattern {
  return {
    id: "loop/catch-up",
    type: "LoopPattern",
    title: "Catch up",
    description: "Catch-up fixture",
    timestamp: "2026-07-29T00:00:00.000Z",
    schedule: { kind: "interval", seconds: 900 },
    agent: "agent/test",
    autonomyLevel: "L1",
    status: "enabled",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy,
    configJson: JSON.stringify(config),
    gateJson: "{}",
    budgetJson: "{}",
  };
}
