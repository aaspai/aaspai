import type { DecideResult, WorkItem } from "@aaspai/contracts/phase2";
import { describe, expect, it } from "vitest";
import decide from "../src/patterns/daily-triage/decide.js";

function makeItem(data: Record<string, unknown>): WorkItem {
  return {
    ref: { kind: "session", id: "s1", title: "x" },
    title: "test",
    discoveredAt: new Date().toISOString(),
    data: data as never, // the decide function reads it loosely
  };
}

describe("daily-triage decide", () => {
  it("returns act for failed sessions", async () => {
    const item = makeItem({ kind: "session", status: "failed", errorMessage: "boom" });
    const r = await decide(item, {} as never, { loopId: "loop/daily-triage", now: new Date() });
    expect(r.kind).toBe("act");
    if (r.kind === "act") expect(r.reason).toContain("boom");
  });

  it("returns report for succeeded sessions", async () => {
    const item = makeItem({ kind: "session", status: "succeeded" });
    const r: DecideResult = await decide(item, {} as never, {
      loopId: "loop/daily-triage",
      now: new Date(),
    });
    expect(r.kind).toBe("report");
  });

  it("returns noop for sessions in other states", async () => {
    const item = makeItem({ kind: "session", status: "running" });
    const r = await decide(item, {} as never, { loopId: "loop/daily-triage", now: new Date() });
    expect(r.kind).toBe("noop");
  });

  it("returns report for failed wakeups", async () => {
    const item = makeItem({ kind: "wakeup", status: "failed", error: "x" });
    const r = await decide(item, {} as never, { loopId: "loop/daily-triage", now: new Date() });
    expect(r.kind).toBe("report");
  });

  it("returns noop for an empty data payload", async () => {
    const item = makeItem({});
    const r = await decide(item, {} as never, { loopId: "loop/daily-triage", now: new Date() });
    expect(r.kind).toBe("noop");
  });
});
