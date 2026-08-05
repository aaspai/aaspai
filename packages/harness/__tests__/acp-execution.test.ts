import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import { describe, expect, it, vi } from "vitest";

const acpxMocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(() => ({ doctor: async () => ({ ok: true, message: "ready" }) })),
  createAgentRegistry: vi.fn((input: unknown) => input),
  createRuntimeStore: vi.fn((input: unknown) => input),
}));

vi.mock("acpx/runtime", () => acpxMocks);

import {
  type AcpExecutorOptions,
  cancelAcpSession,
  executeAcp,
  nodeVersionMeetsAcpMinimum,
  parseAcpConfig,
  resolveAcpEngine,
  testAcpEnvironment,
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

  it("normalizes ACP versions, aliases, defaults, and engine requests", async () => {
    expect(nodeVersionMeetsAcpMinimum("claude", "not-a-version")).toBe(false);
    expect(nodeVersionMeetsAcpMinimum("claude", "v22.12.0")).toBe(true);
    expect(nodeVersionMeetsAcpMinimum("claude", "22.13.0")).toBe(true);
    expect(nodeVersionMeetsAcpMinimum("claude", "v22.12.1")).toBe(true);
    expect(nodeVersionMeetsAcpMinimum("codex", "v22.12.9")).toBe(false);

    expect(
      parseAcpConfig(
        "gemini",
        {
          acpMode: "oneshot",
          acpPermissionMode: "deny-all",
          acpNonInteractivePermissions: "fail",
          acpAgentCommand: " gemini --acp ",
          timeoutSec: "2.4",
          maxTurns: 3.9,
          warmHandleIdleMs: -2,
          modelReasoningEffort: "high",
          allowedTools: [" Read ", 2, ""],
        },
        { organizationId: "org", agentId: "agent" },
      ),
    ).toMatchObject({
      mode: "oneshot",
      permissionMode: "deny-all",
      nonInteractivePermissions: "fail",
      agentCommand: "gemini --acp",
      timeoutMs: 2400,
      maxTurns: 3,
      warmHandleIdleMs: 0,
      effort: "high",
      allowedTools: ["Read"],
    });
    expect(await resolveAcpEngine("claude", { config: { engine: "cli" } })).toEqual({
      engine: "cli",
      explicit: true,
    });
    expect(
      await resolveAcpEngine("claude", {
        config: { engine: "acp" },
        execution: {
          identity: { kind: "remote", host: "worker" },
          run: async () => {
            throw new Error("not used");
          },
        } as never,
      }),
    ).toMatchObject({ engine: "acp", explicit: true });
  });

  it.each([
    ["extraArgs", "claude", { extraArgs: ["--flag"] }],
    ["chrome", "claude", { chrome: true }],
    ["danger sandbox", "codex", { sandbox: "danger-full-access" }],
    ["fast mode", "gemini", { fastMode: true }],
  ])("falls back from unsupported ACP %s", async (_name, agent, config) => {
    const selection = await resolveAcpEngine(
      agent as "claude" | "codex" | "gemini",
      {
        config: { engine: "auto", agentCommand: "configured", ...config },
      },
      { nodeVersion: "v22.13.0" },
    );
    expect(selection).toMatchObject({ engine: "cli", explicit: false });
    expect(selection.fallbackReason).toMatch(/support|sandbox|fastMode/);
  });

  it("handles ACP prerequisite doctor results and failures", async () => {
    const doctorFailure = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", agentCommand: "configured" }, cwd: process.cwd() },
      {
        nodeVersion: "v22.13.0",
        createRuntime: (() => ({
          doctor: async () => ({ ok: false, message: "doctor failed" }),
        })) as never,
      },
    );
    expect(doctorFailure.fallbackReason).toBe("doctor failed");
    await expect(
      resolveAcpEngine(
        "claude",
        { config: { engine: "acp", agentCommand: "configured" }, cwd: process.cwd() },
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            doctor: async () => ({ ok: false, message: "explicit doctor failed" }),
          })) as never,
        },
      ),
    ).resolves.toEqual({ engine: "acp", explicit: true });

    const thrown = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", agentCommand: "configured" }, cwd: process.cwd() },
      {
        nodeVersion: "v22.13.0",
        createRuntime: (() => {
          throw new Error("doctor crashed");
        }) as never,
      },
    );
    expect(thrown.fallbackReason).toBe("doctor crashed");
    expect(
      await resolveAcpEngine("claude", {
        config: { engine: "auto" },
        execution: {
          identity: { kind: "remote", host: "worker" },
          run: async () => {
            throw new Error("unused");
          },
        } as never,
      }),
    ).toMatchObject({ engine: "cli", explicit: false });
    expect(
      await resolveAcpEngine("claude", {
        config: { engine: "auto" },
        execution: {
          identity: { kind: "local", cwd: process.cwd() },
          run: async () => {
            throw new Error("unused");
          },
        } as never,
      }),
    ).toMatchObject({ engine: "cli", explicit: false });
    expect(
      await resolveAcpEngine(
        "claude",
        {
          config: { engine: "auto", agentCommand: "configured", cwd: process.cwd() },
          execution: {
            identity: { kind: "local", cwd: process.cwd() },
            environment: { env: {} },
            run: async () => {
              throw new Error("unused");
            },
          } as never,
        },
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
        },
      ),
    ).toMatchObject({ engine: "acp" });
    expect(
      await resolveAcpEngine("claude", {
        config: { engine: "acp", agentCommand: "configured" },
        execution: {
          identity: { kind: "local", cwd: process.cwd() },
          run: async () => {
            throw new Error("unused");
          },
        } as never,
      }),
    ).toMatchObject({ engine: "acp", explicit: true });
    const stringThrown = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", agentCommand: "configured" }, cwd: process.cwd() },
      {
        nodeVersion: "v22.13.0",
        createRuntime: (() => {
          throw "string doctor failure";
        }) as never,
      },
    );
    expect(stringThrown.fallbackReason).toBe("string doctor failure");
  });

  it("covers ACP environment checks and terminal error families", async () => {
    const originalVersion = process.version;
    Object.defineProperty(process, "version", { configurable: true, value: "v22.13.0" });
    try {
      acpxMocks.createAcpRuntime.mockReturnValueOnce({
        doctor: async () => ({ ok: true, details: "ok" }),
      } as never);
      await expect(
        testAcpEnvironment("claude", { config: {}, cwd: process.cwd() }),
      ).resolves.toMatchObject({
        ok: true,
        checks: [
          { name: "acp_node", level: "info" },
          { name: "acp_runtime", level: "info", details: { details: "ok" } },
        ],
      });
      acpxMocks.createAcpRuntime.mockImplementationOnce(() => {
        throw new Error("runtime unavailable");
      });
      const failedEnvironment = await testAcpEnvironment("gemini", {
        config: {},
        cwd: process.cwd(),
      });
      expect(failedEnvironment.ok).toBe(false);
      expect(failedEnvironment.checks).toContainEqual(
        expect.objectContaining({ name: "acp_runtime", level: "error" }),
      );
      acpxMocks.createAcpRuntime.mockReturnValueOnce({ doctor: async () => undefined } as never);
      const noDoctor = await testAcpEnvironment("claude", { config: null });
      expect(
        noDoctor.checks.some(
          (check) =>
            check.name === "acp_runtime" && check.message === "claude ACP runtime is available",
        ),
      ).toBe(true);
      acpxMocks.createAcpRuntime.mockImplementationOnce(() => {
        throw "runtime string failure";
      });
      await expect(
        testAcpEnvironment("claude", { config: {}, cwd: process.cwd() }),
      ).resolves.toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "acp_runtime", message: "runtime string failure" }),
        ]),
      });
      const innerVersion = process.version;
      Object.defineProperty(process, "version", { configurable: true, value: "v20.0.0" });
      try {
        await expect(
          testAcpEnvironment("claude", { config: {}, cwd: process.cwd() }),
        ).resolves.toMatchObject({
          checks: expect.arrayContaining([
            expect.objectContaining({ name: "acp_node", level: "error" }),
          ]),
        });
      } finally {
        Object.defineProperty(process, "version", { configurable: true, value: innerVersion });
      }
      await expect(
        testAcpEnvironment("gemini", { config: { command: "custom-gemini" }, cwd: process.cwd() }),
      ).resolves.toBeTruthy();
      await expect(
        testAcpEnvironment("claude", { config: { cwd: process.cwd() } }),
      ).resolves.toBeTruthy();
      acpxMocks.createAcpRuntime.mockReturnValueOnce({
        doctor: async () => ({ ok: false, message: "doctor environment failed" }),
      } as never);
      await expect(
        testAcpEnvironment("claude", { config: {}, cwd: process.cwd() }),
      ).resolves.toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "acp_runtime",
            level: "error",
            message: "doctor environment failed",
          }),
        ]),
      });
    } finally {
      Object.defineProperty(process, "version", { configurable: true, value: originalVersion });
    }
  });

  it("covers ACP prerequisite, resume, abort, and cleanup edges", async () => {
    const unavailable = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto" }, cwd: process.cwd() },
      { nodeVersion: "v22.13.0" },
    );
    expect(unavailable).toMatchObject({ engine: "acp", explicit: false });
    await expect(
      resolveAcpEngine(
        "claude",
        { config: { engine: "auto", cwd: process.cwd() } },
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
        },
      ),
    ).resolves.toMatchObject({ engine: "acp" });
    await expect(
      resolveAcpEngine(
        "claude",
        {
          config: { engine: "acp", agentCommand: "configured", cwd: process.cwd() },
          cwd: undefined,
        },
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
        },
      ),
    ).resolves.toMatchObject({ engine: "acp" });
    await expect(
      resolveAcpEngine(
        "claude",
        { config: { engine: "auto", agentCommand: "configured" } },
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
        },
      ),
    ).resolves.toMatchObject({ engine: "acp" });

    const ready = await resolveAcpEngine(
      "claude",
      { config: { engine: "auto", agentCommand: "configured" }, cwd: process.cwd() },
      {
        nodeVersion: "v22.13.0",
        createRuntime: (() => ({ doctor: async () => ({ ok: true }) })) as never,
      },
    );
    expect(ready).toEqual({ engine: "acp", explicit: false });

    const noResumeDir = await mkdtemp(join(tmpdir(), "aaspai-acp-no-resume-"));
    await expect(
      executeAcp(
        { ...context(noResumeDir, async () => undefined), config: { engine: "acp" } },
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            ensureSession: async () => {
              throw new Error("session unavailable");
            },
            close: async () => undefined,
          })) as never,
        },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed" });

    const abortedDir = await mkdtemp(join(tmpdir(), "aaspai-acp-aborted-"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeAcp(
        {
          ...context(abortedDir, async () => undefined),
          config: { engine: "acp" },
          signal: controller.signal,
        },
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            ensureSession: async () => ({ sessionKey: "aborted" }),
            startTurn: () => ({
              events: (async function* () {})(),
              result: Promise.resolve({ status: "completed" as const }),
              cancel: async () => undefined,
            }),
            close: async () => undefined,
          })) as never,
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const cleanupDir = await mkdtemp(join(tmpdir(), "aaspai-acp-cleanup-"));
    await expect(
      executeAcp(
        { ...context(cleanupDir, async () => undefined), config: { engine: "acp", timeoutSec: 1 } },
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            ensureSession: async () => ({ sessionKey: "cleanup" }),
            getStatus: async () => undefined,
            startTurn: () => {
              throw new Error("turn failed");
            },
            close: async () => undefined,
          })) as never,
        },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed" });

    const sessionParamsList: JsonObject[] = [
      { cliSessionId: "cli", acp: false },
      { unknown: true },
    ];
    for (const sessionParams of sessionParamsList) {
      const stateDir = await mkdtemp(join(tmpdir(), "aaspai-acp-session-edge-"));
      const seen: Array<string | undefined> = [];
      const runtime = {
        ensureSession: async (input: { resumeSessionId?: string }) => {
          seen.push(input.resumeSessionId);
          return { sessionKey: "edge", backendSessionId: "edge-session" };
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const }),
          cancel: async () => undefined,
        }),
        close: async () => undefined,
      };
      await executeAcp(
        {
          ...context(stateDir, async () => undefined),
          runtime: { sessionId: "fallback", sessionParams },
          config: { engine: "acp" },
        },
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => runtime) as never,
        },
      );
      expect(seen).toEqual([undefined]);
    }
  });

  it("retries a missing resume session, applies fast mode, and reports cancellation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-harness-acp-retry-"));
    let ensureCalls = 0;
    const cancels: string[] = [];
    const options: string[] = [];
    const fakeRuntime = {
      ensureSession: async () => {
        ensureCalls += 1;
        if (ensureCalls === 1) throw new Error("missing session");
        return { sessionKey: "key", backendSessionId: "cancel-session", agentSessionId: "agent" };
      },
      setConfigOption: async ({ key }: { key: string }) => options.push(key),
      startTurn: () => ({
        events: (async function* () {
          yield { type: "text_delta" as const, text: "", stream: "thought" as const };
          yield { type: "status" as const, text: "working" };
          yield {
            type: "tool_call" as const,
            title: "shell",
            toolCallId: "t",
            status: "failed",
            rawInput: "bad",
            rawOutput: "/home/user/out",
          };
        })(),
        result: Promise.resolve({ status: "cancelled" as const }),
        cancel: async ({ reason }: { reason: string }) => cancels.push(reason),
      }),
      close: async () => undefined,
      getStatus: async () => undefined,
    };
    const logs: string[] = [];
    const result = await executeAcp(
      {
        ...context(stateDir, async (_stream, chunk) => void logs.push(chunk)),
        runtime: { sessionId: "old", sessionParams: { acp: true, agentSessionId: "old" } },
        config: { stateDir, engine: "acp", fastMode: true },
      },
      "codex",
      {},
      { createRuntime: (() => fakeRuntime) as never, nodeVersion: "v22.13.0" },
    );
    expect(result).toMatchObject({
      exitCode: 1,
      signal: "SIGTERM",
      clearSession: true,
      errorCode: "acp_turn_failed",
    });
    expect(options).toEqual(["service_tier", "features.fast_mode"]);
    expect(logs.some((line) => line.includes("starting a fresh session"))).toBe(true);
    expect(logs.some((line) => line.includes('"kind":"system"'))).toBe(true);
    expect(cancels).toEqual([]);
  });

  it("returns initialization errors and supports out-of-band cancellation", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-harness-acp-errors-"));
    await expect(
      executeAcp(
        context(stateDir, async () => undefined),
        "claude",
        {},
        {
          nodeVersion: "v20.0.0",
        },
      ),
    ).resolves.toMatchObject({
      errorCode: "acp_execution_failed",
      errorFamily: "transient_upstream",
    });
    await expect(
      executeAcp(
        context(stateDir, async () => undefined),
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => {
            throw new Error("init auth failed");
          }) as never,
        },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed", errorFamily: "auth" });

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeRuntime = {
      ensureSession: async () => ({ sessionKey: "key", backendSessionId: "active-session" }),
      startTurn: () => ({
        // biome-ignore lint/correctness/useYield: holds the event stream open until cancellation
        events: (async function* () {
          markStarted();
          await pending;
        })(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => {
          release();
        },
      }),
      cancel: async () => {
        release();
      },
      close: async () => undefined,
    };
    const execution = executeAcp(
      context(stateDir, async () => undefined),
      "claude",
      {},
      {
        createRuntime: (() => fakeRuntime) as never,
        nodeVersion: "v22.13.0",
      },
    );
    await started;
    await expect(cancelAcpSession("active-session")).resolves.toEqual({
      cancelled: true,
      sessionId: "active-session",
      finalStatus: "cancelled",
    });
    release();
    await execution;
    await expect(cancelAcpSession("missing-session")).resolves.toMatchObject({
      cancelled: false,
      finalStatus: "already_finished",
    });
  });

  it("classifies ACP provider failures and billing identities", async () => {
    for (const [message, family] of [
      ["API key invalid", "auth"],
      ["rate limit exceeded", "provider_quota"],
      ["permission refused", "model_refusal"],
    ] as const) {
      const runtime = {
        ensureSession: async () => ({ sessionKey: "key", backendSessionId: "failed-session" }),
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "failed" as const, error: { message } }),
          cancel: async () => undefined,
        }),
        close: async () => undefined,
      };
      await expect(
        executeAcp(
          context(await mkdtemp(join(tmpdir(), "aaspai-acp-fail-")), async () => undefined),
          "claude",
          {},
          {
            createRuntime: (() => runtime) as never,
            nodeVersion: "v22.13.0",
          },
        ),
      ).resolves.toMatchObject({ exitCode: 1, errorFamily: family, errorMessage: message });
    }

    const billingRuntime = {
      ensureSession: async () => ({ sessionKey: "key", backendSessionId: "billing-session" }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    const billing = await executeAcp(
      {
        ...context(await mkdtemp(join(tmpdir(), "aaspai-acp-billing-")), async () => undefined),
        config: { engine: "acp", env: { CLAUDE_CODE_USE_BEDROCK: "1" } },
      },
      "claude",
      {},
      { createRuntime: (() => billingRuntime) as never, nodeVersion: "v22.13.0" },
    );
    expect(billing).toMatchObject({
      provider: "anthropic",
      biller: "aws-bedrock",
      billingType: "metered_api",
    });
  });

  it("covers ACP timeout, initialization, policy, and runtime cleanup paths", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-acp-edge-"));
    await expect(
      executeAcp(
        context(stateDir, async () => undefined),
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => undefined) as never,
        },
      ),
    ).resolves.toMatchObject({
      errorCode: "acp_execution_failed",
      summary: "ACP initialization failed",
    });
    await expect(
      executeAcp(
        context(stateDir, async () => undefined),
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            ensureSession: async () => ({ sessionKey: "key" }),
            startTurn: () => {
              throw new Error("turn auth failed");
            },
            close: async () => undefined,
          })) as never,
        },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed", errorFamily: "auth" });
    await expect(
      executeAcp(
        {
          ...context(stateDir, async () => undefined),
          config: { engine: "acp", extraArgs: ["--bad"] },
        },
        "claude",
        {},
        { nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ summary: "ACP configuration unsupported" });
    await expect(
      executeAcp(
        { ...context(stateDir, async () => undefined), config: { engine: "acp", effort: "high" } },
        "claude",
        {},
        {
          nodeVersion: "v22.13.0",
          createRuntime: (() => ({
            ensureSession: async () => ({ sessionKey: "key" }),
            startTurn: () => ({
              events: (async function* () {})(),
              result: Promise.resolve({ status: "completed" as const }),
              cancel: async () => undefined,
            }),
            close: async () => undefined,
          })) as never,
        },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed" });

    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timeoutRuntime = {
      ensureSession: async () => ({ sessionKey: "key", backendSessionId: "timeout-session" }),
      startTurn: () => ({
        // biome-ignore lint/correctness/useYield: holds the event stream open until cancellation
        events: (async function* () {
          await wait;
        })(),
        result: Promise.resolve({ status: "cancelled" as const }),
        cancel: async () => release(),
      }),
      close: async () => undefined,
      getStatus: async () => {
        throw new Error("status unavailable");
      },
    };
    const timeout = executeAcp(
      { ...context(stateDir, async () => undefined), config: { engine: "acp", timeoutSec: 0.001 } },
      "claude",
      {},
      { createRuntime: (() => timeoutRuntime) as never, nodeVersion: "v22.13.0" },
    );
    await expect(timeout).resolves.toMatchObject({ timedOut: true, errorCode: "acp_timeout" });
    const rejectedAfterTimeout = executeAcp(
      { ...context(stateDir, async () => undefined), config: { engine: "acp", timeoutSec: 0.001 } },
      "claude",
      {},
      {
        createRuntime: (() => ({
          ensureSession: async () => ({
            sessionKey: "reject-after-timeout",
            backendSessionId: "reject-after-timeout",
          }),
          startTurn: () => ({
            events: (async function* () {})(),
            result: new Promise((_, reject) =>
              setTimeout(() => reject(new Error("late turn failure")), 20),
            ),
            cancel: async () => undefined,
          }),
          close: async () => undefined,
        })) as never,
        nodeVersion: "v22.13.0",
      },
    );
    await expect(rejectedAfterTimeout).resolves.toMatchObject({
      timedOut: true,
      errorCode: "acp_timeout",
    });
  });

  it("reuses and evicts warm ACP runtimes", async () => {
    const warm = new Map();
    let created = 0;
    let closed = 0;
    const runtime = {
      ensureSession: async () => ({ sessionKey: "key", backendSessionId: "warm-session" }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => {
        closed += 1;
      },
    };
    const make = () => {
      created += 1;
      return runtime;
    };
    const ctx = {
      ...context(await mkdtemp(join(tmpdir(), "aaspai-acp-warm-")), async () => undefined),
      config: { engine: "acp", mode: "persistent", warmHandleIdleMs: 10_000 },
    };
    await executeAcp(
      ctx,
      "claude",
      {},
      { createRuntime: make as never, nodeVersion: "v22.13.0", warmRuntimes: warm },
    );
    await executeAcp(
      ctx,
      "claude",
      {},
      { createRuntime: make as never, nodeVersion: "v22.13.0", warmRuntimes: warm },
    );
    expect(created).toBe(1);
    for (const entry of warm.values()) entry.lastUsedAt = 0;
    await executeAcp(
      ctx,
      "claude",
      {},
      { createRuntime: make as never, nodeVersion: "v22.13.0", warmRuntimes: warm },
    );
    expect(created).toBe(2);
    expect(closed).toBeGreaterThan(0);
  });

  it("covers ACP billing variants, metadata, and interrupted cancellation", async () => {
    const makeRuntime = (cancel: () => Promise<void> = async () => undefined) => ({
      ensureSession: async () => ({
        sessionKey: "key",
        backendSessionId: "billing-session",
        agentSessionId: "agent-session",
      }),
      getStatus: async () => ({ usage: { cumulative: { inputTokens: 1 } } }),
      startTurn: () => ({
        events: (async function* () {
          yield { type: "text_delta" as const, text: "ok", stream: "output" as const };
        })(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel,
      }),
      close: async () => undefined,
    });
    const meta = vi.fn();
    const variants = [
      ["claude", { ANTHROPIC_API_KEY: "key" }, { biller: "anthropic", billingType: "api" }],
      ["gemini", { GEMINI_API_KEY: "key" }, { biller: "google", billingType: "api" }],
      ["codex", { OPENAI_API_KEY: "key" }, { biller: "openai", billingType: "api" }],
    ] as const;
    for (const [agent, env, expected] of variants) {
      const stateDir = await mkdtemp(join(tmpdir(), `aaspai-acp-billing-${agent}-`));
      const result = await executeAcp(
        {
          ...context(stateDir, async () => undefined),
          config: { engine: "acp", env },
          onMeta: meta,
        },
        agent,
        {},
        {
          createRuntime: (() => makeRuntime()) as never,
          nodeVersion: agent === "gemini" ? "v20.0.0" : "v22.13.0",
        },
      );
      expect(result).toMatchObject(expected);
    }
    expect(meta).toHaveBeenCalled();

    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const interruptedRuntime = makeRuntime(async () => {
      throw new Error("cancel failed");
    });
    interruptedRuntime.startTurn = () => {
      started();
      return {
        events: (async function* () {})(),
        result: pending.then(() => ({ status: "completed" as const })),
        cancel: async () => undefined,
      };
    };
    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-acp-interrupted-"));
    const execution = executeAcp(
      context(stateDir, async () => undefined),
      "claude",
      {},
      { createRuntime: (() => interruptedRuntime) as never, nodeVersion: "v22.13.0" },
    );
    await startedPromise;
    await expect(cancelAcpSession("billing-session")).resolves.toMatchObject({
      cancelled: false,
      finalStatus: "interrupted",
    });
    release();
    await execution;
  });

  it("covers ACP aliases, optional session settings, environment variants, and terminal events", async () => {
    const parsed = [
      ["plan", "deny-all"],
      ["accept-edits", "approve-reads"],
      ["untrusted", "deny-all"],
      ["on-request", "approve-reads"],
      ["on-failure", "approve-reads"],
      ["unknown", "approve-all"],
    ] as const;
    for (const [permissionMode, expected] of parsed) {
      expect(parseAcpConfig("claude", { permissionMode })).toMatchObject({
        permissionMode: expected,
      });
    }
    expect(
      parseAcpConfig("claude", {
        mode: "invalid",
        timeoutSec: "invalid",
        maxTurns: 0,
        warmHandleIdleMs: 2.9,
        fastMode: "true",
        allowedTools: [" Read ", "", 4],
        tools: [" Write "],
        cwd: " /work ",
        effort: " high ",
      }),
    ).toMatchObject({
      mode: "persistent",
      timeoutMs: undefined,
      maxTurns: undefined,
      warmHandleIdleMs: 2,
      fastMode: true,
      allowedTools: ["Read"],
      cwd: "/work",
      effort: "high",
    });
    expect(
      parseAcpConfig("claude", { allowedTools: [], tools: [], env: [], stateDir: "" }),
    ).toMatchObject({ allowedTools: undefined });

    const stateDir = await mkdtemp(join(tmpdir(), "aaspai-acp-options-"));
    const progress = vi.fn();
    const status = [
      { usage: { cumulative: { inputTokens: 5 } } },
      { usage: { cumulative: { outputTokens: 2 } } },
    ];
    const optionsSeen: Record<string, unknown>[] = [];
    const fakeRuntime = {
      ensureSession: async (input: { sessionOptions: Record<string, unknown> }) => {
        optionsSeen.push(input.sessionOptions);
        return {
          sessionKey: "options",
          backendSessionId: "backend",
          acpxRecordId: "record",
          agentSessionId: "agent",
          runtimeSessionName: "runtime",
        };
      },
      getStatus: async () => status.shift(),
      setConfigOption: async (input: { key: string; value: string }) => optionsSeen.push(input),
      startTurn: () => ({
        events: (async function* () {
          yield { type: "status" as const, text: "" };
          yield { type: "status" as const, text: "working" };
          yield {
            type: "tool_call" as const,
            status: "started" as const,
            rawInput: "raw",
            rawOutput: 4,
          };
          yield {
            type: "tool_call" as const,
            status: "failed" as const,
            title: "tool",
            toolCallId: "tool",
            rawInput: { x: 1 },
            rawOutput: "out",
          };
          yield { type: "text_delta" as const, text: "answer", stream: "output" as const };
        })(),
        result: Promise.resolve({ status: "completed" as const, stopReason: "done" }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    const ctx = {
      ...context(stateDir, async () => undefined),
      config: {
        engine: "acp",
        stateDir,
        model: "model",
        allowedTools: ["Read"],
        maxTurns: 3,
        effort: "high",
        fastMode: true,
        env: [],
      },
      context: { cwd: stateDir, prompt: "prompt", systemPrompt: "system" },
      execution: {
        identity: { kind: "local", cwd: stateDir },
        environment: { inheritEnv: true, env: { AASPAI_RUNTIME: "yes" } },
        run: async () => {
          throw new Error("not CLI");
        },
      },
      onRuntimeProgress: progress,
    };
    const result = await executeAcp(
      ctx as never,
      "codex",
      {},
      {
        createRuntime: (() => fakeRuntime) as never,
        nodeVersion: "v22.13.0",
      },
    );
    expect(result).toMatchObject({ exitCode: 0, sessionId: "backend", model: "model" });
    expect(optionsSeen[0]).toMatchObject({
      model: "model",
      allowedTools: ["Read"],
      maxTurns: 3,
      systemPrompt: "system",
      env: { AASPAI_RUNTIME: "yes" },
    });

    const emptyUsageRuntime = {
      ensureSession: async () => ({ sessionKey: "empty-usage", backendSessionId: "empty-usage" }),
      getStatus: async () => ({ usage: { cumulative: {} } }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        { ...ctx, config: { engine: "acp", stateDir }, execution: undefined },
        "claude",
        {},
        { createRuntime: (() => emptyUsageRuntime) as never, nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ usage: undefined });
    await expect(
      executeAcp(
        { ...ctx, config: { engine: "acp", stateDir }, execution: undefined },
        "claude",
        {},
        { nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed" });
    const emptyFieldsRuntime = {
      ensureSession: async () => ({ sessionKey: "empty-fields", backendSessionId: "empty-fields" }),
      getStatus: async () => ({ usage: { cumulative: { reasoningTokens: 1 } } }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        { ...ctx, config: { engine: "acp", stateDir }, execution: undefined },
        "claude",
        {},
        { createRuntime: (() => emptyFieldsRuntime) as never, nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ usage: undefined });

    const emptyCommandRuntime = {
      ensureSession: async () => ({
        sessionKey: "empty-command",
        backendSessionId: "empty-command",
      }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        { ...ctx, config: { engine: "acp", stateDir, agentCommand: "" } },
        "claude",
        {},
        { createRuntime: (() => emptyCommandRuntime) as never, nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const stringErrorRuntime = {
      ensureSession: async () => ({ sessionKey: "string-error", backendSessionId: "string-error" }),
      startTurn: () => {
        throw "quota string";
      },
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        { ...ctx, config: { engine: "acp", stateDir } },
        "claude",
        {},
        { createRuntime: (() => stringErrorRuntime) as never, nodeVersion: "v22.13.0" },
      ),
    ).resolves.toMatchObject({ errorFamily: "provider_quota" });
    expect(optionsSeen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "reasoning_effort", value: "high" }),
        expect.objectContaining({ key: "service_tier", value: "fast" }),
        expect.objectContaining({ key: "features.fast_mode", value: "true" }),
      ]),
    );
    expect(progress).toHaveBeenCalled();

    const billingRuntime = {
      ensureSession: async () => ({ sessionKey: "billing", backendSessionId: "billing" }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    for (const [agent, env, version] of [
      ["claude", {}, "v22.12.0"],
      ["gemini", {}, "v20.0.0"],
      ["gemini", { GOOGLE_API_KEY: "key" }, "v20.0.0"],
      ["codex", {}, "v22.13.0"],
    ] as const) {
      const result = await executeAcp(
        {
          ...context(
            await mkdtemp(join(tmpdir(), "aaspai-acp-billing-default-")),
            async () => undefined,
          ),
          config: { engine: "acp", env },
        },
        agent,
        {},
        { createRuntime: (() => billingRuntime) as never, nodeVersion: version },
      );
      expect(result.exitCode).toBe(0);
    }
  });

  it("does not leak warm-runtime, abort, or close errors", async () => {
    const oldRuntime = {
      close: async () => {
        throw new Error("old runtime already closed");
      },
    };
    const warm = new Map<string, never>();
    warm.set("old", {
      runtime: oldRuntime,
      lastUsedAt: 0,
      handles: new Map([["old", {}]]),
    } as never);
    const currentRuntime = {
      ensureSession: async () => ({ sessionKey: "warm-current", backendSessionId: "warm-current" }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        {
          ...context(
            await mkdtemp(join(tmpdir(), "aaspai-acp-warm-error-")),
            async () => undefined,
          ),
          config: { engine: "acp", mode: "persistent", warmHandleIdleMs: 1 },
        },
        "claude",
        {},
        {
          createRuntime: (() => currentRuntime) as never,
          nodeVersion: "v22.12.0",
          warmRuntimes: warm as never,
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const abortController = new AbortController();
    const abortRuntime = {
      ensureSession: async () => ({
        sessionKey: "abort-callback",
        backendSessionId: "abort-callback",
      }),
      startTurn: () => {
        abortController.abort();
        return {
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const }),
          cancel: async () => undefined,
        };
      },
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        {
          ...context(
            await mkdtemp(join(tmpdir(), "aaspai-acp-abort-callback-")),
            async () => undefined,
          ),
          config: { engine: "acp" },
          signal: abortController.signal,
        },
        "claude",
        {},
        { createRuntime: (() => abortRuntime) as never, nodeVersion: "v22.12.0" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const cancelController = new AbortController();
    let resolveCancelResult!: (value: { status: "completed" }) => void;
    const cancelRuntime = {
      ensureSession: async () => ({
        sessionKey: "cancel-callback",
        backendSessionId: "cancel-callback",
      }),
      startTurn: () => {
        const turn = {
          events: (async function* () {})(),
          result: new Promise<{ status: "completed" }>((resolve) => {
            resolveCancelResult = resolve;
          }),
          cancel: async () => {
            throw new Error("cancel failed");
          },
        };
        setTimeout(() => cancelController.abort(), 0);
        setTimeout(() => resolveCancelResult({ status: "completed" }), 2);
        return turn;
      },
      close: async () => undefined,
    };
    await expect(
      executeAcp(
        {
          ...context(
            await mkdtemp(join(tmpdir(), "aaspai-acp-cancel-callback-")),
            async () => undefined,
          ),
          config: { engine: "acp" },
          signal: cancelController.signal,
        },
        "claude",
        {},
        { createRuntime: (() => cancelRuntime) as never, nodeVersion: "v22.12.0" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const closeErrorRuntime = {
      ensureSession: async () => ({ sessionKey: "close-error", backendSessionId: "close-error" }),
      startTurn: () => ({
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: async () => undefined,
      }),
      close: async () => {
        throw new Error("close failed");
      },
    };
    await expect(
      executeAcp(
        context(await mkdtemp(join(tmpdir(), "aaspai-acp-close-error-")), async () => undefined),
        "claude",
        {},
        { createRuntime: (() => closeErrorRuntime) as never, nodeVersion: "v22.12.0" },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const turnErrorRuntime = {
      ensureSession: async () => ({
        sessionKey: "turn-close-error",
        backendSessionId: "turn-close-error",
      }),
      startTurn: () => {
        throw new Error("turn failed");
      },
      close: async () => {
        throw new Error("close failed");
      },
    };
    await expect(
      executeAcp(
        context(
          await mkdtemp(join(tmpdir(), "aaspai-acp-turn-close-error-")),
          async () => undefined,
        ),
        "claude",
        {},
        { createRuntime: (() => turnErrorRuntime) as never, nodeVersion: "v22.12.0" },
      ),
    ).resolves.toMatchObject({ errorCode: "acp_execution_failed" });
  });
});
