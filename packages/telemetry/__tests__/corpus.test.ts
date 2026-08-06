import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeParser } from "../src/importers/claude.js";
import { CodexParser } from "../src/importers/codex.js";
import { GeminiParser } from "../src/importers/gemini.js";
import { createTelemetryTestContext, TEST_ORGANIZATION } from "../src/test-utils.js";

/**
 * Fixed comparison corpus (plan §11.1).
 *
 * These fixtures are checked in under __tests__/fixtures and pinned by a
 * checksum. Replaying the same fixture through the importer must produce
 * the same normalized counts and ordering — the differential baseline for
 * OBS-T370..T374.
 */

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

const CORPUS = {
  "claude/sess_claude_fixture.jsonl":
    "d9fc0fbacf625c3bae797d8a90c617c3e4cf5682f4d8bf4b9e475d1490087d51",
  "codex/rollout-sess_fixture.jsonl":
    "a9b8434389d21dca3243657dbd3423ff5234f39a2d2ce49ccc9bacce8e26fee9",
  "gemini/session-g_fixture.json":
    "9187bb2cb538c14adfb599e676fbae23f411f5ffeb6ea0a56276a3bc020d5202",
};

const contexts: Awaited<ReturnType<typeof createTelemetryTestContext>>[] = [];

async function setup() {
  const context = await createTelemetryTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length) {
    const c = contexts.pop();
    if (c) await c.cleanup();
  }
});

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("comparison corpus", () => {
  it("corpus files exist and checksums are pinned", () => {
    for (const [rel, expected] of Object.entries(CORPUS)) {
      const buffer = readFileSync(join(FIXTURE_DIR, rel));
      const hash = sha256(buffer);
      expect(hash).toBe(expected);
    }
  });

  it("claude fixture imports to a deterministic result", async () => {
    const { repo } = await setup();
    const parser = new ClaudeParser({ organizationId: TEST_ORGANIZATION });
    const file = join(FIXTURE_DIR, "claude", "sess_claude_fixture.jsonl");
    const result = await parser.parseFile(file);
    expect(result.sessionId).toBe("sess_claude_fixture");
    expect(result.recordCount).toBe(3);
    expect(result.logs.length).toBeGreaterThanOrEqual(5); // 2 transcript + api_request + tokens
    expect(result.metrics.length).toBe(16); // 6 token types x2 (user-facing) + 2 cost x2
    const roles = result.logs
      .filter((l) => l.eventName === "transcript.message")
      .map((l) => l.attributes?.["message.role"]);
    expect(roles).toContain("user");
    expect(roles).toContain("tool_use");
    repo.insertBatch({ logs: result.logs, metrics: result.metrics });
    const rerun = await parser.parseFile(file);
    repo.insertBatch({ logs: rerun.logs, metrics: rerun.metrics });
    expect(repo.queryLogs({ organizationId: TEST_ORGANIZATION }).total).toBe(result.logs.length);
  });

  it("codex fixture imports deterministic transcript ordering", async () => {
    const parser = new CodexParser({ organizationId: TEST_ORGANIZATION });
    const file = join(FIXTURE_DIR, "codex", "rollout-sess_fixture.jsonl");
    const result = await parser.parseFile(file);
    expect(result.sessionId).toBe("sess_codex_fixture");
    const transcript = result.logs.filter((l) => l.eventName === "transcript.message");
    const roles = transcript.map((l) => l.attributes?.["message.role"]);
    expect(roles).toEqual(["user", "tool_use", "tool_result"]);
    expect(result.metrics.filter((m) => m.name === "codex_cli_rs.token.usage").length).toBe(6); // input/output/cache_read x2 token events
  });

  it("gemini fixture imports transcript + cost deterministically", async () => {
    const parser = new GeminiParser({ organizationId: TEST_ORGANIZATION });
    const file = join(FIXTURE_DIR, "gemini", "session-g_fixture.json");
    const result = await parser.parseFile(file);
    expect(result.sessionId).toBe("sess_gemini_fixture");
    const roles = result.logs.map((l) => l.attributes?.["message.role"]);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool_use");
    expect(roles).toContain("tool_result");
    const costMetrics = result.metrics.filter((m) => m.name === "gemini_cli.cost.usage");
    expect(costMetrics).toHaveLength(1);
    expect(Number(costMetrics[0]?.value)).toBeGreaterThan(0);
  });
});
