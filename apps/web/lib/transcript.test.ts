import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnParts, replyText } from "./transcript";

const entry = (seq: number, kind: string, payload: Record<string, unknown>) => ({
  seq,
  kind,
  payload,
  ts: "2026-01-01T00:00:00Z",
});

test("merges assistant text deltas into a single text part", () => {
  const parts = buildTurnParts([
    entry(1, "assistant", { text: "Hello " }),
    entry(2, "assistant", { text: "world" }),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.type, "text");
  if (parts[0]?.type === "text") assert.equal(parts[0].text, "Hello world");
});

test("groups thinking deltas into one block", () => {
  const parts = buildTurnParts([
    entry(1, "thinking", { text: "step one" }),
    entry(2, "thinking", { text: "step two" }),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.type, "thinking");
  if (parts[0]?.type === "thinking") assert.equal(parts[0].text, "step onestep two");
});

test("merges tool_call + tool_result by id into one tool part", () => {
  const parts = buildTurnParts([
    entry(1, "tool_call", {
      name: "bash",
      id: "call_1",
      status: "started",
      input: { command: "ls" },
    }),
    entry(2, "tool_result", {
      name: "bash",
      id: "call_1",
      status: "completed",
      output: "file.txt",
    }),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.type, "tool");
  if (parts[0]?.type === "tool") {
    assert.equal(parts[0].name, "bash");
    assert.deepEqual(parts[0].input, { command: "ls" });
    assert.equal(parts[0].output, "file.txt");
  }
});

test("skips init/stdout/stderr/system noise", () => {
  const parts = buildTurnParts([
    entry(1, "init", { model: "x" }),
    entry(2, "stdout", { text: "raw" }),
    entry(3, "stderr", { text: "err" }),
    entry(4, "system", { text: "sys" }),
    entry(5, "assistant", { text: "reply" }),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.type, "text");
});

test("falls back to result summary as reply text", () => {
  const text = replyText([entry(1, "result", { summary: "final summary" })]);
  assert.equal(text, "final summary");
});

test("prefers assistant text over result summary", () => {
  const text = replyText([
    entry(1, "assistant", { text: "assistant text" }),
    entry(2, "result", { summary: "final summary" }),
  ]);
  assert.equal(text, "assistant text");
});
