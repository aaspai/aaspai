import type { TranscriptEntry } from "@aaspai/contracts/harness";
import { describe, expect, it, vi } from "vitest";
import {
  claudeLocalConfigSchema,
  DEFAULT_CLAUDE_LOCAL_CONFIG,
  formatClaudeTranscriptEntry,
} from "../src/drivers/claude-local";
import { parseClaudeLocalConfig } from "../src/drivers/claude-local/config";
import { DEFAULT_CODEX_LOCAL_CONFIG, formatCodexTranscriptEntry } from "../src/drivers/codex-local";
import { parseCodexLocalConfig } from "../src/drivers/codex-local/config";
import {
  geminiLocalConfigSchema,
  parseGeminiLocalConfig,
} from "../src/drivers/gemini-local/config";
import { createJsonlFramer } from "../src/shared/jsonl";
import { createRuntimeProgressReporter, RUNTIME_PROGRESS_PHASES } from "../src/shared/progress";
import {
  REDACTED_HOME_PATH_USER,
  REDACTED_SECRET_VALUE,
  redactCommandText,
  redactEnv,
  redactHomePath,
  redactHomePathInValue,
} from "../src/shared/redact";
import { SandboxTransportUnavailableError } from "../src/shared/sandbox";
import {
  acpSessionCodec,
  cursorCloudSessionCodec,
  hermesSessionCodec,
  localSessionCodec,
  openclawSessionCodec,
  opencodeSessionCodec,
} from "../src/shared/session-codec";
import { ensureSshTransportAvailable, SshTransportUnavailableError } from "../src/shared/ssh";

const ts = "2026-01-01T00:00:00.000Z";

const transcriptEntries: TranscriptEntry[] = [
  { kind: "init", ts, model: "model", sessionId: "session" },
  { kind: "init", ts },
  { kind: "assistant", ts, text: "assistant" },
  { kind: "thinking", ts, text: "thinking" },
  { kind: "user", ts, text: "user" },
  { kind: "tool_call", ts, name: "read", id: "tool", status: "started" },
  { kind: "tool_call", ts, name: "read", status: "completed" },
  { kind: "tool_result", ts, name: "read", id: "tool", output: "ok" },
  { kind: "tool_result", ts, name: "read", output: "bad", isError: true },
  { kind: "result", ts, summary: "done", isError: true },
  { kind: "result", ts },
  { kind: "stderr", ts, text: "stderr" },
  { kind: "system", ts, text: "system" },
  { kind: "stdout", ts, text: "stdout" },
  { kind: "diff", ts, path: "file.ts", patch: "+line" },
];

describe("Claude and Codex transcript formatters", () => {
  it.each(transcriptEntries)("formats $kind for Claude", (entry) => {
    expect(formatClaudeTranscriptEntry(entry)).toBeTruthy();
  });

  it.each(transcriptEntries)("formats $kind for Codex", (entry) => {
    expect(formatCodexTranscriptEntry(entry)).toBeTruthy();
  });

  it("fails closed for an unknown runtime entry", () => {
    expect(formatClaudeTranscriptEntry({ kind: "unknown" } as never)).toBe("");
    expect(formatCodexTranscriptEntry({ kind: "unknown" } as never)).toBe("");
    expect(formatClaudeTranscriptEntry({ kind: "init", ts } as never)).toContain("[init]");
    expect(formatCodexTranscriptEntry({ kind: "init", ts } as never)).toContain("[init]");
    expect(
      formatClaudeTranscriptEntry({ kind: "tool_result", ts, name: "tool" } as never),
    ).toContain("[result:tool]");
    expect(
      formatCodexTranscriptEntry({ kind: "tool_result", ts, name: "tool" } as never),
    ).toContain("[result:tool]");
    expect(
      formatClaudeTranscriptEntry({
        kind: "tool_result",
        ts,
        name: "tool",
        isError: true,
      } as never),
    ).toContain("[result:tool]");
    expect(
      formatCodexTranscriptEntry({ kind: "tool_result", ts, name: "tool", isError: true } as never),
    ).toContain("[result:tool]");
    expect(formatClaudeTranscriptEntry({ kind: "result", ts } as never)).toContain("[result]");
    expect(formatCodexTranscriptEntry({ kind: "result", ts } as never)).toContain("[result]");
  });
});

