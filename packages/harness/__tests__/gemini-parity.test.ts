import type { AdapterExecutionContext } from "@aaspai/contracts/harness";
import type { JsonObject } from "@aaspai/contracts/primitives";
import type { RunProcessOptions, RunProcessResult } from "@aaspai/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

const acpMocks = vi.hoisted(() => ({
  executeAcp: vi.fn(),
  resolveAcpEngine: vi.fn(),
  testAcpEnvironment: vi.fn(),
}));

vi.mock("../src/shared/acp.js", () => acpMocks);

import * as geminiConfig from "../src/drivers/gemini-local/config.js";
import { geminiLocal } from "../src/drivers/gemini-local/index.js";

function result(stdout = "", exitCode = 0): RunProcessResult {
  const now = new Date().toISOString();
  return {
    exitCode,
    timedOut: false,
    stdout,
    stderr: exitCode === 0 ? "" : "failed",
    startedAt: now,
    finishedAt: now,
    durationMs: 1,
  };
}

function context(config: JsonObject): AdapterExecutionContext {
  return {
    protocolVersion: 1,
    runId: "run_gemini",
    organizationId: "org_gemini",
    agent: {
      id: "agent_gemini",
      organizationId: "org_gemini",
      name: "Gemini",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {},
    config,
    context: { cwd: process.cwd(), prompt: "hello" },
    execution: {
      identity: { kind: "local", cwd: process.cwd() },
      environment: { env: {}, inheritEnv: false },
      run: async (options: RunProcessOptions) => {
        await options.onLog?.(
          "stdout",
          `${JSON.stringify({ type: "assistant", session_id: "gemini-session", text: "hi" })}\n`,
        );
        return result();
      },
    },
    onLog: vi.fn(async () => {}),
  };
}

describe("gemini_local parity", () => {
  it("rejects invalid config and executes the explicit CLI engine", async () => {
    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "cli", explicit: true });
    await expect(geminiLocal.execute(context({ extraArgs: [1] }))).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "config_invalid",
    });
    await expect(
      geminiLocal.execute(context({ engine: "cli", model: "gemini-test" })),
    ).resolves.toMatchObject({
      exitCode: 0,
      sessionId: "gemini-session",
      model: "gemini-test",
    });
  });

  it("falls back from auto ACP and exposes ACP execution", async () => {
    acpMocks.resolveAcpEngine.mockResolvedValue({
      engine: "cli",
      explicit: false,
      fallbackReason: "ACP unavailable",
    });
    const fallback = await geminiLocal.execute(context({ engine: "auto" }));
    expect(fallback.exitCode).toBe(0);
    expect(context({ engine: "auto" }).onLog).toBeDefined();

    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "acp", explicit: true });
    acpMocks.executeAcp.mockResolvedValue({ exitCode: 0, summary: "acp" });
    await expect(geminiLocal.execute(context({ engine: "acp" }))).resolves.toEqual({
      exitCode: 0,
      summary: "acp",
    });
  });

  it("tests invalid, ACP, fallback, and CLI environments", async () => {
    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "cli", explicit: true });
    await expect(
      geminiLocal.testEnvironment({ config: { extraArgs: [1] }, cwd: process.cwd() } as never),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "config", level: "error" }],
    });

    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "acp", explicit: true });
    acpMocks.testAcpEnvironment.mockResolvedValue({
      ok: true,
      checks: [{ name: "acp", level: "info" }],
    });
    await expect(
      geminiLocal.testEnvironment({ config: { engine: "acp" }, cwd: process.cwd() } as never),
    ).resolves.toMatchObject({
      ok: true,
      checks: [{ name: "acp" }],
    });

    acpMocks.resolveAcpEngine.mockResolvedValue({
      engine: "cli",
      explicit: false,
      fallbackReason: "missing",
    });
    await expect(
      geminiLocal.testEnvironment({
        config: { engine: "auto", command: process.execPath },
        cwd: process.cwd(),
      } as never),
    ).resolves.toMatchObject({
      ok: true,
      checks: [
        { name: "acp_fallback", level: "warn" },
        { name: "cli", level: "info" },
      ],
    });

    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "cli", explicit: true });
    await expect(
      geminiLocal.testEnvironment({
        config: { engine: "cli", command: "missing-gemini-command" },
        cwd: process.cwd(),
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      checks: [{ name: "cli", level: "error" }],
    });
    acpMocks.resolveAcpEngine.mockResolvedValue({ engine: "cli", explicit: true });
    await expect(
      geminiLocal.testEnvironment({
        config: { engine: "cli", command: process.execPath },
        cwd: process.cwd(),
      } as never),
    ).resolves.toMatchObject({
      ok: true,
      checks: [{ name: "cli", level: "info" }],
    });
    await expect(
      geminiLocal.testEnvironment({ config: null, cwd: process.cwd() } as never),
    ).resolves.toBeTruthy();
    const parseConfig = vi.spyOn(geminiConfig, "parseGeminiLocalConfig").mockImplementation(() => {
      throw "plain config failure";
    });
    try {
      await expect(geminiLocal.execute(context({ engine: "cli" }))).resolves.toMatchObject({
        errorMessage: "plain config failure",
      });
    } finally {
      parseConfig.mockRestore();
    }
  });
});
