import { Command } from "commander";
import { writeText, ensureDir, SCAFFOLD_TEMPLATES, pc, shortPath } from "./_shared.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";

export function initCommand(): Command {
  return new Command("init")
    .description("Scaffold a new aaspai project in the current directory")
    .action(async (opts) => {
      const cwd = process.cwd();
      console.log(pc.cyan(`Scaffolding aaspai project in ${cwd}...`));

      const files: Array<[string, string]> = [
        ["aaspai.config.ts", SCAFFOLD_TEMPLATES.CONFIG_TS],
        ["AGENTS.md", SCAFFOLD_TEMPLATES.AGENTS_MD],
        ["agents/_index.md", SCAFFOLD_TEMPLATES.AGENT_INDEX],
        ["agents/operator/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_OPERATOR],
        ["agents/operator/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        ["agents/operator/tools.yaml", "allow: []\ndeny: []\nrequire_approval_for: []\n"],
        ["agents/operator/skills.lock.json", "[]\n"],
        ["agents/operator/relations.yaml", "reportsTo: null\n"],
        ["agents/developer/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_DEVELOPER],
        ["agents/developer/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        ["agents/developer/tools.yaml", "allow: []\ndeny: []\nrequire_approval_for: []\n"],
        ["agents/developer/skills.lock.json", "[]\n"],
        ["agents/developer/relations.yaml", "reportsTo: agent/operator\n"],
        ["agents/tester/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_TESTER],
        ["agents/tester/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        ["agents/tester/tools.yaml", "allow: []\ndeny: []\nrequire_approval_for: []\n"],
        ["agents/tester/skills.lock.json", "[]\n"],
        ["agents/tester/relations.yaml", "reportsTo: agent/operator\n"],
        ["knowledge/_index.md", SCAFFOLD_TEMPLATES.KNOWLEDGE_INDEX],
        ["knowledge/company/mission.md", SCAFFOLD_TEMPLATES.KNOWLEDGE_MISSION],
        ["loops/_index.md", SCAFFOLD_TEMPLATES.LOOPS_INDEX],
        ["loops/daily-triage/LOOP.md", SCAFFOLD_TEMPLATES.LOOP_DAILY_TRIAGE],
        ["loops/daily-triage/gate.yaml", SCAFFOLD_TEMPLATES.LOOP_GATE],
        ["loops/daily-triage/budget.yaml", SCAFFOLD_TEMPLATES.LOOP_BUDGET],
        ["loops/daily-triage/schedule.yaml", "kind: cron\nexpression: \"0 8 * * 1-5\"\ntimezone: UTC\n"],
      ];

      let created = 0;
      let skipped = 0;
      for (const [rel, content] of files) {
        const path = join(cwd, rel);
        if (existsSync(path)) {
          skipped++;
          continue;
        }
        await writeText(path, content);
        created++;
        console.log(`  ${pc.green("+")} ${shortPath(path, cwd)}`);
      }

      // Append to .gitignore
      const gitignore = join(cwd, ".gitignore");
      if (existsSync(gitignore)) {
        const existing = await readFile(gitignore, "utf8");
        if (!existing.includes(".aaspai/state.db")) {
          await appendFile(gitignore, SCAFFOLD_TEMPLATES.GITIGNORE_APPEND);
          console.log(`  ${pc.green("+")} .gitignore (appended runtime ignores)`);
        }
      } else {
        await writeText(gitignore, `# aaspai runtime\n.aaspai/state.db\n.aaspai/state.db-journal\n.aaspai/state.db-wal\n.aaspai/state.db-shm\n.aaspai/views/\n.aaspai/events/\n.aaspai/tmp/\n`);
        console.log(`  ${pc.green("+")} .gitignore`);
      }

      console.log("");
      console.log(pc.green(`✓ Created ${created} files (${skipped} already existed)`));
      console.log("");
      console.log("Next steps:");
      console.log(`  ${pc.cyan("yarn dev")}                  # start the aaspai daemon`);
      console.log(`  ${pc.cyan("aaspai agent list")}        # see the seeded agents`);
      console.log(`  ${pc.cyan("aaspai loop list")}         # see the seeded loops`);
      console.log(`  ${pc.cyan("aaspai session start --agent agent/operator --prompt 'hello'")}`);
      console.log("");
    });
}