describe("provider config defaults and validation", () => {
  it("returns Claude defaults for nullish input", () => {
    expect(parseClaudeLocalConfig(undefined)).toEqual(DEFAULT_CLAUDE_LOCAL_CONFIG);
    expect(parseClaudeLocalConfig(null)).toEqual(DEFAULT_CLAUDE_LOCAL_CONFIG);
    expect(claudeLocalConfigSchema.parse({})).toMatchObject(DEFAULT_CLAUDE_LOCAL_CONFIG);
  });

  it("parses Claude's full configuration", () => {
    expect(
      parseClaudeLocalConfig({
        command: " claude-custom ",
        model: " sonnet ",
        effort: "high",
        permissionMode: "accept-edits",
        engine: "acp",
        mode: "persistent",
        acpPermissionMode: "approve-reads",
        nonInteractivePermissions: "fail",
        stateDir: "C:\\state",
        acpStateDir: "C:\\acp-state",
        acpAllowedTools: ["Read"],
        warmHandleIdleMs: 1_000,
        maxTurns: 3,
        timeoutSec: 60,
        graceSec: 10,
        extraArgs: ["--verbose"],
        env: { TEST: "value" },
        cwd: "C:\\work",
        chrome: true,
        dangerouslySkipPermissions: false,
        tools: ["Read"],
      }),
    ).toMatchObject({
      command: "claude-custom",
      model: "sonnet",
      engine: "acp",
      chrome: true,
    });
  });

  it("returns Codex defaults for nullish input and parses full config", () => {
    expect(parseCodexLocalConfig(undefined)).toEqual(DEFAULT_CODEX_LOCAL_CONFIG);
    expect(parseCodexLocalConfig(null)).toEqual(DEFAULT_CODEX_LOCAL_CONFIG);
    expect(parseCodexLocalConfig({})).toMatchObject(DEFAULT_CODEX_LOCAL_CONFIG);
    expect(
      parseCodexLocalConfig({ sandbox: "read-only", approvalMode: "on-request" }),
    ).toMatchObject({
      sandbox: "read-only",
      approvalMode: "on-request",
    });
  });

  it("parses Gemini defaults and rejects unknown configuration", () => {
    expect(parseGeminiLocalConfig(undefined)).toMatchObject({
      command: "gemini",
      engine: "auto",
      graceSec: 15,
      extraArgs: [],
      env: {},
    });
    expect(geminiLocalConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});

describe("session codecs", () => {
  it("normalizes local session aliases and preserves supported fields", () => {
    expect(
      localSessionCodec.deserialize({
        nativeSessionId: " local ",
        cwd: " C:\\work ",
        workspaceId: "workspace",
        repoUrl: "https://example.test/repo",
        repoRef: "main",
        ignored: "ignored",
      }),
    ).toEqual({
      sessionId: "local",
      cwd: "C:\\work",
      workspaceId: "workspace",
      repoUrl: "https://example.test/repo",
      repoRef: "main",
    });
    expect(localSessionCodec.serialize({ session_id: "s1" })).toEqual({ sessionId: "s1" });
    expect(localSessionCodec.deserialize([])).toBeNull();
    expect(localSessionCodec.deserialize({ sessionId: " " })).toBeNull();
    expect(localSessionCodec.getDisplayId?.({ session_id: "s2" })).toBe("s2");
    expect(localSessionCodec.getDisplayId?.({})).toBeNull();
    expect(
      localSessionCodec.deserialize({ sessionId: "s", cwd: [], workspaceId: 0, repoUrl: " " }),
    ).toEqual({ sessionId: "s" });
  });

  it("preserves ACP state while adding a canonical session id", () => {
    expect(acpSessionCodec.deserialize({ backendSessionId: "b1", mode: "persistent" })).toEqual({
      backendSessionId: "b1",
      mode: "persistent",
      sessionId: "b1",
    });
    expect(acpSessionCodec.serialize({ cliSessionId: "cli1", extra: true })).toMatchObject({
      cliSessionId: "cli1",
      sessionId: "cli1",
      extra: true,
    });
    expect(acpSessionCodec.deserialize({})).toBeNull();
  });

  it("normalizes every provider-specific session codec", () => {
    expect(
      cursorCloudSessionCodec.deserialize({
        agentId: "agent",
        latestRunId: "run",
        runtime: "cloud",
        envType: "dev",
        envName: "env",
        repos: ["repo"],
      }),
    ).toEqual({
      cursorAgentId: "agent",
      latestRunId: "run",
      runtime: "cloud",
      envType: "dev",
      envName: "env",
      repos: ["repo"],
    });
    expect(cursorCloudSessionCodec.deserialize({ agentId: "agent", repos: [] })).toEqual({
      cursorAgentId: "agent",
    });
    expect(hermesSessionCodec.deserialize({ session_id: "hermes", hermesRunId: "run" })).toEqual({
      hermesSessionId: "hermes",
      hermesRunId: "run",
    });
    expect(openclawSessionCodec.deserialize({ sessionId: "openclaw", runId: "run" })).toEqual({
      sessionKey: "openclaw",
      runId: "run",
    });
    expect(opencodeSessionCodec.deserialize({ cliSessionId: "opencode", cwd: "C:\\work" })).toEqual(
      {
        cliSessionId: "opencode",
        cwd: "C:\\work",
        sessionId: "opencode",
      },
    );
    expect(opencodeSessionCodec.getDisplayId?.({})).toBeNull();
  });
});

describe("redaction", () => {
  it("redacts home paths in strings and nested values", () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "C:\\Users\\tester";
    try {
      expect(redactHomePath("C:\\Users\\tester")).toBe(REDACTED_HOME_PATH_USER);
      expect(redactHomePath("C:\\Users\\tester\\project")).toBe("~\\project");
      expect(redactHomePath("C:\\other\\project")).toBe("C:\\other\\project");
      expect(
        redactHomePathInValue({
          path: "C:\\Users\\tester\\file",
          nested: ["C:\\Users\\tester\\a", 1, null],
        }),
      ).toEqual({ path: "~\\file", nested: ["~\\a", 1, null] });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("redacts secret command values and environment keys", () => {
    expect(redactCommandText("HOME=C:\\Users\\tester MY_API_KEY=secret MY_TOKEN=abc")).toContain(
      `MY_API_KEY=${REDACTED_SECRET_VALUE}`,
    );
    expect(
      redactEnv({
        ANTHROPIC_API_KEY: "a",
        TOKEN: "b",
        SAFE_VALUE: "c",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: REDACTED_SECRET_VALUE,
      TOKEN: REDACTED_SECRET_VALUE,
      SAFE_VALUE: "c",
    });
  });

  it("leaves paths unchanged when no home directory is configured", () => {
    const home = process.env.HOME;
    const userProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      expect(redactHomePath("C:\\other\\project")).toBe("C:\\other\\project");
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (userProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = userProfile;
    }
  });
});

describe("runtime progress reporter", () => {
  it("computes, clamps, throttles, flushes, and emits completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const seen: Array<{ percent?: number; transferredBytes: number }> = [];
      const reporter = createRuntimeProgressReporter({
        sink: (update) => {
          seen.push({ percent: update.percent, transferredBytes: update.transferredBytes });
        },
        minIntervalMs: 100,
        minStepPercent: 10,
      });

      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 5,
        totalBytes: 100,
      });
      expect(seen).toEqual([]);

      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 20,
        totalBytes: 100,
      });
      expect(seen.at(-1)).toEqual({ percent: 20, transferredBytes: 20 });

      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 25,
        totalBytes: 100,
      });
      await reporter.flush();
      expect(seen.at(-1)).toEqual({ percent: 25, transferredBytes: 25 });

      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 200,
        totalBytes: 100,
      });
      expect(seen.at(-1)).toEqual({ percent: 100, transferredBytes: 200 });

      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: -5,
        totalBytes: 0,
      });
      await reporter.flush();
      expect(seen.at(-1)).toEqual({ percent: 0, transferredBytes: -5 });

      const defaults = createRuntimeProgressReporter({ sink: () => undefined });
      defaults.report({
        phase: "finalize",
        label: "finalize",
        direction: "upload",
        transferredBytes: 0,
      });
      await defaults.flush();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a pending update from the timer and survives sink errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const seen: number[] = [];
      const reporter = createRuntimeProgressReporter({
        sink: async (update) => {
          if (update.transferredBytes === 2) throw new Error("sink unavailable");
          seen.push(update.transferredBytes);
        },
        minIntervalMs: 100,
        minStepPercent: 100,
      });
      reporter.report({
        phase: "download",
        label: "download",
        direction: "download",
        transferredBytes: 1,
        totalBytes: undefined,
      });
      reporter.report({
        phase: "download",
        label: "download",
        direction: "download",
        transferredBytes: 1,
        totalBytes: undefined,
      });
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      expect(seen).toEqual([1]);

      reporter.report({
        phase: "download",
        label: "download",
        direction: "download",
        transferredBytes: 2,
        totalBytes: 100,
      });
      await reporter.flush();
      expect(seen).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports every supported progress phase", () => {
    expect(Object.keys(RUNTIME_PROGRESS_PHASES)).toHaveLength(8);
  });

  it("clears a scheduled progress update when completion arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const seen: number[] = [];
      const reporter = createRuntimeProgressReporter({
        sink: (update) => {
          seen.push(update.percent ?? 0);
        },
        minIntervalMs: 100,
        minStepPercent: 100,
      });
      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 1,
        totalBytes: 100,
      });
      reporter.report({
        phase: "upload",
        label: "upload",
        direction: "upload",
        transferredBytes: 100,
        totalBytes: 100,
      });
      expect(seen).toEqual([100]);
      vi.runAllTimers();
      expect(seen).toEqual([100]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("explicit unavailable transports", () => {
  it("reports sandbox transport unavailability", () => {
    const error = new SandboxTransportUnavailableError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SandboxTransportUnavailableError");
    expect(error.code).toBe("AASPAI_SANDBOX_UNAVAILABLE");
    expect(error.message).toContain("@aaspai/runtime");
  });

  it("reports SSH transport unavailability", () => {
    expect(() => ensureSshTransportAvailable()).toThrow(SshTransportUnavailableError);
    try {
      ensureSshTransportAvailable();
    } catch (error) {
      expect(error).toMatchObject({
        name: "SshTransportUnavailableError",
        code: "AASPAI_SSH_UNAVAILABLE",
      });
    }
  });
});

describe("JSONL framing", () => {
  it("normalizes CRLF on pushed and flushed lines", () => {
    const framer = createJsonlFramer();
    expect(framer.push("one\r\ntwo\r\npartial\r")).toEqual(["one", "two"]);
    expect(framer.flush()).toEqual(["partial"]);
  });
});
