import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { describe, expect, it } from "vitest";
import {
  type AcpExecutorOptions,
  executeAcp,
  parseAcpConfig,
  resolveAcpEngine,
} from "../src/shared/acp.js";

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

  it("fails closed when a managed execution boundary lacks controlled ACP support", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-harness-acp-boundary-"));
    const result = await executeAcp(
      {
        ...context(stateDir, async () => undefined),
        execution: {
          identity: { kind: "local", cwd: stateDir },
          run: async () => {
            throw new Error("must not be called");
          },
        },
      },
      "claude",
      {},
      { nodeVersion: "v22.12.0" },
    );

    expect(result.errorCode).toBe("acp_runtime_boundary_unavailable");
  });

  it("falls back from auto ACP on unsupported Node versions", async () => {
    const selection = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto" }, cwd: process.cwd() },
      { nodeVersion: "v20.18.0" },
    );

    expect(selection).toMatchObject({ engine: "cli", explicit: false });
    expect(selection.fallbackReason).toContain("Node");
  });

  it("rejects unsupported ACP permissions before starting a runtime", async () => {
    const selection = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", permissionMode: "unsafe" }, cwd: process.cwd() },
      { nodeVersion: "v22.12.0" },
    );

    expect(selection).toMatchObject({ engine: "cli", explicit: false });
    expect(selection.fallbackReason).toContain("permission mode");
  });

  it("scopes default state to organization and agent", () => {
    const parsed = parseAcpConfig("codex", {}, { organizationId: "org_a", agentId: "agent_b" });
    expect(parsed.stateDir).toContain("org_a");
    expect(parsed.stateDir).toContain("agent_b");
  });

  it("passes controlled environment and ACP policy to the runtime", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-harness-acp-policy-"));
    let sessionOptions: Record<string, unknown> | undefined;
    const configOptions: Array<{ key: string; value: string }> = [];
    const fakeRuntime = {
      ensureSession: async (input: { sessionOptions?: Record<string, unknown> }) => {
        sessionOptions = input.sessionOptions;
        return { sessionKey: "key", backend: "acpx", runtimeSessionName: "runtime" };
      },
      setConfigOption: async (input: { key: string; value: string }) => {
        configOptions.push(input);
      },
      startTurn: () => ({
        events: (async function* () {
          yield { type: "text_delta" as const, text: "ok", stream: "output" as const };
        })(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
      getStatus: async () => undefined,
    };
    const result = await executeAcp(
      {
        ...context(stateDir, async () => undefined),
        config: {
          stateDir,
          acpAllowedTools: ["Read"],
          effort: "high",
          warmHandleIdleMs: 0,
        },
        execution: {
          identity: { kind: "local", cwd: stateDir },
          environment: { env: { AASPAI_EPHEMERAL_TOKEN: "runtime-only" }, inheritEnv: false },
          run: async () => {
            throw new Error("ACP should not use the CLI runner");
          },
        },
      },
      "claude",
      {},
      {
        createRuntime: (() => fakeRuntime) as unknown as AcpExecutorOptions["createRuntime"],
        nodeVersion: "v22.12.0",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(sessionOptions).toMatchObject({
      allowedTools: ["Read"],
      env: { AASPAI_EPHEMERAL_TOKEN: "runtime-only" },
    });
    expect(configOptions).toMatchObject([{ key: "effort", value: "high" }]);
  });
});
