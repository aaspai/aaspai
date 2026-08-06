import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateClaudeCost,
  calculateCodexCost,
  calculateGeminiCost,
  getClaudeCostWithMode,
} from "../src/cost.js";
import { ClaudeParser } from "../src/importers/claude.js";
import { CodexParser } from "../src/importers/codex.js";
import { GeminiParser } from "../src/importers/gemini.js";
import { importProviderFile } from "../src/ingest.js";
import { createTelemetryTestContext, TEST_ORGANIZATION } from "../src/test-utils.js";

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];
const dirs: string[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  const dir = mkdtempSync(join(tmpdir(), "aaspai-import-"));
  dirs.push(dir);
  return { ...context, dir };
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const CLAUDE_JSONL = [
  JSON.stringify({
    type: "user",
    timestamp: "2026-08-01T10:00:00Z",
    sessionId: "sess_claude1",
    message: { id: "msg1", role: "user", content: [{ type: "text", text: "build a todo app" }] },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:05Z",
    sessionId: "sess_claude1",
    requestId: "req1",
    cwd: "/tmp/proj",
    message: {
      id: "msg2",
      model: "claude-sonnet-4-5",
      role: "assistant",
      content: [{ type: "tool_use", name: "Edit", input: { path: "app.ts" } }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:10Z",
    sessionId: "sess_claude1",
    requestId: "req2",
    message: {
      id: "msg3",
      model: "claude-sonnet-4-5",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
].join("\n");

describe("Claude importer", () => {
  it("imports a fixture into logs + metrics with session correlation", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "sess_claude1.jsonl");
    writeFileSync(file, CLAUDE_JSONL, "utf8");
    const parser = new ClaudeParser({ organizationId: TEST_ORGANIZATION });
    const result = await importProviderFile(repo, hub, parser, {
      organizationId: TEST_ORGANIZATION,
      source: "claude-code",
      filePath: file,
    });
    expect(result.sessionId).toBe("sess_claude1");
    expect(result.logs).toBeGreaterThan(0);
    expect(result.metrics).toBeGreaterThan(0);
    const logs = repo.queryLogs({ organizationId: TEST_ORGANIZATION, sessionId: "sess_claude1" });
    expect(logs.rows.length).toBeGreaterThan(0);
    // Re-import is idempotent (dedup keys)
    const again = await importProviderFile(repo, hub, parser, {
      organizationId: TEST_ORGANIZATION,
      source: "claude-code",
      filePath: file,
    });
    expect(again.logs).toBe(0);
  });
});

const CODEX_JSONL = [
  JSON.stringify({
    timestamp: "2026-08-01T10:00:00Z",
    type: "session_meta",
    payload: {
      id: "sess_codex1",
      model: "gpt-5",
      model_provider: "openai",
      cli_version: "0.1",
      cwd: "/tmp",
    },
  }),
  JSON.stringify({
    timestamp: "2026-08-01T10:00:01Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 50 },
      },
    },
  }),
  JSON.stringify({
    timestamp: "2026-08-01T10:00:02Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  }),
  JSON.stringify({
    timestamp: "2026-08-01T10:00:03Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 700, output_tokens: 140, cache_read_input_tokens: 70 },
      },
    },
  }),
].join("\n");

describe("Codex importer", () => {
  it("imports fixture and computes token deltas", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "rollout-sess.jsonl");
    writeFileSync(file, CODEX_JSONL, "utf8");
    const parser = new CodexParser({ organizationId: TEST_ORGANIZATION });
    const result = await importProviderFile(repo, hub, parser, {
      organizationId: TEST_ORGANIZATION,
      source: "codex_cli_rs",
      filePath: file,
    });
    expect(result.logs).toBeGreaterThan(0);
    const tokenMetrics = repo.queryMetrics({
      organizationId: TEST_ORGANIZATION,
      eventType: "none",
    });
    const tokens = tokenMetrics.rows.filter(
      (r) => (r.name as string) === "codex_cli_rs.token.usage",
    );
    // First token_count emits full values; second emits deltas (input 200, output 40, cache 20)
    expect(tokens.length).toBeGreaterThanOrEqual(6);
  });
});

