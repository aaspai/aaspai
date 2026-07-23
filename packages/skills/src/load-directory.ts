import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillFile } from "./parsers.js";
import { SkillRegistry } from "./registry.js";

export async function loadSkillDirectory(root: string): Promise<SkillRegistry> {
  const registry = new SkillRegistry();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkillFile(join(root, entry.name, "SKILL.md")).catch(() => null);
    if (skill) registry.register(skill.frontmatter);
  }
  return registry;
}
