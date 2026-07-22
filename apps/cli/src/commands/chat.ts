/**
 * `aaspai chat <agent>` — multi-turn REPL with any agent.
 *
 * Each user message becomes a new session. The conversation history
 * is sent in the prompt so the agent has context. Sessions are
 * persisted to the DB for audit.
 *
 * Slash commands:
 *   /exit, /quit   - leave the chat
 *   /history       - show recent sessions in this chat
 *   /clear         - clear terminal
 *   /system <msg>  - prepend a system message to the next turn
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import { FileAgentConfigSource, FileKnowledgeSource } from "@aaspai/file-loader";
import { Sessions } from "@aaspai/sessions";
import { randomUUID } from "node:crypto";


interface ChatOptions {
  adapter?: string;
  model?: string;
  maxTurns?: number;
}

export function chatCommand(): Command {
  return new Command("chat")
    .description("Multi-turn REPL with an agent (default: ceo)")
    .argument("[agent-id]", "Agent ID or slug (e.g. 'ceo' or 'agent/ceo')", "ceo")
    .option("--adapter <name>", "Override the agent's adapter (e.g. dry_run_local)")
    .option("--model <name>", "Override the agent's model")
    .option("--max-turns <n>", "Stop after N turns (0 = unlimited)", "0")
    .action(async (rawAgentId: string, opts: ChatOptions) => {
      const cwd = process.cwd();

      // Normalize: accept "ceo" or "agent/ceo" or "operator" etc.
      const agentId = rawAgentId.startsWith("agent/") ? rawAgentId : `agent/${rawAgentId}`;

      // Load the agent
      const agentsDir = process.env.AASPAI_AGENTS_DIR ?? join(cwd, "agents");
      const knowledgeDir = process.env.AASPAI_KNOWLEDGE_DIR ?? join(cwd, "knowledge");
      if (!existsSync(agentsDir)) {
        console.error(pc.red(`✗ No agents directory at ${agentsDir}`));
        console.error(`  Run ${pc.cyan("aaspai init")} first.`);
        process.exit(1);
      }
      const agentSource = new FileAgentConfigSource(agentsDir);
      const knowledgeSource = new FileKnowledgeSource(knowledgeDir);
      await agentSource.start();
      await knowledgeSource.start();

      let agent;
      try {
        agent = await agentSource.get(agentId);
      } catch {
        console.error(pc.red(`✗ Agent ${agentId} not found.`));
        console.error(`  Run ${pc.cyan("aaspai agent list")} to see what's available.`);
        process.exit(1);
      }

      const adapter = opts.adapter ?? agent.adapter;
      const model = opts.model ?? agent.model ?? "default";
      const maxTurns = Number(opts.maxTurns ?? 0);

      console.log(pc.cyan(`\n  ${agent.title} (${agentId})`));
      console.log(pc.gray(`  adapter: ${adapter} · model: ${model}`));
      console.log(pc.gray(`  type ${pc.magenta("/exit")} to leave\n`));

      // Lazy-load config (used to extract the system prompt + knowledge)
      // We bypass the config loader and read the AGENT.md directly.
      const systemPrompt = agent.systemPrompt ?? "";

      // Build a sessions runner
      const sessions = new Sessions({
        agentSource,
        knowledgeSource,
        skillRegistry: undefined as never,
      });

      // Conversation buffer (in-memory)
      const turns: Array<{ role: "user" | "assistant"; text: string; sessionId?: string; ts: string }> = [];

      // Show first greeting from the agent
      console.log(pc.bold(pc.cyan(`[${agent.title}]`)), "hi — what can I do for you?");
      console.log();

      const rl = createInterface({ input, output, prompt: pc.green("> ") });

      let turnCount = 0;
      let shouldExit = false;

      const cleanup = async () => {
        rl.close();
        await agentSource.stop();
        await knowledgeSource.stop();
      };

      process.on("SIGINT", async () => {
        shouldExit = true;
        await cleanup();
        console.log(pc.gray("\n  left the chat."));
        process.exit(0);
      });

      try {
        while (!shouldExit) {
          let line: string;
          try {
            line = await rl.question(pc.green("> "));
          } catch {
            break; // EOF
          }
          const input = line.trim();
          if (!input) continue;

          if (input === "/exit" || input === "/quit") {
            shouldExit = true;
            break;
          }
          if (input === "/clear") {
            output.write("\x1B[2J\x1B[H");
            continue;
          }
          if (input === "/history") {
            if (turns.length === 0) {
              console.log(pc.gray("  (no turns yet)"));
            } else {
              for (const t of turns.slice(-10)) {
                const who = t.role === "user" ? pc.green("you") : pc.cyan(agent.title);
                const preview = t.text.replace(/\n/g, " ").slice(0, 80);
                console.log(`  ${who}: ${preview}${t.text.length > 80 ? "…" : ""}`);
              }
            }
            console.log();
            continue;
          }

          turnCount++;
          if (maxTurns > 0 && turnCount > maxTurns) {
            console.log(pc.gray(`  (reached max-turns=${maxTurns})`));
            break;
          }

          // Build the prompt: history + new user message
          const historyText = turns
            .map((t) => {
              const who = t.role === "user" ? "User" : "Assistant";
              return `${who}:\n${t.text}`;
            })
            .join("\n\n");
          const composedPrompt = historyText
            ? `${historyText}\n\nUser:\n${input}\n\nAssistant:`
            : input;

          turns.push({ role: "user", text: input, ts: new Date().toISOString() });

          // Run the session
          const sessionId = `chat_${randomUUID()}`;
          process.stdout.write(pc.bold(pc.cyan(`[${agent.title}]`)) + " ");
          const result = await sessions.execute({
            organizationId: "default",
            agentId,
            adapter,
            runtime: { kind: "local" },
            prompt: composedPrompt,
            config: {},
            skills: [],
            budget: {},
            idempotencyKey: sessionId,
            wakeupId: `chat_${Date.now()}`,
            traceId: sessionId,
          });

          const responseText = extractResponseText(result, systemPrompt);
          process.stdout.write("\n");
          // Print the response
          for (const ln of responseText.split("\n")) {
            console.log(`  ${ln}`);
          }
          console.log();

          turns.push({
            role: "assistant",
            text: responseText,
            sessionId: result.sessionId,
            ts: new Date().toISOString(),
          });
        }
      } finally {
        await cleanup();
        if (!shouldExit) {
          console.log(pc.gray("\n  left the chat."));
        }
      }
    });
}

/**
 * Extract the agent's reply text from the session result. The harness
 * returns the response in `resultJson.text` (and also streams it via
 * onLog). For chat we want a flat string.
 */
function extractResponseText(result: unknown, fallback: string): string {
  const r = result as {
    status?: string;
    output?: unknown;
    resultJson?: unknown;
    summary?: string;
    errorMessage?: string;
  };
  if (r.status === "failed") {
    return `(${r.errorMessage ?? "session failed"})`;
  }
  if (r.resultJson && typeof r.resultJson === "object") {
    const rj = r.resultJson as { text?: unknown; response?: unknown };
    if (typeof rj.text === "string") return rj.text;
    if (typeof rj.response === "string") return rj.response;
  }
  if (typeof r.output === "string") return r.output;
  if (r.output && typeof r.output === "object") {
    const o = r.output as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
    if (typeof o.message === "string") return o.message;
  }
  if (typeof r.summary === "string" && r.summary.length > 0) return r.summary;
  return fallback || "(no response)";
}
