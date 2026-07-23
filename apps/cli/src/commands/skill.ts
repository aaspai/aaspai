import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillDirectory, loadSkillFile, writeSkillFile } from "@aaspai/skills";
import { Command } from "commander";
import pc from "picocolors";

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Skill operations");

  const root = () => process.env.AASPAI_SKILLS_DIR ?? "./skills";

  cmd
    .command("list")
    .description("List all registered skills")
    .action(async () => {
      const r = await loadSkillDirectory(root());
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
    .action(async (key: string) => {
      const s = (await loadSkillDirectory(root())).get(key);
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
      const skill = await loadSkillFile(path);
      const target = join(root(), skill.frontmatter.key);
      await mkdir(target, { recursive: true });
      await writeSkillFile(join(target, "SKILL.md"), skill.frontmatter);
      console.log(pc.green(`✓ Registered ${skill.frontmatter.key}@${skill.frontmatter.version}`));
    });

  return cmd;
}
