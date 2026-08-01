import { describe, expect, it } from "vitest";
import { classifyTool, observeExecution } from "../src/execution-observer";

describe("execution observer", () => {
  it("separates company, native work, and MCP tools", () => {
    expect(classifyTool("company_action")).toEqual({ lane: "company", origin: "aaspai" });
    expect(classifyTool("bash")).toEqual({ lane: "work", origin: "agent_native" });
    expect(classifyTool("mcp__crm__search")).toEqual({ lane: "work", origin: "mcp" });
  });

  it("merges company effects and agent work into one ordered timeline", () => {
    const timeline = observeExecution({
      executionEvents: [
        {
          id: 2,
          seq: 2,
          ts: "2026-08-01T00:00:02.000Z",
          type: "company.action.completed",
          payload: { plane: "company", actionType: "hire_and_delegate", status: "succeeded" },
        },
      ],
      sessionEvents: [
        {
          id: 1,
          seq: 1,
          ts: "2026-08-01T00:00:01.000Z",
          kind: "tool_call",
          payload: { name: "bash", status: "started" },
        },
      ],
    });
    expect(timeline.map(({ lane, name }) => [lane, name])).toEqual([
      ["work", "bash"],
      ["company", "company.action.completed"],
    ]);
  });
});
