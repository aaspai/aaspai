import { createBuiltInRegistry } from "@aaspai/tools";
import { Command } from "commander";
import pc from "picocolors";

export function toolCommand(): Command {
  const cmd = new Command("tool").description("Tool operations");

  function registry() {
    return createBuiltInRegistry();
  }

  cmd
    .command("list")
    .description("List all registered tools")
    .action(() => {
      const r = registry();
      console.log(pc.cyan(`Tools (${r.list().length} built-in)`));
      for (const t of r.list()) {
        console.log(
          `  ${t.name.padEnd(20)} ${pc.gray(`[${t.risk}] ${t.description.slice(0, 70)}`)}`,
        );
      }
    });

  cmd
    .command("show <name>")
    .description("Show tool schema")
    .action((name: string) => {
      const t = registry().get(name);
      if (!t) {
        console.log(pc.red(`✗ Tool ${name} not found`));
        process.exit(3);
      }
      console.log(pc.cyan(`# ${t.name}`));
      console.log(`  risk:        ${t.risk}`);
      console.log(`  description: ${t.description}`);
      console.log(`  input:       ${JSON.stringify(t.inputSchema, null, 2)}`);
    });

  return cmd;
}
