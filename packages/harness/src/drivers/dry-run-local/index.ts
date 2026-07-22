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
 *
 * For agents with role=ceo, the response is in-character as a chief
 * of staff — short, actionable, and pointing at the right CLI
 * command. This makes `aaspai chat ceo` feel useful end-to-end
 * before any LLM key is configured.
 */
function synthesizeResponse(prompt: string, systemPrompt: string, role: string): string {
  const trimmed = prompt.trim();

  // The adapter receives a composed prompt in the shape:
  //   <systemPrompt>\n\n---\n\n<userMessage>\n\n---\n\n<knowledge>
  // Extract just the user message (between the first and second
  // `\n\n---\n\n` separator) so keyword checks don't match against
  // the system prompt's example commands.
  const sep = "\n\n---\n\n";
  const firstSep = trimmed.indexOf(sep);
  let userMessage: string;
  if (firstSep >= 0) {
    const afterSystem = trimmed.slice(firstSep + sep.length);
    const secondSep = afterSystem.indexOf(sep);
    userMessage = (secondSep >= 0 ? afterSystem.slice(0, secondSep) : afterSystem).trim();
  } else {
    userMessage = trimmed;
  }

  // For chat history: extract the last "User:" block.
  const userBlockEnd = userMessage.lastIndexOf("User:\n");
  if (userBlockEnd >= 0) {
    const after = userMessage.slice(userBlockEnd + "User:\n".length);
    const nextAssistant = after.lastIndexOf("\n\nAssistant:");
    if (nextAssistant > 0) {
      userMessage = after.slice(0, nextAssistant).trim();
    } else {
      userMessage = after.trim();
    }
  }

  const lower = userMessage.toLowerCase();

  if (role === "ceo") {
    return synthesizeCeoResponse(userMessage, lower);
  }

  // Default plan response for non-CEO roles.
  const preview =
    userMessage.length > MAX_PREVIEW_CHARS
      ? `${userMessage.slice(0, MAX_PREVIEW_CHARS)}…`
      : userMessage;

  const verbs = ["review", "fix", "fixes", "triage", "draft", "scan", "check", "deploy", "merge"];
  const matchedVerb = verbs.find((v) => lower.includes(v)) ?? "triage";

  const hasSystem = systemPrompt.trim().length > 0;
  return [
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
    `- prompt: ${userMessage.length} chars`,
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
}

/**
 * CEO-style response. Recognizes a few common intents and gives
 * concise, actionable replies that point at the right CLI command.
 */
function synthesizeCeoResponse(message: string, lower: string): string {
  // First-turn greeting / what can you do
  if (
    lower.length === 0 ||
    lower === "hi" ||
    lower === "hello" ||
    lower === "hey" ||
    lower.includes("what can you do") ||
    lower.includes("who are you") ||
    lower.includes("help")
  ) {
    return [
      "Hey — I'm your **chief of staff** for this aaspai project.",
      "",
      "I can help you:",
      "  • **Hire** new employees (e.g. marketing, designer, qa)",
      "  • **Assign** work to existing agents",
      "  • **Report** on what's going on (sessions, recent work)",
      "",
      "Try: `hire a marketing manager who writes tweets` or `what is everyone working on?`",
      "",
      "_Note: this is the dry-run adapter. Switch to claude_local / opencode_cli when you're ready for a real LLM._",
    ].join("\n");
  }

  // Status / state queries
  if (
    lower.includes("what is going on") ||
    lower.includes("what's going on") ||
    lower.includes("what is everyone") ||
    lower.includes("what is happening") ||
    lower.includes("status") ||
    lower.includes("state")
  ) {
    return [
      "Right now, this is a fresh project. Run `aaspai state` to see session and wakeup history.",
      "",
      "To see the team, run `aaspai agent list`.",
    ].join("\n");
  }

  // Hiring
  if (
    lower.includes("hire") ||
    lower.includes("new employee") ||
    lower.includes("new agent") ||
    lower.includes("add a") ||
    lower.includes("create a") ||
    lower.includes("we need a")
  ) {
    // Try to extract a role name from the message
    const roleMatch =
      /(?:hire|create|add|need)\s+(?:a|an)\s+([a-z][a-z\s-]+?)(?:\s+who|\s+that|\s+for|\s+to|\.|$)/i.exec(
        message,
      );
    const roleName = roleMatch?.[1]?.trim() ?? "new-hire";
    const slug = roleName.toLowerCase().replace(/\s+/g, "-");
    const role = inferRole(roleName);
    return [
      `Sure. I'll create **${roleName}** (${role}) reporting to me.`,
      "",
      "```",
      `aaspai agent new agent/${slug} \\`,
      `  --title "${capitalize(roleName)}" \\`,
      `  --role ${role} \\`,
      `  --adapter dry_run_local \\`,
      `  --reports-to agent/ceo`,
      "```",
      "",
      "Run that, then `aaspai agent list` to see them. You can chat with them with `aaspai chat " +
        slug +
        "`.",
    ].join("\n");
  }

  // Assigning work
  if (
    lower.includes("assign") ||
    lower.includes("delegate") ||
    lower.includes("tell") ||
    lower.startsWith("ask ") ||
    lower.includes("have ")
  ) {
    return [
      "I'll route that to the right person. Pick an agent:",
      "",
      "  • `aaspai session start --agent agent/developer --prompt '...'` (code)",
      "  • `aaspai session start --agent agent/tester --prompt '...'` (tests)",
      "  • `aaspai session start --agent agent/operator --prompt '...'` (loops)",
      "",
      "Or just tell me: `assign this to developer: <your task>` and I'll write the command.",
    ].join("\n");
  }

  // Default
  return [
    `Got it: **${message.slice(0, 80)}${message.length > 80 ? "…" : ""}**`,
    "",
    "I can:",
    "  • hire new employees (try: `hire a marketing manager`)",
    "  • assign work (try: `assign this to developer: fix the login bug`)",
    "  • report state (try: `what is going on?`)",
  ].join("\n");
}

function inferRole(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("market") || n.includes("content") || n.includes("social")) return "cmo";
  if (n.includes("design") || n.includes("ux") || n.includes("ui")) return "designer";
  if (
    n.includes("engineer") ||
    n.includes("dev") ||
    n.includes("backend") ||
    n.includes("frontend")
  )
    return "engineer";
  if (n.includes("qa") || n.includes("test")) return "qa";
  if (n.includes("pm") || n.includes("product") || n.includes("manager")) return "pm";
  if (n.includes("data") || n.includes("analyst") || n.includes("research")) return "researcher";
  if (n.includes("devops") || n.includes("infra") || n.includes("sre")) return "devops";
  if (n.includes("security") || n.includes("sec")) return "security";
  if (n.includes("cfo") || n.includes("finance")) return "cfo";
  if (n.includes("cto")) return "cto";
  if (n.includes("ceo") || n.includes("chief")) return "ceo";
  return "general";
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
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
    const role =
      typeof ctx.context === "object" && ctx.context !== null && "role" in ctx.context
        ? String((ctx.context as { role: unknown }).role ?? "general")
        : "general";
    const response = synthesizeResponse(prompt, systemPrompt, role);

    const sessionId = shortId("dry");

    // Stream the response as a single assistant message via onLog so the
    // UI / session_events table see the same shape they'd see for a
    // real run.
    if (ctx.onLog) {
      await ctx.onLog(
        "stdout",
        JSON.stringify({
          kind: "assistant",
          ts: new Date().toISOString(),
          text: response,
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
      sessionParams: { dryRun: true, prompt, response, role },
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: estimateTokens(prompt) + estimateTokens(systemPrompt),
        outputTokens: estimateTokens(response),
      },
      usageBasis: "per_run",
      costUsd: 0,
      billingType: "free",
      provider: "aaspai",
      biller: "dry-run",
      model: "dry-run",
      // The full response — what the chat command reads.
      resultJson: { text: response, role, dryRun: true },
      summary: response.split("\n").slice(0, 3).join(" "),
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
