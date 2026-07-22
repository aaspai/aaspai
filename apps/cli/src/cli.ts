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
import { dbCommand } from "./commands/db.js";
import { initCommand } from "./commands/init.js";
import { knowledgeCommand } from "./commands/knowledge.js";
import { loopCommand } from "./commands/loop.js";
import { sessionCommand } from "./commands/session.js";
import { skillCommand } from "./commands/skill.js";
import { startCommand } from "./commands/start.js";
import { stateCommand } from "./commands/state.js";
import { toolCommand } from "./commands/tool.js";

const program = new Command();

program
  .name("aaspai")
  .description("aaspai — control plane for AI agent workforces")
  .version("0.1.0")
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
program.addCommand(knowledgeCommand());
program.addCommand(loopCommand());
program.addCommand(sessionCommand());
program.addCommand(skillCommand());
program.addCommand(toolCommand());
program.addCommand(stateCommand());
program.addCommand(startCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
