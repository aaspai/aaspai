import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import {
  cursorCloud,
  cursorLocal,
  getAdapter,
  listAdapters,
  localSessionCodec,
} from "@aaspai/harness";
import { describe, expect, it, vi } from "vitest";

function processResult(): RunProcessResult {
  return {
    exitCode: 0,
    signal: undefined,
    timedOut: false,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    runtimeIdentity: { kind: "local", cwd: "C:\\work" },
  };
}

function context(
  run: (options: RunProcessOptions) => Promise<RunProcessResult>,
): AdapterExecutionContext {
  return {
    protocolVersion: 1,
    runId: "run_provider_parity",
    organizationId: "org_provider_parity",
    agent: {
      id: "agent_provider_parity",
      organizationId: "org_provider_parity",
      name: "Provider parity",
      adapterType: "cursor_local",
      adapterConfig: {},
    },
    runtime: {},
    config: { model: "auto" },
    context: { cwd: "C:\\work", prompt: "hello" },
    execution: {
      identity: { kind: "local", cwd: "C:\\work" },
      environment: { env: { PATH: "C:\\bin" }, inheritEnv: false },
      run,
    },
    onLog: vi.fn(async () => {}),
  };
}

describe("provider parity surface", () => {
  it("keeps every registered provider executable and environment-testable", () => {
    for (const adapter of listAdapters()) {
      const module = getAdapter(adapter.type);
      expect(adapter.status).toBe("ready");
      expect(typeof module.execute).toBe("function");
      expect(typeof module.testEnvironment).toBe("function");
    }
  });

  it("executes the shared local provider path with JSONL session and usage output", async () => {
    const run = vi.fn(async (options: RunProcessOptions) => {
      await options.onLog?.(
        "stdout",
        `${JSON.stringify({ type: "assistant", session_id: "cursor-session", text: "hello", usage: { input_tokens: 2, output_tokens: 3 } })}\n`,
      );
      return processResult();
    });
    const result = await cursorLocal.execute(context(run));

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: "agent", stdin: "hello" }));
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "cursor-session",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
  });

  it("normalizes provider session aliases without accepting malformed state", () => {
    expect(localSessionCodec.deserialize({ session_id: "s1", cwd: "C:\\work" })).toEqual({
      sessionId: "s1",
      cwd: "C:\\work",
    });
    expect(localSessionCodec.deserialize({ session_id: "" })).toBeNull();
    expect(localSessionCodec.getDisplayId?.({ nativeSessionId: "s2" })).toBe("s2");
  });

  it("fails cloud execution before network access when credentials are absent", async () => {
    const result = await cursorCloud.execute({
      ...context(async () => processResult()),
      agent: { ...context(async () => processResult()).agent, adapterType: "cursor_cloud" },
      config: {},
    });
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "cursor_cloud_failed",
      errorFamily: "auth",
    });
  });
});
