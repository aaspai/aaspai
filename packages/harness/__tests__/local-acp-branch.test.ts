import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { describe, expect, it, vi } from "vitest";

const acpMocks = vi.hoisted(() => ({
  cancelAcpSession: vi.fn(async (sessionId: string) => ({
    cancelled: false,
    sessionId,
    finalStatus: "already_finished",
  })),
  executeAcp: vi.fn(async () => ({ exitCode: 0, summary: "acp" })),
  resolveAcpEngine: vi.fn(async () => ({ engine: "acp", explicit: true })),
  testAcpEnvironment: vi.fn(async () => ({ ok: true, checks: [{ name: "acp", level: "info" }] })),
}));

vi.mock("../src/shared/acp.js", () => acpMocks);

import {
  claudeLocal,
  execute as executeClaude,
  testEnvironment as testClaudeEnvironment,
} from "../src/drivers/claude-local/execute.js";
import {
  codexLocal,
  execute as executeCodex,
  testEnvironment as testCodexEnvironment,
} from "../src/drivers/codex-local/execute.js";
import { createLocalAgentAdapter, standardLocalArgs } from "../src/shared/local-agent.js";

function context(
  adapterType: "claude_local" | "codex_local",
  config: JsonObject,
): AdapterExecutionContext {
  return {
    protocolVersion: 1,
    runId: "run_acp_branch",
    organizationId: "org_acp_branch",
    agent: {
      id: "agent_acp_branch",
      organizationId: "org_acp_branch",
      name: "ACP",
      adapterType,
      adapterConfig: {},
    },
    runtime: {},
    config,
    context: { cwd: process.cwd(), prompt: "hello" },
    onLog: vi.fn(async () => {}),
  };
}

describe("local adapters ACP branch", () => {
  it("routes Claude and Codex execution to shared ACP", async () => {
    await expect(executeClaude(context("claude_local", { engine: "acp" }))).resolves.toMatchObject({
      exitCode: 0,
      summary: "acp",
    });
    await expect(executeCodex(context("codex_local", { engine: "acp" }))).resolves.toMatchObject({
      exitCode: 0,
      summary: "acp",
    });
    expect(acpMocks.executeAcp).toHaveBeenCalledWith(
      expect.anything(),
      "claude",
      expect.anything(),
    );
    expect(acpMocks.executeAcp).toHaveBeenCalledWith(expect.anything(), "codex", expect.anything());
  });

  it("routes ACP environment probes and exposes cancel delegates", async () => {
    await expect(
      testClaudeEnvironment({ config: { engine: "acp" }, cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true, checks: [{ name: "acp" }] });
    await expect(
      testCodexEnvironment({ config: { engine: "acp" }, cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true, checks: [{ name: "acp" }] });
    await expect(claudeLocal.cancel?.({ sessionId: "claude-session" })).resolves.toMatchObject({
      cancelled: false,
    });
    await expect(codexLocal.cancel?.({ sessionId: "codex-session" })).resolves.toMatchObject({
      cancelled: false,
    });
  });

  it("exhausts local-agent parsing, fallback output, command construction, and environment results", async () => {
    const adapter = createLocalAgentAdapter({
      info: {
        type: "dry_run_local",
        label: "Test",
        transport: "local_subprocess",
        models: [],
        status: "ready",
        agentConfigurationDoc: "",
      },
      command: process.execPath,
      promptMode: "argument",
      promptFlag: "--prompt",
      resumeFlag: "--resume",
      buildArgs: (config, ctx) =>
        standardLocalArgs(config, ctx, {
          outputFormat: "--json",
          modelFlag: "--model",
          modeFlag: "--mode",
          resumeFlag: "--resume",
          yoloFlag: "--yolo",
        }),
    });
    const lines = `${[
      JSON.stringify({
        type: "message",
        session_id: "session",
        usage: { input_tokens: 2, outputTokens: 3, cache_read_input_tokens: 1 },
        content: [
          null,
          { type: "thinking", thinking: "thought" },
          { type: "tool_call", title: "run", arguments: { command: "pwd" } },
          { kind: "text", content: "answer" },
        ],
      }),
      JSON.stringify({ type: "tool_result", name: "run", content: "ok", isError: true }),
      JSON.stringify({ type: "result", error: "failed" }),
      JSON.stringify({ type: "unknown", message: { content: [] } }),
      "not-json",
    ].join("\n")}\n`;
    const logs: string[] = [];
    const run = async (options: {
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
    }) => {
      await options.onLog?.("stdout", lines);
      await options.onLog?.("stderr", "warning");
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
    };
    const result = await adapter.execute({
      ...context("claude_local", {
        command: process.execPath,
        model: "model",
        mode: "interactive",
        extraArgs: ["--trust", 4],
        env: { TEST_ENV: "yes", BAD: 4 },
        cwd: " /work ",
      }),
      runtime: { sessionId: "resume" },
      context: { cwd: process.cwd(), prompt: "hello" },
      execution: { run },
      onLog: async (stream: "stdout" | "stderr", chunk: string) => logs.push(`${stream}:${chunk}`),
    } as never);
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "session",
      usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 },
    });
    expect(logs.some((line) => line.startsWith("stderr:"))).toBe(true);

    const fallback = await adapter.execute({
      ...context("claude_local", {}),
      context: { cwd: process.cwd(), prompt: "hello" },
      execution: {
        run: async () => ({
          exitCode: 1,
          signal: "SIGTERM",
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(fallback).toMatchObject({
      exitCode: 1,
      summary: "failed",
      errorMessage: "Agent process failed",
    });
    const buffered = await adapter.execute({
      ...context("claude_local", {}),
      context: { cwd: process.cwd(), prompt: "hello" },
      execution: {
        run: async () => ({
          exitCode: 0,
          signal: undefined,
          timedOut: false,
          stdout: JSON.stringify({ result: "buffered" }),
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(buffered.summary).toBe("buffered");
    await expect(
      adapter.testEnvironment({ config: { command: process.execPath }, cwd: process.cwd() }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      adapter.testEnvironment({ config: { command: "missing-test-local" }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ level: "error", message: expect.stringContaining("unavailable") }],
    });
  });
});
