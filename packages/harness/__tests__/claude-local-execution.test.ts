import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { RunProcessOptions } from "@aaspai/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import * as claudeConfig from "../src/drivers/claude-local/config";
import { execute, testEnvironment } from "../src/drivers/claude-local/execute";
import { FAKE_OPENCODE_CMD } from "./e2e/helpers.js";

describe("claude_local runtime execution", () => {
  it("frames JSON events split across runtime log chunks", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.("stdout", '{"type":"assistant","message":{"content":[');
        await options.onLog?.("stdout", '{"type":"text","text":"split"}]}}\n');
        const now = new Date().toISOString();
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
        };
      },
    );
    const result = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_split",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/workspace", prompt: "test" },
      execution: { run: runtimeRun },
      onLog: () => undefined,
    });

    expect(result.summary).toBe("split");
  });

  it("uses the managed runtime process boundary when provided", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.(
          "stdout",
          `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "managed" }] } })}\n`,
        );
        const now = new Date().toISOString();
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          runtimeIdentity: { kind: "docker", cwd: "/workspace", containerId: "container-1" },
        };
      },
    );
    const result = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_managed",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: { command: "must-not-run-on-worker-host" },
      context: { cwd: "/workspace", prompt: "test" },
      execution: {
        identity: { kind: "docker", cwd: "/workspace" },
        run: runtimeRun,
      },
      onLog: () => undefined,
    });

    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(runtimeRun.mock.calls[0]?.[0]).toMatchObject({
      command: "must-not-run-on-worker-host",
      cwd: "/workspace",
      stdin: "test",
    });
    expect(result.exitCode).toBe(0);
  });

  it("builds the full CLI command, parses metadata, and reports fallback", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const output = `${[
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session",
        model: "claude-test",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer" }] },
      }),
      JSON.stringify({
        type: "result",
        usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 },
      }),
    ].join("\n")}\n`;
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        calls.push(...options.args);
        await options.onLog?.("stdout", `\n${output}`);
        await options.onLog?.("stderr", "warning from /home/tester/.cache\n");
        const now = new Date().toISOString();
        return {
          exitCode: 0,
          timedOut: false,
          stdout: `${output}not-json\n`,
          stderr: "",
          startedAt: now,
          finishedAt: now,
          durationMs: 1,
        };
      },
    );
    const result = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_full",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: "previous" },
      config: {
        engine: "auto",
        command: "claude-test",
        model: "opus",
        effort: "high",
        maxTurns: 4,
        chrome: true,
        tools: ["Read", "Write"],
        extraArgs: ["--extra"],
        dangerouslySkipPermissions: true,
      },
      context: { cwd: "/workspace", prompt: "test" },
      execution: { run: runtimeRun },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => void logs.push(chunk),
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypass-permissions",
        "--dangerously-skip-permissions",
        "--model",
        "opus",
        "--effort",
        "high",
        "--max-turns",
        "4",
        "--chrome",
        "--tools",
        "Read,Write",
        "--resume",
        "previous",
        "--extra",
      ]),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      summary: "answer",
      sessionId: "claude-session",
      model: "opus",
      usage: { inputTokens: 9, outputTokens: 4, cachedInputTokens: 2 },
    });
    expect(logs.some((line) => line.includes("ACP unavailable"))).toBe(true);
    expect(logs.some((line) => line.includes("warning from"))).toBe(true);
  });

  it("handles invalid config, buffered stdout, timeout, and provider error families", async () => {
    const base = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_errors",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      context: { cwd: "/workspace", prompt: "test" },
      onLog: async () => {},
    } as const;
    await expect(execute({ ...base, config: { extraArgs: [1] } } as never)).resolves.toMatchObject({
      errorFamily: "config",
      exitCode: 1,
    });
    const parseConfig = vi.spyOn(claudeConfig, "parseClaudeLocalConfig").mockImplementation(() => {
      throw "plain config failure";
    });
    try {
      await expect(execute({ ...base, config: {} } as never)).resolves.toMatchObject({
        errorMessage: "Invalid claude_local config: plain config failure",
      });
      await expect(testEnvironment({ config: {}, cwd: process.cwd() })).resolves.toMatchObject({
        checks: [{ name: "config", message: "plain config failure" }],
      });
    } finally {
      parseConfig.mockRestore();
    }

    const buffered = await execute({
      ...base,
      config: { engine: "cli" },
      execution: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "buffered" }] },
          }),
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(buffered.summary).toBe("buffered");

    const timeout = await execute({
      ...base,
      config: { engine: "cli" },
      execution: {
        run: async () => ({
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(timeout).toMatchObject({ timedOut: true, errorMessage: "Run exceeded timeout" });

    for (const [stderr, family] of [
      ["rate limit", "provider_quota"],
      ["unauthorized api key", "auth"],
      ["policy refused", "model_refusal"],
      ["ordinary failure", "internal"],
    ] as const) {
      await expect(
        execute({
          ...base,
          config: { engine: "cli" },
          execution: {
            run: async (
              options: NonNullable<AdapterExecutionContext["execution"]>["run"] extends (
                input: infer I,
              ) => unknown
                ? I
                : never,
            ) => {
              await options.onLog?.("stderr", stderr);
              return {
                exitCode: 2,
                timedOut: false,
                stdout: "",
                stderr,
                startedAt: "",
                finishedAt: "",
                durationMs: 1,
              };
            },
          },
        } as never),
      ).resolves.toMatchObject({ exitCode: 2, errorFamily: family, errorMessage: stderr });
    }
  });

  it("checks CLI installation/authentication and cancellation status", async () => {
    await expect(
      testEnvironment({ config: { engine: "cli", command: process.execPath }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [
        { name: "claude_cli", level: "info" },
        { name: "claude_auth", level: "error" },
      ],
    });
    await expect(
      testEnvironment({ config: { extraArgs: [1] }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "config", level: "error" }],
    });
    const missing = await execute({
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_cancel",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: { engine: "cli", command: "missing-claude" },
      context: { cwd: process.cwd(), prompt: "x" },
      onLog: async () => {},
    });
    expect(missing.exitCode).not.toBe(0);
    await expect(
      (await import("../src/drivers/claude-local/execute")).claudeLocal.cancel?.({
        sessionId: "no-session",
      }),
    ).resolves.toMatchObject({ cancelled: false, finalStatus: "already_finished" });
    await expect(
      testEnvironment({ config: { engine: "cli", command: "missing-claude" }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "claude_cli", level: "error" }],
    });
    await expect(
      testEnvironment({
        config: { engine: "cli", command: FAKE_OPENCODE_CMD },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ ok: true });
    process.env.AASPAI_FAKE_OPENCODE_AUTH_EMPTY = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: FAKE_OPENCODE_CMD },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        { name: "claude_auth", level: "info", message: "claude authenticated" },
      ]),
    });
    process.env.AASPAI_FAKE_OPENCODE_AUTH_FAIL_EMPTY = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: FAKE_OPENCODE_CMD },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        { name: "claude_auth", level: "error", message: "claude is not authenticated" },
      ]),
    });
    process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: FAKE_OPENCODE_CMD },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: [
        { name: "claude_cli", level: "error", message: expect.stringContaining("binary missing") },
      ],
    });
    delete process.env.AASPAI_FAKE_OPENCODE_AUTH_EMPTY;
    delete process.env.AASPAI_FAKE_OPENCODE_AUTH_FAIL_EMPTY;
    delete process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL;
    await expect(testEnvironment({ config: null, cwd: process.cwd() })).resolves.toBeTruthy();
    const fallbackEnvironment = await testEnvironment({
      config: { engine: "auto", command: FAKE_OPENCODE_CMD, extraArgs: ["--unsupported"] },
      cwd: process.cwd(),
    });
    expect(fallbackEnvironment.checks.some((check) => check.name === "acp_fallback")).toBe(true);
  });

  it("covers model metadata, buffered flush, and killed-process classification", async () => {
    const base = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_claude_edges",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      config: { engine: "cli" },
      context: { cwd: "/workspace", prompt: "test" },
      onLog: async () => {},
    } as const;
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "meta",
      message: "claude-meta",
    });
    const flushed = await execute({
      ...base,
      execution: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: `${init}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "edge" }] } })}`,
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(flushed).toMatchObject({ sessionId: "meta", model: "claude-meta", summary: "edge" });

    const killed = await execute({
      ...base,
      execution: {
        run: async () => ({
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(killed.errorFamily).toBe("transient_upstream");

    const metadataOnly = await execute({
      ...base,
      execution: {
        run: async (options: RunProcessOptions) => {
          await options.onLog?.("stdout", "partial");
          return {
            exitCode: 0,
            timedOut: false,
            stdout: `\n${JSON.stringify({ type: "system", subtype: "init", session_id: "metadata-only", message: "model-only" })}`,
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
      },
    } as never);
    expect(metadataOnly.sessionId).toBe("metadata-only");
  });

  it("covers permission false branches, empty success, and partial metadata", async () => {
    const base = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_claude_partial",
      organizationId: "org_test",
      agent: {
        id: "agent_claude",
        organizationId: "org_test",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {},
      context: { cwd: "/workspace", prompt: "test" },
      onLog: async () => {},
    } as const;
    let args: string[] = [];
    await expect(
      execute({
        ...base,
        config: { engine: "cli", permissionMode: "default", dangerouslySkipPermissions: true },
        execution: {
          run: async (options: RunProcessOptions) => {
            args = options.args;
            return {
              exitCode: 0,
              timedOut: false,
              stdout: "",
              stderr: "",
              startedAt: "",
              finishedAt: "",
              durationMs: 1,
            };
          },
        },
      } as never),
    ).resolves.toMatchObject({ exitCode: 0, clearSession: true, summary: undefined });
    expect(args).not.toContain("--dangerously-skip-permissions");

    const partial = await execute({
      ...base,
      config: { engine: "cli" },
      execution: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({ type: "result", usage: { input_tokens: 2 } }),
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(partial.usage).toMatchObject({ inputTokens: 2 });

    const metadata = await execute({
      ...base,
      config: { engine: "cli", model: "opus" },
      execution: {
        run: async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "result", usage: { output_tokens: 1 } })}`,
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(metadata).toMatchObject({ model: "opus", usage: { outputTokens: 1 } });

    const failedWithUsage = await execute({
      ...base,
      config: { engine: "cli", model: "opus" },
      execution: {
        run: async () => ({
          exitCode: 2,
          timedOut: false,
          stdout: JSON.stringify({ type: "result", usage: { input_tokens: 1 } }),
          stderr: "failed",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(failedWithUsage.usage).toMatchObject({ inputTokens: 1 });

    const timedOutWithOutput = await execute({
      ...base,
      config: { engine: "cli", model: "opus" },
      execution: {
        run: async () => ({
          exitCode: null,
          timedOut: true,
          stdout: `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })}\n${JSON.stringify({ type: "result", usage: { input_tokens: 1 } })}`,
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
      },
    } as never);
    expect(timedOutWithOutput).toMatchObject({
      summary: "partial",
      usage: { inputTokens: 1 },
      biller: "claude-code",
    });
  });
});
