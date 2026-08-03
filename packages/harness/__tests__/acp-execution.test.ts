import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { describe, expect, it } from "vitest";
import { type AcpExecutorOptions, executeAcp } from "../src/shared/acp.js";

function context(
  stateDir: string,
  onLog: AdapterExecutionContext["onLog"],
): AdapterExecutionContext {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId: "run_acp_test",
    organizationId: "org_test",
    agent: {
      id: "agent_acp",
      organizationId: "org_test",
      name: "ACP",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {},
    config: { stateDir },
    context: { cwd: stateDir, prompt: "test ACP" },
    onLog,
  };
}

describe("shared ACP execution", () => {
  it("streams ACP events, resumes state, and reports per-run usage", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-harness-acp-"));
    const logs: string[] = [];
    let statusCalls = 0;
    let closed = false;
    const fakeRuntime = {
      ensureSession: async () => ({
        sessionKey: "key",
        backend: "acpx",
        runtimeSessionName: "runtime-session",
        backendSessionId: "backend-session",
        acpxRecordId: "record",
        agentSessionId: "agent-session",
      }),
      getStatus: async () => {
        statusCalls += 1;
        return {
          usage:
            statusCalls === 1
              ? { cumulative: { inputTokens: 2 } }
              : { cumulative: { inputTokens: 5, outputTokens: 4, cachedReadTokens: 1 } },
        };
      },
      startTurn: () => ({
        events: (async function* () {
          yield { type: "text_delta" as const, text: "hello", stream: "output" as const };
          yield {
            type: "tool_call" as const,
            title: "Read",
            toolCallId: "tool-1",
            status: "completed",
            rawInput: { path: "file.txt" },
            rawOutput: "contents",
          };
        })(),
        result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
        cancel: async () => undefined,
      }),
      close: async () => {
        closed = true;
      },
    };
    const options: AcpExecutorOptions = {
      createRuntime: (() => fakeRuntime) as unknown as AcpExecutorOptions["createRuntime"],
      nodeVersion: "v22.12.0",
    };

    const result = await executeAcp(
      context(stateDir, async (_stream, chunk) => {
        logs.push(chunk);
      }),
      "claude",
      {},
      options,
    );

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("backend-session");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 });
    expect(result.sessionParams).toMatchObject({ acpSessionId: "backend-session" });
    expect(logs.some((line) => line.includes('"kind":"assistant"'))).toBe(true);
    expect(logs.some((line) => line.includes('"kind":"tool_result"'))).toBe(true);
    expect(closed).toBe(true);
  });
});