const GEMINI_SESSION = JSON.stringify({
  sessionId: "sess_gemini1",
  projectHash: "abc",
  messages: [
    { id: "g1", timestamp: "2026-08-01T10:00:00Z", type: "user", content: "hello" },
    {
      id: "g2",
      timestamp: "2026-08-01T10:00:05Z",
      type: "gemini",
      content: "hi there",
      model: "gemini-2.5-flash",
      tokens: { input: 100, output: 50, cached: 10 },
      toolCalls: [
        {
          id: "t1",
          name: "code",
          args: "{}",
          timestamp: "2026-08-01T10:00:04Z",
          status: "success",
          result: [{ functionResponse: { name: "code", response: { output: "ok" } } }],
        },
      ],
    },
  ],
});

describe("Gemini importer", () => {
  it("imports fixture with tool call/result and cost", async () => {
    const { repo, hub, dir } = await setup();
    const file = join(dir, "session-g1.json");
    writeFileSync(file, GEMINI_SESSION, "utf8");
    const parser = new GeminiParser({ organizationId: TEST_ORGANIZATION });
    const result = await importProviderFile(repo, hub, parser, {
      organizationId: TEST_ORGANIZATION,
      source: "gemini_cli",
      filePath: file,
    });
    expect(result.sessionId).toBe("sess_gemini1");
    expect(result.logs).toBeGreaterThanOrEqual(3);
    const logs = repo.queryLogs({ organizationId: TEST_ORGANIZATION, sessionId: "sess_gemini1" });
    const roles = logs.rows.map(
      (r) => (r.attributesJson as Record<string, unknown>)["message.role"],
    );
    expect(roles).toContain("tool_use");
    expect(roles).toContain("tool_result");
    const costMetrics = repo.queryMetrics({ organizationId: TEST_ORGANIZATION });
    expect(
      costMetrics.rows.filter((r) => (r.name as string) === "gemini_cli.cost.usage").length,
    ).toBeGreaterThan(0);
  });
});

describe("cost calculation", () => {
  it("calculates Claude cost with cache pricing", () => {
    const cost = calculateClaudeCost("claude-sonnet-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationInputTokens: 10_000,
      cacheReadInputTokens: 20_000,
    });
    expect(cost).toBeCloseTo(3 + 1.5 + 0.0375 + 0.006, 4);
  });

  it("returns null for unknown models instead of zero", () => {
    expect(
      calculateClaudeCost("unknown-model-x", {
        inputTokens: 100,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeNull();
    expect(calculateCodexCost("unknown-model-x", 100, 0, 100)).toBeNull();
    expect(calculateGeminiCost("unknown-model-x", 100, 0, 100)).toBeNull();
  });

  it("respects pricing mode for provider-reported cost", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(getClaudeCostWithMode("display", "claude-sonnet-4-5", usage, 0.99)).toBeCloseTo(0.99, 4);
    expect(getClaudeCostWithMode("calculate", "claude-sonnet-4-5", usage, 0.99)).not.toBeCloseTo(
      0.99,
      4,
    );
  });

  it("computes Codex and Gemini cost", () => {
    const codexCost = calculateCodexCost("gpt-5", 1_000_000, 100_000, 100_000);
    expect(codexCost).toBeCloseTo(
      (0.9e6 / 1e6) * 1.25 + (0.1e6 / 1e6) * 0.125 + (0.1e6 / 1e6) * 10,
      4,
    );
    const geminiCost = calculateGeminiCost("gemini-2.5-flash", 1_000_000, 10_000, 100_000);
    expect(geminiCost).toBeCloseTo(0.3 + 0.0003 + 0.25, 4);
  });
});
