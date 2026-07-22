import { randomBytes } from "node:crypto";
import type { ServerAdapterModule } from "@aaspai/contracts/harness";
import { HARNESS_PROTOCOL_VERSION } from "@aaspai/contracts/harness";

const SHORT_ID_LEN = 8;

function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(SHORT_ID_LEN).toString("hex").slice(0, SHORT_ID_LEN)}`;
}

function estimateTokens(text: string): number {
  // Foundation: 1 token ≈ 4 characters. Real tokenizers differ but this
  // is good enough for accounting purposes.
  return Math.ceil(text.length / 4);
}

const MAX_PREVIEW_CHARS = 400;

/**
 * Build a deterministic "plan" from the prompt. The dry-run adapter
 * exists to validate the orchestration end-to-end (sessions, skills,
 * knowledge, loop, scheduler, DB, CLI) without requiring any LLM API
 * key. When real keys arrive, the operator agent's `adapter:` is
 * changed from `dry_run_local` to `claude_local` — the rest of the
 * stack doesn't change.
 */
function synthesizePlan(prompt: string, systemPrompt: string): string {
  const trimmed = prompt.trim();
  const preview =
    trimmed.length > MAX_PREVIEW_CHARS ? `${trimmed.slice(0, MAX_PREVIEW_CHARS)}…` : trimmed;

  const verbs = ["review", "fix", "fixes", "triage", "draft", "scan", "check", "deploy", "merge"];
  const lower = trimmed.toLowerCase();
  const matchedVerb = verbs.find((v) => lower.includes(v)) ?? "triage";

  const hasSystem = systemPrompt.trim().length > 0;
  const plan = [
    `# Plan (dry-run)`,
    "",
    `Action: ${matchedVerb}`,
    "",
    "## Prompt",
    "```",
    preview,
    "```",
    "",
    `## Context`,
    `- system prompt: ${hasSystem ? `${systemPrompt.length} chars` : "(empty)"}`,
    `- prompt: ${trimmed.length} chars`,
    "",
    "## Suggested next steps",
    "1. Read the relevant knowledge (via skills:read).",
    "2. Decide whether the action is safe to auto-apply.",
    "3. Either: emit a `report` decision (defer to a human),",
    "   or: emit an `act` decision (delegate to the right worker).",
    "4. Update STATE.md with the outcome.",
    "",
    "_This is a foundation dry-run. Swap the operator's `adapter:` to `claude_local` once keys are available._",
  ].join("\n");
  return plan;
}

export const dryRunLocal: ServerAdapterModule = {
  info: {
    type: "dry_run_local",
    label: "Dry Run (Local)",
    transport: "local_subprocess",
    models: [{ id: "dry-run", label: "Dry Run" }],
    agentConfigurationDoc:
      "Deterministic, no-API-key adapter. Returns a synthesized plan from the prompt. Use this for local development and end-to-end tests until you have an API key. Flip the operator's `adapter:` to `claude_local` (or another real adapter) when ready.",
    status: "ready",
  },
  async execute(ctx) {
    const prompt =
      typeof ctx.context === "object" && ctx.context !== null && "prompt" in ctx.context
        ? String((ctx.context as { prompt: unknown }).prompt ?? "")
        : "";
    const systemPrompt =
      typeof ctx.context === "object" && ctx.context !== null && "systemPrompt" in ctx.context
        ? String((ctx.context as { systemPrompt: unknown }).systemPrompt ?? "")
        : "";
    const plan = synthesizePlan(prompt, systemPrompt);

    const sessionId = shortId("dry");

    // Stream the plan as a single assistant message via onLog so the
    // UI / session_events table see the same shape they'd see for a
    // real run.
    if (ctx.onLog) {
      await ctx.onLog(
        "stdout",
        JSON.stringify({
          kind: "assistant",
          ts: new Date().toISOString(),
          text: plan,
        }) + "\n",
      );
    }
    if (ctx.onMeta) {
      await ctx.onMeta({ adapter: "dry_run_local", model: "dry-run", provider: "aaspai" });
    }

    return {
      protocolVersion: HARNESS_PROTOCOL_VERSION,
      sessionId,
      sessionDisplayId: sessionId.slice(0, SHORT_ID_LEN + 4),
      sessionParams: { dryRun: true, prompt, plan },
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: estimateTokens(prompt) + estimateTokens(systemPrompt),
        outputTokens: estimateTokens(plan),
      },
      usageBasis: "per_run",
      costUsd: 0,
      billingType: "free",
      provider: "aaspai",
      biller: "dry-run",
      model: "dry-run",
      summary: plan.split("\n").slice(0, 3).join(" "),
      clearSession: false,
    };
  },
  async testEnvironment() {
    return {
      ok: true,
      checks: [
        { name: "dry-run", level: "info", message: "always available (no API key required)" },
      ],
    };
  },
};

export const dryRunLocalInfo = dryRunLocal.info;
