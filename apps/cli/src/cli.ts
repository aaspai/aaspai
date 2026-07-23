#!/usr/bin/env node
/**
 * aaspai CLI — the user-facing surface.
 *
 * Subcommands: init, db, agent, knowledge, loop, session, skill, tool, state, start.
 *
 * Run `aaspai --help` for the full list.
 */
import { Command } from "commander";
import { agentCommand } from "./commands/agent.js";
import { chatCommand } from "./commands/chat.js";
import { dbCommand } from "./commands/db.js";
import { initCommand } from "./commands/init.js";
import { knowledgeCommand } from "./commands/knowledge.js";
import { loopCommand } from "./commands/loop.js";
import { providerCommand } from "./commands/provider.js";
import { sessionCommand } from "./commands/session.js";
import { skillCommand } from "./commands/skill.js";
import { startCommand } from "./commands/start.js";
import { stateCommand } from "./commands/state.js";
import { toolCommand } from "./commands/tool.js";

const program = new Command();
process.env.AASPAI_CLI_PATH ??= process.argv[1];

// Read the version from package.json so we don't have to keep this
// in sync with the version field at publish time. After esbuild
// bundles the CLI as CJS, `__dirname` points to the dist directory
// at runtime, so `../package.json` resolves to the package root.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pkgVersion = "0.0.0";
try {
  const candidates = [join(__dirname, "..", "package.json"), join(__dirname, "package.json")];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (pkg.version) {
        pkgVersion = pkg.version;
        break;
      }
    } catch {
      /* try next */
    }
  }
} catch {
  /* fall through with default */
}

program
  .name("aaspai")
  .version(pkgVersion)
  .option("--cwd <path>", "working directory", process.cwd())
  .option("--config <path>", "path to aaspai.config.ts", "./aaspai.config.ts")
  .option("--no-color", "disable colors")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ cwd?: string }>();
    if (opts.cwd) process.chdir(opts.cwd);
  });

program.addCommand(initCommand());
program.addCommand(dbCommand());
program.addCommand(agentCommand());
program.addCommand(chatCommand());
program.addCommand(knowledgeCommand());
program.addCommand(loopCommand());
program.addCommand(sessionCommand());
program.addCommand(skillCommand());
program.addCommand(toolCommand());
program.addCommand(providerCommand());
program.addCommand(stateCommand());
program.addCommand(startCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
