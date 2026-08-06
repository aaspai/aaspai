import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeParser } from "@aaspai/telemetry";
import { CodexParser } from "@aaspai/telemetry";
import { GeminiParser } from "@aaspai/telemetry";

/**
 * Differential harness — Aaspai side (plan §11).
 *
 * Runs the pinned comparison corpus (packages/telemetry/__tests__/fixtures)
 * through the Aaspai importers and exports a machine-readable normalized
 * comparison result. The full §11 procedure also requires running the same
 * corpus through the pinned AI Observer Go binary:
 *
 *   cd study/ai-observer && go run ./cmd/server import claude-code --source <fixture-dir>
 *   ... export normalized result from the reference ...
 *   yarn tsx scripts/observer-differential.ts            # this script
 *   ... compare the two JSON files, classify differences ...
 *
 * Go is not installed in this environment, so the reference side is
 * recorded as `reference_result: null` (written decision, V-1).
 */

const FIXTURES = join(process.cwd(), "packages", "telemetry", "__tests__", "fixtures");
const ORG = "org_diff";

function canonicalizeLog(log: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: log.provider,
    sessionId: log.sessionId,
    observedAt: log.observedAt,
    eventName: log.eventName,
    body: log.body,
    severityText: log.severityText,
    role: (log.attributes as Record<string, unknown> | undefined)?.["message.role"],
    toolName: log.toolName,
  };
}

async function run(): Promise<void> {
  const report = {
    schemaVersion: 1,
    corpus: FIXTURES,
    generatedAt: new Date().toISOString(),
    reference_result: null,
    reference_required: "run the pinned Go reference against the same fixtures",
    fixtures: [] as unknown[],
  };

  const jobs: Array<[string, string, () => Promise<unknown>]> = [
    ["claude-code", "claude/sess_claude_fixture.jsonl", async () => new ClaudeParser({ organizationId: ORG }).parseFile(join(FIXTURES, "claude", "sess_claude_fixture.jsonl"))],
    ["codex_cli_rs", "codex/rollout-sess_fixture.jsonl", async () => new CodexParser({ organizationId: ORG }).parseFile(join(FIXTURES, "codex", "rollout-sess_fixture.jsonl"))],
    ["gemini_cli", "gemini/session-g_fixture.json", async () => new GeminiParser({ organizationId: ORG }).parseFile(join(FIXTURES, "gemini", "session-g_fixture.json"))],
  ];

  for (const [provider, rel, runParser] of jobs) {
    const result = await runParser() as {
      sessionId: string;
      logs: Array<Record<string, unknown>>;
      metrics: Array<{ name: string; metricType: string; value?: number | null }>;
      spans: unknown[];
      recordCount: number;
    };
    report.fixtures.push({
      provider,
      fixture: rel,
      sessionId: result.sessionId,
      recordCount: result.recordCount,
      logs: result.logs.map(canonicalizeLog),
      metrics: result.metrics.map((m) => ({
        name: m.name,
        metricType: m.metricType,
        value: m.value ?? null,
        type: (m as { attributes?: { type?: string } }).attributes?.type ?? null,
      })),
      spanCount: result.spans.length,
    });
  }

  mkdirSync(join(process.cwd(), ".aaspai"), { recursive: true });
  const out = resolve(process.cwd(), ".aaspai", "observer-differential-aaspai.json");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Aaspai comparison result written to ${out}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
