import { parseClaudeStreamLine } from "@aaspai/harness/drivers/claude-local";
import { parseCodexStreamLine } from "@aaspai/harness/drivers/codex-local";
import { describe, expect, it } from "vitest";

const ts = "2026-01-01T00:00:00.000Z";

describe("parseClaudeStreamLine", () => {
  it("ignores blank lines and rejects valid JSON that is not a Claude event", () => {
    expect(parseClaudeStreamLine("  \n", ts)).toEqual([]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "" }), ts)).toEqual([
      { kind: "stdout", ts, text: JSON.stringify({ type: "" }) },
    ]);
  });

  it("returns a stdout entry for non-JSON", () => {
    const out = parseClaudeStreamLine("hello", ts);
    expect(out).toEqual([{ kind: "stdout", ts, text: "hello" }]);
  });

  it("returns an init entry for system/init", () => {
    const out = parseClaudeStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s1",
        message: "claude-sonnet-4-6",
      }),
      ts,
    );
    expect(out[0]?.kind).toBe("init");
    if (out[0]?.kind === "init") {
      expect(out[0].sessionId).toBe("s1");
      expect(out[0].model).toBe("claude-sonnet-4-6");
    }
  });

  it("returns a system entry for non-init system events", () => {
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: "system", message: { status: "ready" } }), ts),
    ).toEqual([{ kind: "system", ts, text: JSON.stringify({ status: "ready" }) }]);
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

  it("falls back for assistant events without usable blocks", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "assistant", message: {} }), ts)).toEqual([
      { kind: "assistant", ts, text: "{}" },
    ]);
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "assistant", message: { content: [null, { type: "unknown" }] } }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: JSON.stringify({ content: [null, { type: "unknown" }] }) },
    ]);
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

  it("handles user messages without tool results and structured tool output", () => {
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: "user", message: { text: "hi" } }), ts),
    ).toEqual([{ kind: "user", ts, text: JSON.stringify({ text: "hi" }) }]);
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [null, { type: "tool_result", content: { ok: true }, is_error: true }],
          },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        name: "tool",
        output: JSON.stringify({ ok: true }),
        isError: true,
      },
    ]);
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

  it("uses defensive error and unknown-event fallbacks", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "error" }), ts)).toEqual([
      { kind: "stderr", ts, text: JSON.stringify({ type: "error" }) },
    ]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "custom", value: 1 }), ts)).toEqual([
      { kind: "system", ts, text: JSON.stringify({ type: "custom", value: 1 }) },
    ]);
  });

  it("covers Claude alternate system, block, user, result, and error shapes", () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "system", subtype: "session_start", session_id: "s" }),
        ts,
      )[0]?.kind,
    ).toBe("init");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "system", subtype: "ready", message: undefined }),
        ts,
      )[0]?.kind,
    ).toBe("system");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", input: "bad" }, null, { type: "unknown" }] },
        }),
        ts,
      )[0]?.kind,
    ).toBe("tool_call");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", content: { ok: true }, is_error: false }] },
        }),
        ts,
      )[0]?.kind,
    ).toBe("tool_result");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", name: "Read", tool_use_id: "tool", content: "ok" }],
          },
        }),
        ts,
      )[0],
    ).toMatchObject({ name: "Read", id: "tool" });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "ignored" }] } }),
        ts,
      )[0]?.kind,
    ).toBe("user");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "result", subtype: "error", result: 2, is_error: true }),
        ts,
      )[0],
    ).toMatchObject({ kind: "result", isError: true });
    expect(parseClaudeStreamLine(JSON.stringify({ type: "error" }), ts)[0]?.kind).toBe("stderr");
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "assistant", message: { content: [{ type: 1, text: "ignored" }] } }),
        ts,
      )[0]?.kind,
    ).toBe("assistant");
    expect(parseClaudeStreamLine(JSON.stringify({ type: "assistant" }), ts)[0]?.kind).toBe(
      "assistant",
    );
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "ignored" }] } }),
        ts,
      )[0]?.kind,
    ).toBe("user");
    expect(parseClaudeStreamLine(JSON.stringify({ type: "user" }), ts)[0]?.kind).toBe("user");
  });
});

