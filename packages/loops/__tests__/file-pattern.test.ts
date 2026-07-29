import type { LoopPattern } from "@aaspai/contracts/phase2";
import { describe, expect, it } from "vitest";
import { isDue, resolveFilePattern } from "../src/index";

const pattern: LoopPattern = {
  id: "loop/custom",
  type: "LoopPattern",
  title: "Custom",
  description: "Fallback description",
  timestamp: "2026-07-29T00:00:00.000Z",
  schedule: { kind: "interval", seconds: 900 },
  agent: "agent/operator",
  autonomyLevel: "L1",
  status: "enabled",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  configJson: JSON.stringify({ instructions: "Run the custom task." }),
  gateJson: "{}",
  budgetJson: "{}",
};

describe("file-defined loops", () => {
  it("turns a custom definition into one executable item", async () => {
    const resolved = resolveFilePattern(pattern);
    const now = new Date("2026-07-29T00:00:00.000Z");
    const items = await resolved.discover(
      {},
      { loopId: pattern.id, organizationId: "org_test", now },
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("Run the custom task.");
    await expect(resolved.decide(items[0]!, {}, { loopId: pattern.id, now })).resolves.toEqual({
      kind: "act",
      reason: "Run the custom task.",
    });
  });

  it("uses file policy while preserving a built-in implementation", async () => {
    const discover = async () => [];
    const resolved = resolveFilePattern(pattern, {
      pattern: { ...pattern, autonomyLevel: "L3" },
      discover,
      decide: async () => ({ kind: "noop" }),
    });

    expect(resolved.pattern.autonomyLevel).toBe("L1");
    expect(resolved.discover).toBe(discover);
  });

  it("fires interval loops only inside their occurrence window", () => {
    expect(isDue(pattern, new Date("2026-07-29T00:00:30.000Z"), 60_000)).toBe(true);
    expect(isDue(pattern, new Date("2026-07-29T00:01:30.000Z"), 60_000)).toBe(false);
    expect(isDue(pattern, new Date("2026-07-29T00:15:30.000Z"), 60_000)).toBe(true);
  });
});
