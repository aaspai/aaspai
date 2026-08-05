import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, getAdapter, getAdapterCapabilities } from "../src/registry.js";
import { buildAgentEnv } from "../src/shared/env.js";
import { createLocalAgentAdapter, standardLocalArgs } from "../src/shared/local-agent.js";
import { acpSessionCodec, localSessionCodec } from "../src/shared/session-codec.js";
import { fakeOpencodeCli } from "./e2e/helpers.js";

const agent = {
  id: "agent/gaps",
  organizationId: "org/gaps",
  name: "Coverage Gaps",
  adapterType: "cursor_local" as const,
};

describe("coverage foundation edges", () => {
  it("covers registry readiness, async descriptions, and unknown adapters", async () => {
    const notReady = {
      info: {
        type: "cursor_local",
        label: "Cursor",
        transport: "local_subprocess",
        models: [],
        agentConfigurationDoc: "",
        status: "experimental",
      },
      execute: async () => ({ exitCode: 0 }),
      testEnvironment: async () => ({ ok: true, checks: [] }),
      describe: () => Promise.resolve({ supportsCancel: true, supportsResume: true }),
    } as unknown as ServerAdapterModule;
    expect(capabilitiesFor(notReady)).toMatchObject({ execute: false, billing: "unknown" });
    const asyncDescription = {
      ...notReady,
      info: { ...notReady.info, status: "ready" },
    } as unknown as ServerAdapterModule;
    expect(capabilitiesFor(asyncDescription)).toMatchObject({
      execute: true,
      cancellation: false,
      resume: false,
    });
    expect(getAdapterCapabilities("cursor_local")).toMatchObject({ execute: true });
    expect(() => getAdapter("not-an-adapter" as never)).toThrow("Unknown adapter type");
  });

  it("protects identity env and covers local argument construction", () => {
    expect(
      buildAgentEnv(agent, {
        runId: "run",
        sessionId: "session",
        sessionDisplayId: "display",
        cwd: "C:\\work",
        additionalEnv: { EXTRA: "yes", AASPAI_RUN_ID: "forged" },
      }),
    ).toMatchObject({
      AASPAI_RUN_ID: "run",
      AASPAI_SESSION_ID: "session",
      AASPAI_SESSION_DISPLAY_ID: "display",
      EXTRA: "yes",
    });

    const ctx = {
      runtime: { sessionId: "previous" },
    } as never;
    expect(
      standardLocalArgs({ extraArgs: ["--extra", 1], model: " model ", mode: "persistent" }, ctx, {
        outputFormat: "json",
        modelFlag: "--model",
        modeFlag: "--mode",
        resumeFlag: "--resume",
        yoloFlag: "--yolo",
      }),
    ).toEqual([
      "--extra",
      "json",
      "--model",
      "model",
      "--mode",
      "persistent",
      "--resume",
      "previous",
      "--yolo",
    ]);
    expect(
      standardLocalArgs({ extraArgs: ["--trust"] }, { runtime: {} } as never, {
        yoloFlag: "--yolo",
      }),
    ).toEqual(["--trust"]);
  });

  it("normalizes session records and rejects non-record state", () => {
    expect(localSessionCodec.serialize({ session_id: "s", cwd: " C:\\work " })).toEqual({
      sessionId: "s",
      cwd: "C:\\work",
    });
    expect(localSessionCodec.serialize({ session_id: "s", repoUrl: " " })).toEqual({
      sessionId: "s",
    });
    expect(localSessionCodec.deserialize(["bad"])).toBeNull();
    expect(acpSessionCodec.deserialize("bad")).toBeNull();
    expect(acpSessionCodec.serialize({ backendSessionId: "backend", extra: true })).toMatchObject({
      backendSessionId: "backend",
      sessionId: "backend",
    });
  });

  it("drives local-agent parsing, buffering, stderr, usage, and result fallbacks", async () => {
    const adapter = createLocalAgentAdapter({
      info: {
        type: "cursor_local",
        label: "Cursor",
        transport: "local_subprocess",
        models: [],
        agentConfigurationDoc: "",
        status: "ready",
      },
      command: "cursor",
      promptMode: "argument",
      promptFlag: "--prompt",
      resumeFlag: "--resume",
      buildArgs: () => ["--base"],
    });
    const base = {
      protocolVersion: 1 as const,
      runId: "run_local_agent",
      organizationId: "org/gaps",
      agent: { ...agent, adapterType: "cursor_local" as const },
      runtime: { sessionId: "previous", sessionDisplayId: "display" },
      context: { cwd: "C:\\work", prompt: "prompt" },
      onLog: async () => undefined,
    };
    const events = [
      { type: "assistant", content: "assistant" },
      {
        type: "assistant",
        content: [
          { type: "thinking", thinking: "thought" },
          { type: "tool_use", name: "Read", input: { path: "x" } },
          { type: "text", text: "text" },
          null,
        ],
      },
      { type: "tool_result", name: "Read", result: "ok", is_error: true },
      { type: "completed", result: "done", error: true },
      { type: "custom", content: [], summary: "summary" },
      { type: "custom", content: [] },
      42,
    ];
    const logs: string[] = [];
    const result = await adapter.execute({
      ...base,
      config: {
        cwd: " C:\\repo ",
        env: { EXTRA: "yes", BAD: 1 },
        timeoutSec: 1,
        graceSec: 1,
        model: "model",
      },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => logs.push(chunk),
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.("stderr", "warning");
          for (const event of events) await options.onLog?.("stdout", `${JSON.stringify(event)}\n`);
          return {
            exitCode: 0,
            signal: undefined,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(result).toMatchObject({ exitCode: 0, sessionId: undefined, model: "model" });
    expect(logs.some((line) => line.includes("thinking"))).toBe(true);
    expect(logs.some((line) => line.includes("tool_result"))).toBe(true);

    const fallback = await adapter.execute({
      ...base,
      runtime: {},
      config: { env: "bad", cwd: "", model: 2 },
      execution: {
        run: async () => ({
          exitCode: 1,
          signal: "SIGTERM",
          timedOut: true,
          stdout: "not-json\n",
          stderr: "failed",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(fallback).toMatchObject({
      exitCode: 1,
      timedOut: true,
      errorMessage: "failed",
      summary: "failed",
    });

    const fallbackEvents = [
      { type: "usage", usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 1 } },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, cache_read_input_tokens: 4 } },
      { type: "usage", usage: { input_tokens: -1, output_tokens: -1, cached_input_tokens: -1 } },
      {
        type: "assistant",
        content: [
          { type: "thinking" },
          { type: "thought", text: "thought" },
          { type: "tool_call", arguments: { ok: true } },
          { type: "plain", content: "plain" },
        ],
      },
      { type: "message", message: "message text" },
      { type: "final", output: "final text" },
      { type: "tool_complete", content: "done", is_error: false },
      { type: "custom", message: { content: "nested message" } },
      { type: "custom", result: "summary result" },
      { type: "custom", content: [] },
      { type: "custom", content: [{ type: "unknown" }] },
      "raw",
    ];
    const matrix = await adapter.execute({
      ...base,
      runtime: {},
      config: { command: "", model: "" },
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          for (const event of fallbackEvents)
            await options.onLog?.("stdout", `${JSON.stringify(event)}\n`);
          return {
            exitCode: 0,
            signal: undefined,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(matrix.exitCode).toBe(0);

    const emptyToolResult = await adapter.execute({
      ...base,
      runtime: {},
      config: null,
      execution: {
        run: async (options: {
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          await options.onLog?.(
            "stdout",
            `${JSON.stringify({ type: "tool_result", name: "empty" })}\n`,
          );
          return {
            exitCode: 0,
            signal: undefined,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(emptyToolResult.exitCode).toBe(0);

    const stdinAdapter = createLocalAgentAdapter({
      info: {
        type: "cursor_local",
        label: "Cursor",
        transport: "local_subprocess",
        models: [],
        agentConfigurationDoc: "",
        status: "ready",
      },
      command: "cursor",
      buildArgs: () => [],
    });
    const stdinResult = await stdinAdapter.execute({
      ...base,
      runtime: {},
      config: { env: { ONLY: "yes" }, model: "m" },
      execution: {
        run: async (options: {
          stdin?: string;
          onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
        }) => {
          expect(options.stdin).toBe("prompt");
          await options.onLog?.("stdout", "\n");
          return {
            exitCode: 0,
            signal: undefined,
            timedOut: false,
            stdout: "",
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(stdinResult.summary).toBe("completed");

    const noRunner = createLocalAgentAdapter({
      info: {
        type: "cursor_local",
        label: "Cursor",
        transport: "local_subprocess",
        models: [],
        agentConfigurationDoc: "",
        status: "ready",
      },
      command: process.execPath,
      buildArgs: () => [
        "-e",
        "process.stdout.write(JSON.stringify({type:'assistant',content:'native'}))",
      ],
    });
    await expect(
      noRunner.execute({
        ...base,
        runtime: {},
        context: { cwd: process.cwd(), prompt: "prompt" },
        config: { command: process.execPath },
      } as never),
    ).resolves.toMatchObject({ summary: "native" });
    await expect(
      noRunner.testEnvironment({ config: { command: process.execPath }, cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true });
    const envAdapter = createLocalAgentAdapter({
      info: {
        type: "cursor_local",
        label: "Cursor",
        transport: "local_subprocess",
        models: [],
        agentConfigurationDoc: "",
        status: "ready",
      },
      command: fakeOpencodeCli(),
      buildArgs: () => [],
    });
    process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL = "1";
    try {
      await expect(
        envAdapter.testEnvironment({ config: { command: " " }, cwd: process.cwd() }),
      ).resolves.toMatchObject({
        ok: false,
        checks: [{ message: expect.stringContaining("unavailable") }],
      });
    } finally {
      delete process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL;
    }
  });
});
