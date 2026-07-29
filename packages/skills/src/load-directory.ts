import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { type Skill, skillSchema } from "@aaspai/contracts/phase2";
import { sha256HexSync } from "@aaspai/file-loader/okf-parser";
import { classifySkillFilePath, loadSkillFile } from "./parsers.js";
import { SkillRegistry } from "./registry.js";

export async function loadSkillDirectory(root: string): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  for (const entrypoint of await findSkillFiles(root)) {
    const parsed = await loadSkillFile(entrypoint);
    const skillDir = dirname(entrypoint);
    const files: Skill["files"] = [];
    for (const path of await findFiles(skillDir)) {
      const rel = relative(skillDir, path).replace(/\\/g, "/");
      if (rel === "SKILL.md") continue;
      const content = await readFile(path, "utf8");
      files.push({
        path: rel,
        content,
        kind: classifySkillFilePath(rel),
        sha256: sha256HexSync(content),
      });
    }
    const skill = skillSchema.parse({
      ...parsed.frontmatter,
      key: parsed.frontmatter.key === "SKILL" ? basename(skillDir) : parsed.frontmatter.key,
      files,
    });
    if (registry.has(skill.key))
      throw new Error(`Duplicate skill key "${skill.key}" at ${entrypoint}`);
    registry.register(skill);
  }
  return registry;
}

async function findSkillFiles(root: string): Promise<string[]> {
  return (await findFiles(root)).filter((path) => basename(path).toLowerCase() === "skill.md");
}

async function findFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
