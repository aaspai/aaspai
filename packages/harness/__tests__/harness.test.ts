import {
  ADAPTER_TYPE_VALUES,
  adapterExecutionContextSchema,
  adapterExecutionResultSchema,
  buildAgentEnv,
  claudeLocalConfigSchema,
  codexLocalConfigSchema,
  getAdapter,
  getAdapterCapabilities,
  HARNESS_PROTOCOL_VERSION,
  isAdapterReady,
  listAdapters,
  REDACTED_HOME_PATH_USER,
  REDACTED_SECRET_VALUE,
  redactCommandText,
  redactEnv,
  redactHomePath,
  transcriptEntrySchema,
} from "@aaspai/harness";
import { describe, expect, it } from "vitest";
import { codexSandboxProbeArgs } from "../src/drivers/codex-local/execute";

describe("harness contract", () => {
  it("exposes a stable protocol version", () => {
    expect(HARNESS_PROTOCOL_VERSION).toBe(1);
  });

  it("lists every known adapter type", () => {
    expect(new Set(ADAPTER_TYPE_VALUES)).toEqual(
      new Set([
        "claude_local",
        "codex_local",
        "cursor_local",
        "cursor_cloud",
        "gemini_local",
        "grok_local",
        "pi_local",
        "hermes_local",
        "hermes",
        "openclaw_gateway",
        "hermes_gateway",
        "dry_run_local",
        "opencode_cli",
        "opencode_local",
      ]),
    );
  });

  it("round-trips a minimal AdapterExecutionContext", () => {
    const ctx = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      runId: "run_123",
      organizationId: "org_1",
      agent: {
        id: "agent_1",
        organizationId: "org_1",
        name: "test",
        adapterType: "claude_local" as const,
        adapterConfig: {},
      },
      runtime: {},
      config: {},
      context: { cwd: "/tmp", prompt: "hi" },
      onLog: () => {},
    };
    expect(() => adapterExecutionContextSchema.parse(ctx)).not.toThrow();
  });

  it("round-trips a successful AdapterExecutionResult", () => {
    const result = {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      exitCode: 0,
      timedOut: false,
      summary: "hello",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      billingType: "subscription" as const,
    };
    const parsed = adapterExecutionResultSchema.parse(result);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.protocolVersion).toBe(HARNESS_PROTOCOL_VERSION);
  });

  it("validates every TranscriptEntry kind", () => {
    for (const entry of [
      { kind: "assistant", ts: "t", text: "x" },
      { kind: "thinking", ts: "t", text: "x" },
      { kind: "user", ts: "t", text: "x" },
      { kind: "tool_call", ts: "t", name: "x", status: "started" as const },
      { kind: "tool_result", ts: "t", name: "x" },
      { kind: "init", ts: "t" },
      { kind: "result", ts: "t" },
      { kind: "stderr", ts: "t", text: "x" },
      { kind: "system", ts: "t", text: "x" },
      { kind: "stdout", ts: "t", text: "x" },
      { kind: "diff", ts: "t", path: "x", patch: "x" },
    ]) {
      expect(() => transcriptEntrySchema.parse(entry)).not.toThrow();
    }
  });
});

describe("claude_local config", () => {
  it("applies defaults on empty input", () => {
    const parsed = claudeLocalConfigSchema.parse({});
    expect(parsed.command).toBe("claude");
    expect(parsed.permissionMode).toBe("bypass-permissions");
    expect(parsed.engine).toBe("auto");
  });

  it("rejects unknown keys", () => {
    expect(() => claudeLocalConfigSchema.parse({ unknown: 1 })).toThrow();
  });
});

describe("codex_local config", () => {
  it("applies defaults on empty input", () => {
    const parsed = codexLocalConfigSchema.parse({});
    expect(parsed.command).toBe("codex");
    expect(parsed.sandbox).toBe("workspace-write");
  });

  it("uses a model-free sandbox readiness probe on Windows", () => {
    expect(codexSandboxProbeArgs("workspace-write", "linux")).toBeNull();
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
  });
});

describe("redaction", () => {
  it("replaces HOME with the redaction marker", () => {
    process.env.HOME = "/home/sande";
    expect(redactHomePath("/home/sande/projects/foo")).toBe(
      `${REDACTED_HOME_PATH_USER}/projects/foo`,
    );
  });

  it("redacts well-known secret env values in command text", () => {
    const out = redactCommandText("ANTHROPIC_API_KEY=sk-abc /usr/bin/claude --model x");
    expect(out).toContain(REDACTED_SECRET_VALUE);
    expect(out).not.toContain("sk-abc");
  });

  it("redacts known sensitive env keys", () => {
    const out = redactEnv({
      ANTHROPIC_API_KEY: "sk-abc",
      OPENAI_API_KEY: "sk-xyz",
      PATH: "/usr/bin",
    });
    expect(out.ANTHROPIC_API_KEY).toBe(REDACTED_SECRET_VALUE);
    expect(out.OPENAI_API_KEY).toBe(REDACTED_SECRET_VALUE);
    expect(out.PATH).toBe("/usr/bin");
  });
});

describe("buildAgentEnv", () => {
  it("injects the AASPAI_* env vars for every run", () => {
    const env = buildAgentEnv(
      { id: "a1", organizationId: "o1", name: "agent", adapterType: "claude_local" },
      { runId: "r1", sessionId: "s1", cwd: "/tmp" },
    );
    expect(env.AASPAI_AGENT_ID).toBe("a1");
    expect(env.AASPAI_ORGANIZATION_ID).toBe("o1");
    expect(env.AASPAI_ADAPTER_TYPE).toBe("claude_local");
    expect(env.AASPAI_RUN_ID).toBe("r1");
    expect(env.AASPAI_SESSION_ID).toBe("s1");
    expect(env.AASPAI_CWD).toBe("/tmp");
  });

  it("does not allow adapter config to overwrite harness identity", () => {
    const env = buildAgentEnv(
      { id: "a1", organizationId: "o1", name: "agent", adapterType: "claude_local" },
      {
        runId: "r1",
        additionalEnv: { AASPAI_RUN_ID: "forged", AASPAI_AGENT_ID: "forged", SAFE: "ok" },
      },
    );
    expect(env.AASPAI_RUN_ID).toBe("r1");
    expect(env.AASPAI_AGENT_ID).toBe("a1");
    expect(env.SAFE).toBe("ok");
  });
});

describe("adapter registry", () => {
  it("lists every known adapter", () => {
    const infos = listAdapters();
    expect(infos.length).toBe(ADAPTER_TYPE_VALUES.length);
    const types = new Set(infos.map((i) => i.type));
    for (const t of ADAPTER_TYPE_VALUES) expect(types.has(t)).toBe(true);
  });

  it("getAdapter returns the right module for every type", () => {
    for (const t of ADAPTER_TYPE_VALUES) {
      const m = getAdapter(t);
      expect(m.info.type).toBe(t);
    }
  });

  it("marks every registered provider as ready", () => {
    for (const type of ADAPTER_TYPE_VALUES) expect(isAdapterReady(type)).toBe(true);
  });

  it("reports declared adapter capabilities instead of generic optimistic values", () => {
    expect(getAdapterCapabilities("claude_local")).toMatchObject({
      execute: true,
      streaming: true,
      cancellation: true,
      timeout: true,
      resume: true,
      billing: "subscription",
    });
    expect(getAdapterCapabilities("dry_run_local")).toMatchObject({
      execute: true,
      timeout: false,
      billing: "free",
    });
  });
});
