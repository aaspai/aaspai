import { describe, expect, it } from "vitest";
import { parseClaudeStreamLine } from "@aaspai/harness/drivers/claude-local";
import { parseCodexStreamLine } from "@aaspai/harness/drivers/codex-local";

const ts = "2026-01-01T00:00:00.000Z";

describe("parseClaudeStreamLine", () => {
  it("returns a stdout entry for non-JSON", () => {
    const out = parseClaudeStreamLine("hello", ts);
    expect(out).toEqual([{ kind: "stdout", ts, text: "hello" }]);
  });

  it("returns an init entry for system/init", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", message: "claude-sonnet-4-6" }),
      ts,
    );
    expect(out[0]?.kind).toBe("init");
    if (out[0]?.kind === "init") {
      expect(out[0].sessionId).toBe("s1");
      expect(out[0].model).toBe("claude-sonnet-4-6");
    }
  });

  it("returns an assistant entry for assistant/text", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("assistant");
  });

  it("returns a thinking entry for assistant/thinking", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "deep thought" }] },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("thinking");
  });

  it("returns a tool_call entry for assistant/tool_use", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }],
        },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("tool_call");
    if (out[0]?.kind === "tool_call") {
      expect(out[0].name).toBe("Read");
      expect(out[0].id).toBe("t1");
    }
  });

  it("returns a tool_result entry for user/tool_result", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("tool_result");
  });

  it("returns a result entry for result", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
      ts,
    );
    expect(out[0]?.kind).toBe("result");
  });

  it("returns a stderr entry for error", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({ type: "error", error: { message: "boom" } }),
      ts,
    );
    expect(out[0]?.kind).toBe("stderr");
  });
});

describe("parseCodexStreamLine", () => {
  it("returns init for thread.started", () => {
    const out = parseCodexStreamLine(
      JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
      ts,
    );
    expect(out[0]?.kind).toBe("init");
    if (out[0]?.kind === "init") expect(out[0].sessionId).toBe("th_1");
  });

  it("returns result for turn.completed with usage", () => {
    const out = parseCodexStreamLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("result");
  });

  it("returns a tool_call for item.completed/command_execution", () => {
    const out = parseCodexStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "c1", input: { cmd: "ls" } },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("tool_call");
  });

  it("returns an assistant for item.completed/agent_message", () => {
    const out = parseCodexStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("assistant");
  });
});
