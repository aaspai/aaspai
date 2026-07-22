import { type CompositeAgentConfigSource, FileAgentConfigSource } from "@aaspai/file-loader";
import { Command } from "commander";
import pc from "picocolors";

export function agentCommand(): Command {
  const cmd = new Command("agent").description("Agent operations");

  function source(): FileAgentConfigSource | CompositeAgentConfigSource {
    const agentsDir = process.env.AASPAI_AGENTS_DIR ?? "./agents";
    return new FileAgentConfigSource(agentsDir);
  }

  cmd
    .command("list")
    .description("List all agents")
    .action(async () => {
      const s = source();
      if (s instanceof FileAgentConfigSource) await s.start();
      else s.start();
      try {
        const ids = await s.list();
        if (ids.length === 0) {
          console.log(pc.yellow("No agents found. Run `aaspai init` to scaffold the project."));
          return;
        }
        console.log(pc.cyan("Agents"));
        for (const id of ids) {
          const cfg = await s.get(id);
          console.log(
            `  ${id.padEnd(28)} ${pc.gray(`adapter=${cfg.adapter}, role=${cfg.role}, model=${cfg.model ?? "default"}`)}`,
          );
        }
      } finally {
        if (s instanceof FileAgentConfigSource) await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("show <id>")
    .description("Show the agent's AGENT.md")
    .action(async (id: string) => {
      const s = source();
      if (s instanceof FileAgentConfigSource) await s.start();
      else s.start();
      try {
        const cfg = await s.get(id);
        console.log(pc.cyan(`# ${cfg.title}`));
        console.log(pc.gray(`id: ${cfg.id}`));
        console.log(
          pc.gray(`adapter: ${cfg.adapter}  model: ${cfg.model ?? "default"}  role: ${cfg.role}`),
        );
        console.log(
          pc.gray(`reportsTo: ${cfg.reportsTo ?? "(root)"}  manages: [${cfg.manages.join(", ")}]`),
        );
        console.log("");
        console.log(pc.gray("--- system prompt ---"));
        console.log(cfg.systemPrompt);
      } finally {
        if (s instanceof FileAgentConfigSource) await s.stop();
        process.exit(0);
      }
    });

  cmd
    .command("describe <id>")
    .description("Show where the agent's config lives")
    .action(async (id: string) => {
      const s = source();
      const desc = s.describe();
      console.log(pc.cyan("Agent source"));
      console.log(`  kind:  ${desc.kind}`);
      console.log(`  label: ${desc.label}`);
      if (await s.has(id)) {
        console.log(`  ${pc.green("✓")} ${id} is loaded`);
      } else {
        console.log(`  ${pc.red("✗")} ${id} not found`);
      }
      process.exit(0);
    });

  cmd
    .command("new <id>")
    .description("Scaffold a new agent directory")
    .option("-t, --title <title>", "Display title (e.g. 'Marketing Manager')")
    .option("-r, --role <role>", "Role: ceo|cto|cmo|cfo|engineer|designer|pm|qa|devops|researcher|operator|general", "general")
    .option("-a, --adapter <adapter>", "Adapter (e.g. dry_run_local, claude_local, opencode_cli)", "dry_run_local")
    .option("-m, --model <model>", "Model identifier (depends on adapter)")
    .option("--reports-to <agentId>", "Who this agent reports to (e.g. agent/ceo)")
    .option("--manages <ids>", "Comma-separated list of agents this one manages")
    .option("-d, --description <text>", "One-line description of the agent's role")
    .action(async (id: string, opts: {
      title?: string;
      role?: string;
      adapter?: string;
      model?: string;
      reportsTo?: string;
      manages?: string;
      description?: string;
    }) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const slug = id.replace(/^agent\//, "");
      const dir = path.join(
        process.env.AASPAI_AGENTS_DIR ?? "./agents",
        slug,
      );
      await fs.mkdir(dir, { recursive: true });
      const title = opts.title ?? slug.replace(/-/g, " ");
      const manages = (opts.manages ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const description = opts.description ?? `${title} on the team.`;
      const template = `---
id: ${id}
type: Agent
title: "${title}"
description: >
  ${description}
timestamp: ${new Date().toISOString()}
adapter: ${opts.adapter ?? "dry_run_local"}
model: ${opts.model ?? "aaspai-dryrun"}
role: ${opts.role ?? "general"}
reportsTo: ${opts.reportsTo ? opts.reportsTo : "null"}
manages:
${manages.map((m) => `  - ${m}`).join("\n")}
peers: []
tools:
  allow:
    - Read
    - ListSkills
    - ListAgents
    - AskUserQuestion
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 50000, costUsd: 0.00 }
  perDay: { tokens: 500000, costUsd: 0.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# ${title}

You are the **${title}**. You report to ${opts.reportsTo ?? "(the ceo)"}.

## Your role

${description}

## Voice

- Be concise. 3–5 lines per reply.
- Use plain language, no jargon.
- Always end with a clear next step.

## What you do

(Pending: define this in conversation with the ceo.)
`;
      await fs.writeFile(path.join(dir, "AGENT.md"), template, "utf8");
      await fs.writeFile(path.join(dir, "config.yaml"), "adapterConfig: {}\nruntimeConfig: {}\n", "utf8");
      await fs.writeFile(
        path.join(dir, "tools.yaml"),
        "allow: []\ndeny: []\nrequire_approval_for: []\n",
        "utf8",
      );
      await fs.writeFile(path.join(dir, "skills.lock.json"), "[]\n", "utf8");
      await fs.writeFile(
        path.join(dir, "relations.yaml"),
        `reportsTo: ${opts.reportsTo ?? "null"}\n`,
        "utf8",
      );
      console.log(pc.green(`✓ Created ${dir}/`));
      console.log("");
      console.log(pc.gray(`  id:        ${id}`));
      console.log(pc.gray(`  adapter:   ${opts.adapter ?? "dry_run_local"}`));
      console.log(pc.gray(`  model:     ${opts.model ?? "aaspai-dryrun"}`));
      console.log(pc.gray(`  role:      ${opts.role ?? "general"}`));
      console.log(pc.gray(`  reportsTo: ${opts.reportsTo ?? "(root)"}`));
      if (manages.length > 0) {
        console.log(pc.gray(`  manages:   ${manages.join(", ")}`));
      }
      console.log("");
      console.log(`Next: ${pc.cyan(`aaspai chat ${id}`)} to talk to the new hire.`);
      process.exit(0);
    });

  cmd
    .command("validate")
    .description("Validate all agents")
    .action(async () => {
      const s = source();
      if (s instanceof FileAgentConfigSource) await s.start();
      else s.start();
      try {
        const ids = await s.list();
        let ok = 0;
        for (const id of ids) {
          try {
            await s.get(id);
            ok++;
          } catch (err) {
            console.log(`  ${pc.red("✗")} ${id}: ${(err as Error).message}`);
          }
        }
        console.log(pc.green(`✓ ${ok}/${ids.length} agents valid`));
      } finally {
        if (s instanceof FileAgentConfigSource) await s.stop();
        process.exit(0);
      }
    });

  return cmd;
}
