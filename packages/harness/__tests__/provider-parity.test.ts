import type { AdapterExecutionContext, ServerAdapterModule } from "@aaspai/contracts/harness";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import {
  cursorCloud,
  cursorLocal,
  getAdapter,
  grokLocal,
  hermesLocal,
  listAdapters,
  localSessionCodec,
  piLocal,
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

  it.each([
    ["cursor_local", cursorLocal],
    ["grok_local", grokLocal],
    ["pi_local", piLocal],
    ["hermes_local", hermesLocal],
  ] as Array<[string, ServerAdapterModule]>)(
    "executes the shared local-agent path for %s",
    async (adapterType, adapter) => {
      const run = vi.fn(async (options: RunProcessOptions) => {
        await options.onLog?.(
          "stdout",
          `${[
            JSON.stringify({
              type: "assistant",
              session_id: "shared-session",
              content: [
                { type: "thinking", text: "thinking" },
                { type: "text", text: "answer" },
                { type: "tool_use", id: "tool-1", name: "shell", input: { command: "pwd" } },
              ],
              usage: { input_tokens: 4, output_tokens: 6, cached_input_tokens: 2 },
            }),
            JSON.stringify({ type: "tool_result", name: "shell", output: "ok" }),
            JSON.stringify({ type: "tool_call", name: "shell", input: { command: "pwd" } }),
            JSON.stringify({ type: "result", result: "done" }),
            JSON.stringify({ type: "assistant", content: {} }),
            JSON.stringify({ type: "assistant", content: [null] }),
            JSON.stringify({ type: "unknown", summary: "summary fallback" }),
            JSON.stringify({ type: "unknown" }),
            "not-json",
            JSON.stringify(42),
          ].join("\n")}\n`,
        );
        await options.onLog?.("stdout", "\npartial-json");
        await options.onLog?.("stderr", "warning\n");
        return processResult();
      });
      const result = await adapter.execute({
        ...context(run),
        agent: { ...context(run).agent, adapterType: adapterType as never },
        config: {
          command: process.execPath,
          model: "test-model",
          mode: "persistent",
          extraArgs: ["--extra"],
          env: { TEST_ADAPTER_ENV: "ok", BAD_ENV_VALUE: 1 as never },
        },
        runtime: { sessionId: "previous-session" },
      });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          cwd: "C:\\work",
          stdin: adapterType === "pi_local" || adapterType === "hermes_local" ? undefined : "hello",
        }),
      );
      expect(result).toMatchObject({
        exitCode: 0,
        sessionId: "shared-session",
        usage: { inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 },
      });
      expect(result.summary).toBe("ok");
    },
  );

  it("covers local-agent failure fallback and environment probe", async () => {
    const run = vi.fn(async () => ({ ...processResult(), exitCode: 1, stderr: "failed" }));
    const result = await cursorLocal.execute({
      ...context(run),
      config: { command: process.execPath, timeoutSec: 2, graceSec: 1 },
    });
    expect(result).toMatchObject({
      exitCode: 1,
      errorFamily: "transient_upstream",
      summary: "failed",
    });

    const stdoutRun = vi.fn(async () => ({
      ...processResult(),
      stdout: JSON.stringify({ type: "assistant", sessionId: "stdout-session", text: "fallback" }),
    }));
    await expect(
      cursorLocal.execute({
        ...context(stdoutRun),
        config: { command: process.execPath },
      }),
    ).resolves.toMatchObject({ sessionId: "stdout-session", summary: "fallback" });

    await expect(
      cursorLocal.testEnvironment({
        config: { command: process.execPath },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ ok: true, checks: [{ name: "cli", level: "info" }] });

    await expect(
      cursorLocal.testEnvironment({
        config: { command: "aaspai-command-that-does-not-exist" },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ ok: false, checks: [{ name: "cli", level: "error" }] });
  });
});
