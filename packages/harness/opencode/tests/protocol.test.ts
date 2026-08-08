import { describe, expect, it } from "vitest";
import { createOpenCodeAccumulator } from "../src/protocol/accumulator.js";
import { decodeOpenCodeLine } from "../src/protocol/decode.js";
import { extractErrorMessage } from "../src/protocol/error-parser.js";
import { decideResume } from "../src/session/resume-policy.js";

const ses = "ses_real";

function line(event: unknown): string {
  return JSON.stringify(event);
}

describe("opencode protocol decode", () => {
  it("decodes a real-shaped event (type/timestamp/sessionID/part)", () => {
    const event = decodeOpenCodeLine(
      JSON.stringify({
        type: "text",
        timestamp: 1_752_000_000_000,
        sessionID: ses,
        part: { type: "text", text: "hello", time: { start: 1, end: 2 } },
      }),
    );
    expect(event).toMatchObject({
      type: "text",
      sessionID: ses,
      part: { type: "text", text: "hello" },
    });
  });

  it("returns null for non-JSON and empty lines", () => {
    expect(decodeOpenCodeLine("")).toBeNull();
    expect(decodeOpenCodeLine("   ")).toBeNull();
    expect(decodeOpenCodeLine("not json")).toBeNull();
    expect(decodeOpenCodeLine('{"no":"type"}')).toBeNull();
  });

  it("carries the error payload on error events", () => {
    const event = decodeOpenCodeLine(
      JSON.stringify({
        type: "error",
        sessionID: ses,
        error: { name: "ProviderError", data: { message: "rate limited" } },
      }),
    );
    expect(event?.error).toMatchObject({ name: "ProviderError" });
  });
});

describe("opencode protocol accumulator", () => {
  it("aggregates text, tokens, cost and session from a real-shaped stream", () => {
    const acc = createOpenCodeAccumulator();
    acc.apply(
      decodeOpenCodeLine(
        line({ type: "text", sessionID: ses, part: { type: "text", text: "a" } }),
      )!,
    );
    acc.apply(
      decodeOpenCodeLine(
        line({ type: "text", sessionID: ses, part: { type: "text", text: "b" } }),
      )!,
    );
    const finish = acc.apply(
      decodeOpenCodeLine(
        line({
          type: "step_finish",
          sessionID: ses,
          part: { type: "step-finish", tokens: { input: 10, output: 5, total: 15 }, cost: 0.02 },
        }),
      )!,
    );
    const state = acc.result();
    expect(state.sessionId).toBe(ses);
    expect(state.text).toBe("ab");
    expect(state.inputTokens).toBe(10);
    expect(state.outputTokens).toBe(5);
    expect(state.cost).toBe(0.02);
    expect(finish.events.some((e) => e.type === "usage")).toBe(true);
    expect(finish.events.some((e) => e.type === "step.completed")).toBe(true);
  });

  it("accepts the legacy thinking spelling and the real reasoning spelling", () => {
    const acc = createOpenCodeAccumulator();
    acc.apply(
      decodeOpenCodeLine(line({ type: "thinking", part: { type: "thinking", text: "legacy" } }))!,
    );
    acc.apply(
      decodeOpenCodeLine(line({ type: "reasoning", part: { type: "reasoning", text: "real" } }))!,
    );
    const state = acc.result();
    expect(state.thinkingEventCount).toBe(2);
    expect(state.text).toBe("");
  });

  it("emits native tool events once per call", () => {
    const acc = createOpenCodeAccumulator();
    const first = acc.apply(
      decodeOpenCodeLine(
        line({
          type: "tool_use",
          sessionID: ses,
          part: {
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "completed", output: "ok" },
          },
        }),
      )!,
    );
    const second = acc.apply(
      decodeOpenCodeLine(
        line({
          type: "tool_use",
          sessionID: ses,
          part: {
            type: "tool",
            tool: "bash",
            callID: "call-1",
            state: { status: "completed", output: "ok" },
          },
        }),
      )!,
    );
    expect(first.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.completed", toolName: "bash" }),
      ]),
    );
    expect(second.events).toHaveLength(0);
    const state = acc.result();
    expect(state.toolEventCount).toBe(2);
    expect(state.toolsInvoked).toEqual(["bash"]);
    expect(state.toolEvents).toEqual([
      { name: "bash", status: "completed", output: "ok", id: "call-1" },
    ]);
  });

  it("records step_start and error events as init/error transcript entries", () => {
    const acc = createOpenCodeAccumulator();
    const started = acc.apply(
      decodeOpenCodeLine(
        line({ type: "step_start", sessionID: ses, part: { type: "step-start" } }),
      )!,
    );
    expect(started.transcript[0]).toMatchObject({ kind: "init", event: "step_start" });
    const errored = acc.apply(
      decodeOpenCodeLine(
        line({ type: "error", sessionID: ses, error: { message: "api key invalid" } }),
      )!,
    );
    expect(errored.transcript[0]).toMatchObject({
      kind: "init",
      event: "error",
      errorMessage: "api key invalid",
    });
    expect(errored.events[0]).toMatchObject({ type: "error", message: "api key invalid" });
    expect(acc.result().jsonErrorMessage).toBe("api key invalid");
  });
});

describe("opencode protocol error-parser", () => {
  it("extracts from string, {message}, {data.message}, name, code", () => {
    expect(extractErrorMessage("boom")).toBe("boom");
    expect(extractErrorMessage({ message: "m" })).toBe("m");
    expect(extractErrorMessage({ data: { message: "nested" } })).toBe("nested");
    expect(extractErrorMessage({ name: "ProviderError", data: { message: "nested" } })).toBe(
      "nested",
    );
    expect(extractErrorMessage({ code: "E123" })).toBe("E123");
    expect(extractErrorMessage({ foo: 1 })).toBe('{"foo":1}');
    expect(extractErrorMessage(null)).toBeUndefined();
    expect(extractErrorMessage("")).toBeUndefined();
  });
});

describe("opencode resume policy (PR8)", () => {
  const binding = {
    harness: "opencode",
    nativeSessionId: "ses_native_1",
    driver: "cli",
    runtime: { kind: "local" },
    workspace: { cwd: "/w" },
  };

  it("allows resuming when runtime and workspace match", () => {
    expect(decideResume(binding, { runtimeKind: "local", cwd: "/w" })).toEqual({
      allowed: true,
      sessionId: "ses_native_1",
    });
  });

  it("rejects when the runtime changed", () => {
    expect(decideResume(binding, { runtimeKind: "ssh", cwd: "/w" })).toEqual({
      allowed: false,
      reason: "runtime_changed",
    });
  });

  it("rejects when the workspace cwd changed", () => {
    expect(decideResume(binding, { runtimeKind: "local", cwd: "/other" })).toEqual({
      allowed: false,
      reason: "workspace_changed",
    });
  });

  it("reports session_missing for no binding", () => {
    expect(decideResume(undefined, { runtimeKind: "local", cwd: "/w" })).toEqual({
      allowed: false,
      reason: "session_missing",
    });
  });
});
