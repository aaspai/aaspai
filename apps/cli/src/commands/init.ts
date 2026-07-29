import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { pc, SCAFFOLD_TEMPLATES, shortPath, writeText } from "./_shared.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Scaffold a new aaspai project in the current directory")
    .action(async () => {
      const cwd = process.cwd();
      console.log(pc.cyan(`Scaffolding aaspai project in ${cwd}...`));
      await migrateLegacyLayout(cwd);

      const files: Array<[string, string]> = [
        [".aaspai/aaspai.config.ts", SCAFFOLD_TEMPLATES.CONFIG_TS],
        [".aaspai/AGENTS.md", SCAFFOLD_TEMPLATES.AGENTS_MD],
        [".aaspai/agents/_index.md", SCAFFOLD_TEMPLATES.AGENT_INDEX],
        [".aaspai/agents/ceo/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_CEO],
        [".aaspai/agents/ceo/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        [
          ".aaspai/agents/ceo/tools.yaml",
          "allow:\n  - Read\n  - ListSkills\n  - ListAgents\n  - AskUserQuestion\n  - Bash\ndeny:\n  - Write\n  - Edit\nrequire_approval_for:\n  - Bash\n",
        ],
        [".aaspai/agents/ceo/skills.lock.json", "[]\n"],
        [".aaspai/agents/ceo/relations.yaml", "reportsTo: null\nmanages: []\npeers: []\n"],
        [".aaspai/agents/operator/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_OPERATOR],
        [".aaspai/agents/operator/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        [".aaspai/agents/operator/skills.lock.json", "[]\n"],
        [".aaspai/agents/operator/relations.yaml", "reportsTo: null\n"],
        [".aaspai/agents/developer/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_DEVELOPER],
        [".aaspai/agents/developer/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        [".aaspai/agents/developer/skills.lock.json", "[]\n"],
        [".aaspai/agents/developer/relations.yaml", "reportsTo: agent/operator\n"],
        [".aaspai/agents/tester/AGENT.md", SCAFFOLD_TEMPLATES.AGENT_TESTER],
        [".aaspai/agents/tester/config.yaml", "adapterConfig: {}\nruntimeConfig: {}\n"],
        [".aaspai/agents/tester/skills.lock.json", "[]\n"],
        [".aaspai/agents/tester/relations.yaml", "reportsTo: agent/operator\n"],
        [".aaspai/knowledge/_index.md", SCAFFOLD_TEMPLATES.KNOWLEDGE_INDEX],
        [".aaspai/knowledge/company/mission.md", SCAFFOLD_TEMPLATES.KNOWLEDGE_MISSION],
        [".aaspai/loops/_index.md", SCAFFOLD_TEMPLATES.LOOPS_INDEX],
        [".aaspai/loops/daily-triage/LOOP.md", SCAFFOLD_TEMPLATES.LOOP_DAILY_TRIAGE],
        [".aaspai/loops/daily-triage/gate.yaml", SCAFFOLD_TEMPLATES.LOOP_GATE],
        [".aaspai/loops/daily-triage/budget.yaml", SCAFFOLD_TEMPLATES.LOOP_BUDGET],
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
        if (/^\.aaspai\/\s*$/m.test(existing)) {
          await writeText(
            gitignore,
            `${existing.replace(/^\.aaspai\/\s*$/m, "").trimEnd()}${SCAFFOLD_TEMPLATES.GITIGNORE_APPEND}`,
          );
          console.log(`  ${pc.green("+")} .gitignore (made definitions trackable)`);
        } else if (!existing.includes(".aaspai/state.db")) {
          await appendFile(gitignore, SCAFFOLD_TEMPLATES.GITIGNORE_APPEND);
          console.log(`  ${pc.green("+")} .gitignore (appended runtime ignores)`);
        }
      } else {
        await writeText(
          gitignore,
          `# aaspai runtime\n.aaspai/state.db\n.aaspai/state.db-journal\n.aaspai/state.db-wal\n.aaspai/state.db-shm\n.aaspai/views/\n.aaspai/events/\n.aaspai/tmp/\n`,
        );
        console.log(`  ${pc.green("+")} .gitignore`);
      }

      console.log("");
      console.log(pc.green(`✓ Created ${created} files (${skipped} already existed)`));

      // Run migrations automatically. `init` is the one command a new
      // user runs; it should leave the project ready to use.
      const { getDefaultDb, runMigrations } = await import("@aaspai/db");
      const handle = getDefaultDb();
      runMigrations(handle);
      console.log(`  ${pc.green("+")} .aaspai/state.db (migrations applied)`);

      console.log("");
      console.log("Next steps:");
      console.log(
        `  ${pc.cyan("aaspai chat ceo")}                            # talk to your chief of staff`,
      );
      console.log(
        `  ${pc.cyan("aaspai agent list")}                          # see the seeded agents`,
      );
      console.log(
        `  ${pc.cyan("aaspai state")}                               # one-screen dashboard`,
      );
      console.log(
        `  ${pc.cyan("aaspai start")}                               # start the scheduler daemon`,
      );
      console.log("");
    });
}

async function migrateLegacyLayout(cwd: string): Promise<void> {
  const moves = [
    ["aaspai.config.ts", ".aaspai/aaspai.config.ts"],
    ["aaspai.config.json", ".aaspai/aaspai.config.json"],
    ["AGENTS.md", ".aaspai/AGENTS.md"],
    ["agents", ".aaspai/agents"],
    ["knowledge", ".aaspai/knowledge"],
    ["loops", ".aaspai/loops"],
  ] as const;

  await mkdir(join(cwd, ".aaspai"), { recursive: true });
  for (const [from, to] of moves) {
    const source = join(cwd, from);
    if (!existsSync(source)) continue;
    const target = join(cwd, to);
    if (existsSync(target)) {
      console.log(`  ${pc.yellow("!")} kept ${from}; ${to} already exists`);
      continue;
    }
    await rename(source, target);
    console.log(`  ${pc.green("→")} ${from} -> ${to}`);
  }

  for (const config of [".aaspai/aaspai.config.ts", ".aaspai/aaspai.config.json"]) {
    const path = join(cwd, config);
    if (!existsSync(path)) continue;
    const current = await readFile(path, "utf8");
    const updated = current
      .replaceAll('"./agents"', '"./.aaspai/agents"')
      .replaceAll('"./knowledge"', '"./.aaspai/knowledge"')
      .replaceAll('"./loops"', '"./.aaspai/loops"')
      .replaceAll("'./agents'", "'./.aaspai/agents'")
      .replaceAll("'./knowledge'", "'./.aaspai/knowledge'")
      .replaceAll("'./loops'", "'./.aaspai/loops'");
    if (updated !== current) await writeText(path, updated);
  }
}
