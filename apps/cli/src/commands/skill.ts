import { SkillRegistry } from "@aaspai/skills";
import { Command } from "commander";
import pc from "picocolors";

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Skill operations");

  function registry(): SkillRegistry {
    return new SkillRegistry();
  }

  cmd
    .command("list")
    .description("List all registered skills")
    .action(() => {
      const r = registry();
      const skills = r.list();
      if (skills.length === 0) {
        console.log(
          pc.yellow("No skills registered. Use `aaspai skill register <path>` to add one."),
        );
        return;
      }
      console.log(pc.cyan(`Skills (${skills.length})`));
      for (const s of skills) {
        console.log(`  ${s.key}@${s.version.padEnd(8)} ${pc.gray(s.description.slice(0, 80))}`);
      }
    });

  cmd
    .command("show <key>")
    .description("Show skill definition")
    .action((key: string) => {
      const s = registry().get(key);
      if (!s) {
        console.log(pc.red(`✗ Skill ${key} not found`));
        process.exit(3);
      }
      console.log(pc.cyan(`# ${s.name}`));
      console.log(pc.gray(`key: ${s.key}  version: ${s.version}  owner: ${s.owner}`));
      console.log("");
      console.log(s.instructions);
    });

  cmd
    .command("register <path>")
    .description("Register a SKILL.md file")
    .action(async (path: string) => {
      const { loadSkillFile } = await import("@aaspai/skills");
      const skill = await loadSkillFile(path);
      registry().register(skill.frontmatter);
      console.log(pc.green(`✓ Registered ${skill.frontmatter.key}@${skill.frontmatter.version}`));
    });

  return cmd;
}