describe("parseCodexStreamLine", () => {
  it("ignores blank lines and rejects invalid event shapes", () => {
    expect(parseCodexStreamLine("  \n", ts)).toEqual([]);
    expect(parseCodexStreamLine("not-json", ts)).toEqual([
      { kind: "stdout", ts, text: "not-json" },
    ]);
    expect(parseCodexStreamLine(JSON.stringify({ type: "" }), ts)).toEqual([
      { kind: "stdout", ts, text: JSON.stringify({ type: "" }) },
    ]);
  });

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

  it("handles turns without usage and failed turns with string or object errors", () => {
    expect(parseCodexStreamLine(JSON.stringify({ type: "turn.started" }), ts)).toEqual([
      { kind: "system", ts, text: "turn started" },
    ]);
    expect(parseCodexStreamLine(JSON.stringify({ type: "turn.completed" }), ts)).toEqual([
      { kind: "result", ts, summary: undefined, stopReason: "completed" },
    ]);
    expect(
      parseCodexStreamLine(JSON.stringify({ type: "turn.failed", error: "failed" }), ts),
    ).toEqual([
      { kind: "result", ts, summary: "failed", isError: true, stopReason: "failed" },
      { kind: "stderr", ts, text: "failed" },
    ]);
    expect(
      parseCodexStreamLine(JSON.stringify({ type: "turn.failed", error: { code: "E" } }), ts),
    ).toEqual([
      {
        kind: "result",
        ts,
        summary: JSON.stringify({ code: "E" }),
        isError: true,
        stopReason: "failed",
      },
      { kind: "stderr", ts, text: JSON.stringify({ code: "E" }) },
    ]);
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

  it("preserves failed command status and output", () => {
    const out = parseCodexStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "c1",
          command: "node --version",
          aggregated_output: "sandbox failed",
          exit_code: -1,
          status: "failed",
        },
      }),
      ts,
    );
    expect(out).toEqual([
      expect.objectContaining({ kind: "tool_call", status: "failed" }),
      expect.objectContaining({ kind: "tool_result", output: "sandbox failed", isError: true }),
    ]);
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

  it("covers reasoning, missing items, tool states, and command inputs", () => {
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "item.updated", item: { type: "reasoning", text: "think" } }),
        ts,
      ),
    ).toEqual([{ kind: "thinking", ts, text: "think" }]);
    expect(parseCodexStreamLine(JSON.stringify({ type: "item.started" }), ts)).toEqual([
      { kind: "system", ts, text: JSON.stringify({ type: "item.started" }) },
    ]);
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", command: "pwd" },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "tool_call", ts, name: "command", status: "started", input: { command: "pwd" } },
    ]);
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "item.updated", item: { type: "tool_call", status: "cancelled" } }),
        ts,
      ),
    ).toEqual([{ kind: "tool_call", ts, name: "tool", status: "cancelled", input: undefined }]);
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", output: { ok: true } },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "tool_call", ts, name: "command", status: "completed", input: undefined },
      {
        kind: "tool_result",
        ts,
        name: "command",
        output: JSON.stringify({ ok: true }),
        isError: false,
      },
    ]);
  });

  it("handles direct tool results, unknown items, errors, and unknown events", () => {
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "tool_result", output: { value: 1 }, is_error: true },
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "tool_result",
        ts,
        name: "tool",
        output: JSON.stringify({ value: 1 }),
        isError: true,
      },
    ]);
    expect(
      parseCodexStreamLine(JSON.stringify({ type: "item.completed", item: { type: "other" } }), ts),
    ).toEqual([
      {
        kind: "system",
        ts,
        text: JSON.stringify({ type: "item.completed", item: { type: "other" } }),
      },
    ]);
    expect(parseCodexStreamLine(JSON.stringify({ type: "error", error: "boom" }), ts)).toEqual([
      { kind: "stderr", ts, text: "boom" },
    ]);
    expect(
      parseCodexStreamLine(JSON.stringify({ type: "error", error: { code: "E" } }), ts),
    ).toEqual([{ kind: "stderr", ts, text: JSON.stringify({ code: "E" }) }]);
    expect(parseCodexStreamLine(JSON.stringify({ type: "other" }), ts)).toEqual([
      { kind: "system", ts, text: JSON.stringify({ type: "other" }) },
    ]);
  });

  it("covers Codex session, usage, item, status, and output alternatives", () => {
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "session.started", session_id: "session" }),
        ts,
      )[0]?.kind,
    ).toBe("init");
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
        ts,
      )[0],
    ).toMatchObject({ summary: "in=1" });
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "turn.completed", usage: { output_tokens: 2 } }),
        ts,
      )[0],
    ).toMatchObject({ summary: "out=2" });
    expect(parseCodexStreamLine(JSON.stringify({ type: "item.started" }), ts)[0]?.kind).toBe(
      "system",
    );
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: 1 } }),
        ts,
      )[0]?.kind,
    ).toBe("system");
    expect(
      parseCodexStreamLine(
        JSON.stringify({ type: "item.updated", item: { type: "reasoning", text: 1 } }),
        ts,
      )[0]?.kind,
    ).toBe("system");
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.updated",
          item: { type: "tool_call", name: "tool", id: "id", status: "completed", input: "bad" },
        }),
        ts,
      )[0],
    ).toMatchObject({ kind: "tool_call", status: "completed" });
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", id: "id", command: "C:\\Users\\me\\x" },
        }),
        ts,
      )[0],
    ).toMatchObject({ status: "started" });
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", id: "id", exit_code: 2, output: { ok: true } },
        }),
        ts,
      )[1],
    ).toMatchObject({ kind: "tool_result", isError: true });
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution_output", id: "id", output: { ok: true } },
        }),
        ts,
      )[0]?.kind,
    ).toBe("tool_result");
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "tool_result", id: "id", output: "ok", is_error: false },
        }),
        ts,
      )[0],
    ).toMatchObject({ isError: false });
    expect(parseCodexStreamLine(JSON.stringify({ type: "turn.failed" }), ts)[0]).toMatchObject({
      summary: "{}",
    });
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", id: "id", output: "text" },
        }),
        ts,
      )[1],
    ).toMatchObject({ output: "text" });
    expect(
      parseCodexStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "tool_result", output: undefined },
        }),
        ts,
      )[0],
    ).toMatchObject({ output: '""' });
    expect(parseCodexStreamLine(JSON.stringify({ type: "error" }), ts)[0]).toEqual({
      kind: "stderr",
      ts,
      text: "{}",
    });
  });
});
