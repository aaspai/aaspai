import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import { describe, expect, it, vi } from "vitest";
import * as codexConfig from "../src/drivers/codex-local/config";
import {
  codexSandboxProbeArgs,
  execute,
  testEnvironment,
} from "../src/drivers/codex-local/execute";
import { fakeOpencodeCli } from "./e2e/helpers.js";

function context(
  run: NonNullable<AdapterExecutionContext["execution"]>["run"],
  config: AdapterExecutionContext["config"] = {},
  runtime: AdapterExecutionContext["runtime"] = {},
): AdapterExecutionContext {
  return {
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    runId: "run_codex_test",
    organizationId: "org_test",
    agent: {
      id: "agent_codex",
      organizationId: "org_test",
      name: "Codex",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime,
    config,
    context: { cwd: "/workspace", prompt: "test" },
    execution: { run },
    onLog: () => undefined,
  };
}

describe("codex_local runtime execution", () => {
  it("frames split JSONL events and forwards the configured grace period", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      async (options) => {
        await options.onLog?.("stdout", '{"type":"item.completed","item":');
        await options.onLog?.("stdout", '{"type":"agent_message","text":"split"}}\n');
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

    const result = await execute(context(runtimeRun, { outputInactivityTimeoutMs: 1_000 }));

    expect(runtimeRun.mock.calls[0]?.[0].graceMs).toBe(15_000);
    expect(result.summary).toBe("split");
  });

  it("turns an output-inactivity abort into a timed-out result", async () => {
    const runtimeRun = vi.fn<NonNullable<AdapterExecutionContext["execution"]>["run"]>(
      (options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => {
            const now = new Date().toISOString();
            resolve({
              exitCode: null,
              signal: "SIGTERM",
              timedOut: false,
              stdout: "",
              stderr: "",
              startedAt: now,
              finishedAt: now,
              durationMs: 1,
            });
          });
        }),
    );

    const result = await execute(context(runtimeRun, { outputInactivityTimeoutMs: 10 }));

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("No Codex output");
  });

  it("builds fresh and resumed CLI commands and scrubs the host API key", async () => {
    const outputs = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 8, output_tokens: 5, cached_input_tokens: 1 },
      }),
    ].join("\n")}\n`;
    let observed!: NonNullable<AdapterExecutionContext["execution"]>["run"] extends (
      input: infer I,
    ) => unknown
      ? I
      : never;
    const run = vi.fn(async (options: typeof observed) => {
      observed = options;
      await options.onLog?.("stdout", `\n${outputs}`);
      const now = new Date().toISOString();
      return {
        exitCode: 0,
        timedOut: false,
        stdout: `${outputs}not-json\n`,
        stderr: "",
        startedAt: now,
        finishedAt: now,
        durationMs: 1,
      };
    });
    const result = await execute(
      context(run, {
        engine: "cli",
        command: "codex-test",
        model: "gpt-test",
        modelReasoningEffort: "high",
        sandbox: "read-only",
        approvalMode: "on-request",
        extraArgs: ["--extra"],
      }),
    );
    expect(observed.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-test",
        "-c",
        "model_reasoning_effort=high",
        "-c",
        'approval_policy="on-request"',
        "--extra",
      ]),
    );
    expect(observed.env?.OPENAI_API_KEY).toBe("");
    expect(result).toMatchObject({
      exitCode: 0,
      summary: "answer",
      sessionId: "thread-1",
      usage: { inputTokens: 8, outputTokens: 5, cachedInputTokens: 1 },
    });

    const resumed = await execute(
      context(run, { engine: "cli", sandbox: "workspace-write" } as never, {
        sessionId: "previous",
      }),
    );
    expect(run.mock.calls.at(-1)?.[0].args).toEqual(
      expect.arrayContaining([
        "exec",
        "resume",
        "previous",
        "--json",
        "-c",
        'sandbox_mode="workspace-write"',
      ]),
    );
    expect(resumed.exitCode).toBe(0);
  });

  it("handles config, buffered output, timeout, and classified failures", async () => {
    await expect(execute(context(vi.fn(), { extraArgs: [1] }))).resolves.toMatchObject({
      exitCode: 1,
      errorFamily: "config",
    });
    const parseConfig = vi.spyOn(codexConfig, "parseCodexLocalConfig").mockImplementation(() => {
      throw "plain config failure";
    });
    try {
      await expect(execute(context(vi.fn(), {}))).resolves.toMatchObject({
        errorMessage: "Invalid codex_local config: plain config failure",
      });
      await expect(testEnvironment({ config: {}, cwd: process.cwd() })).resolves.toMatchObject({
        checks: [{ name: "config", message: "plain config failure" }],
      });
    } finally {
      parseConfig.mockRestore();
    }
    const buffered = await execute(
      context(
        async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "buffered" },
          }),
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli" },
      ),
    );
    expect(buffered.summary).toBe("buffered");
    const timeout = await execute(
      context(
        async () => ({
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli" },
      ),
    );
    expect(timeout).toMatchObject({ timedOut: true, errorMessage: "Run exceeded timeout" });

    for (const [stderr, family] of [
      ["rate limit", "provider_quota"],
      ["unauthorized", "auth"],
      ["policy refusal", "model_refusal"],
      ["ordinary", "internal"],
    ] as const) {
      const result = await execute(
        context(
          async (options) => {
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
          { engine: "cli" },
        ),
      );
      expect(result).toMatchObject({ exitCode: 2, errorFamily: family, errorMessage: stderr });
    }
  });

  it("covers sandbox probes, environment failure, and cancellation status", async () => {
    expect(codexSandboxProbeArgs("read-only", "linux")).toBeNull();
    expect(codexSandboxProbeArgs("workspace-write", "win32")).toEqual([
      "sandbox",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      "cmd.exe",
      "/d",
      "/c",
      "exit",
      "0",
    ]);
    await expect(
      testEnvironment({ config: { engine: "cli", command: process.execPath }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [
        { name: "codex_cli", level: "info" },
        { name: "codex_auth", level: "error" },
      ],
    });
    await expect(
      testEnvironment({ config: { extraArgs: [1] }, cwd: process.cwd() }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "config", level: "error" }],
    });
    const missing = await execute(
      context(
        async () => ({
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "missing",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli", command: "missing-codex" },
      ),
    );
    expect(missing.exitCode).not.toBe(0);
    const noSignalExit = await execute(
      context(
        async () => ({
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: "connection lost",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli" },
      ),
    );
    expect(noSignalExit.errorFamily).toBe("transient_upstream");
    await expect(
      (await import("../src/drivers/codex-local/execute")).codexLocal.cancel?.({
        sessionId: "no-session",
      }),
    ).resolves.toMatchObject({ cancelled: false, finalStatus: "already_finished" });
    await expect(
      testEnvironment({
        config: { engine: "cli", command: "missing-codex", sandbox: "read-only" },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ ok: false, checks: [{ name: "codex_cli", level: "error" }] });
    await expect(
      testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli(), sandbox: "read-only" },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({ ok: true });
    process.env.AASPAI_FAKE_OPENCODE_AUTH_EMPTY = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli() },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        { name: "codex_auth", level: "info", message: "codex authenticated" },
      ]),
    });
    process.env.AASPAI_FAKE_OPENCODE_AUTH_FAIL_EMPTY = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli() },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: expect.arrayContaining([
        { name: "codex_auth", level: "error", message: "codex is not authenticated" },
      ]),
    });
    process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL = "1";
    await expect(
      testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli() },
        cwd: process.cwd(),
      }),
    ).resolves.toMatchObject({
      checks: [
        { name: "codex_cli", level: "error", message: expect.stringContaining("binary missing") },
      ],
    });
    delete process.env.AASPAI_FAKE_OPENCODE_AUTH_EMPTY;
    delete process.env.AASPAI_FAKE_OPENCODE_AUTH_FAIL_EMPTY;
    delete process.env.AASPAI_FAKE_OPENCODE_VERSION_FAIL;
    await expect(testEnvironment({ config: null, cwd: process.cwd() })).resolves.toBeTruthy();
    const fallbackEnvironment = await testEnvironment({
      config: { engine: "auto", command: fakeOpencodeCli(), extraArgs: ["--unsupported"] },
      cwd: process.cwd(),
    });
    expect(fallbackEnvironment.checks.some((check) => check.name === "acp_fallback")).toBe(true);
  });

  it("covers an already-aborted caller and buffered metadata fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = JSON.stringify({ type: "thread.started", thread_id: "buffered-thread" });
    const result = await execute({
      ...context(
        async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: output,
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli" },
      ),
      signal: controller.signal,
    });
    expect(result.sessionId).toBe("buffered-thread");

    const metadataOnly = await execute({
      ...context(
        async (options) => {
          await options.onLog?.("stdout", "partial");
          return {
            exitCode: 0,
            timedOut: false,
            stdout: `\n${JSON.stringify({ type: "thread.started", thread_id: "metadata-thread" })}`,
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
        { engine: "cli" },
      ),
    });
    expect(metadataOnly.sessionId).toBe("metadata-thread");
  });

  it("covers provided API keys, alternate session metadata, and Windows sandbox probes", async () => {
    const observed: { env?: Record<string, string> } = {};
    const result = await execute(
      context(
        async (options) => {
          observed.env = options.env;
          return {
            exitCode: 0,
            timedOut: false,
            stdout: JSON.stringify({ type: "session.started", session_id: "session-only" }),
            stderr: "",
            startedAt: "",
            finishedAt: "",
            durationMs: 1,
          };
        },
        { engine: "cli", env: { OPENAI_API_KEY: "configured" } },
      ),
    );
    expect(observed.env?.OPENAI_API_KEY).toBe("configured");
    expect(result.sessionId).toBe("session-only");

    const originalPlatform = process.platform;
    const originalSandboxFailure = process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL;
    try {
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      const sandboxReady = await testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli(), sandbox: "read-only" },
        cwd: process.cwd(),
      });
      expect(sandboxReady.ok).toBe(true);
      expect(sandboxReady.checks).toContainEqual(
        expect.objectContaining({ name: "codex_sandbox", level: "info" }),
      );
      process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL = "1";
      const sandboxFailed = await testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli(), sandbox: "read-only" },
        cwd: process.cwd(),
      });
      expect(sandboxFailed.ok).toBe(false);
      expect(sandboxFailed.checks).toContainEqual(
        expect.objectContaining({ name: "codex_sandbox", level: "error" }),
      );
    } finally {
      if (originalSandboxFailure === undefined)
        delete process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL;
      else process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL = originalSandboxFailure;
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }

    const native = await execute({
      ...context(undefined as never, { engine: "cli", command: fakeOpencodeCli() }),
      context: { cwd: process.cwd(), prompt: "native" },
    });
    expect(native.exitCode).toBe(0);

    const emptySandbox = process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL_EMPTY;
    process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL = "1";
    process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL_EMPTY = "1";
    try {
      const result = await testEnvironment({
        config: { engine: "cli", command: fakeOpencodeCli(), sandbox: "read-only" },
        cwd: process.cwd(),
      });
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "codex_sandbox",
          message: expect.stringContaining("unknown error"),
        }),
      );
    } finally {
      if (emptySandbox === undefined) delete process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL_EMPTY;
      else process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL_EMPTY = emptySandbox;
      delete process.env.AASPAI_FAKE_OPENCODE_SANDBOX_FAIL;
    }
  });

  it("covers metadata and usage fallbacks", async () => {
    const metadata = await execute(
      context(
        async () => ({
          exitCode: 0,
          timedOut: false,
          stdout: `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } })}`,
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli", model: "gpt-test" },
      ),
    );
    expect(metadata).toMatchObject({ model: "gpt-test", usage: undefined });

    const failedWithUsage = await execute(
      context(
        async () => ({
          exitCode: 2,
          timedOut: false,
          stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
          stderr: "failed",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli", model: "gpt-test" },
      ),
    );
    expect(failedWithUsage.usage).toMatchObject({ inputTokens: 1 });

    const timeoutWithUsage = await execute(
      context(
        async () => ({
          exitCode: null,
          timedOut: true,
          stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
          stderr: "",
          startedAt: "",
          finishedAt: "",
          durationMs: 1,
        }),
        { engine: "cli", model: "gpt-test" },
      ),
    );
    expect(timeoutWithUsage.usage).toMatchObject({ inputTokens: 1 });
  });
});
