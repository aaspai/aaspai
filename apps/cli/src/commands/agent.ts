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
    .action(async (id: string) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = path.join(
        process.env.AASPAI_AGENTS_DIR ?? "./agents",
        id.replace(/^agent\//, ""),
      );
      await fs.mkdir(path.join(dir, "AGENT.md").slice(0, -8) || dir, { recursive: true });
      const template = `---
id: ${id}
type: Agent
title: "${id.replace(/^agent\//, "").replace(/-/g, " ")}"
description: TODO
timestamp: ${new Date().toISOString()}
adapter: claude_local
model: claude-sonnet-4-6
role: general
reportsTo: null
manages: []
peers: []
tools:
  allow: []
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include: ["**"]
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 50000 }
  perDay: { tokens: 500000, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# ${id}

Describe this agent's purpose here.
`;
      await fs.writeFile(path.join(dir, "AGENT.md"), template, "utf8");
      await fs.writeFile(path.join(dir, "config.yaml"), "adapterConfig: {}\n", "utf8");
      await fs.writeFile(
        path.join(dir, "tools.yaml"),
        "allow: []\ndeny: []\nrequire_approval_for: []\n",
        "utf8",
      );
      await fs.writeFile(path.join(dir, "skills.lock.json"), "[]\n", "utf8");
      await fs.writeFile(path.join(dir, "relations.yaml"), "reportsTo: null\n", "utf8");
      console.log(pc.green(`✓ Created ${dir}/`));
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
