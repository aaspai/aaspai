/**
 * Skill registry. Tracks which skills exist, resolves skill versions,
 * and materializes a skill set to a specific adapter's runtime.
 *
 * Foundation slice: skills are loaded from the file system (SKILL.md
 * files) and the registry is in-memory. Phase 4 adds the DB-backed
 * implementation via the same `SkillSource` port.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "@aaspai/contracts/phase2";
import { getLogger } from "@aaspai/observability";
import { parseSkillFile, writeSkillFile } from "./parsers.js";

const log = getLogger("skills.registry");

export class SkillRegistry {
  private readonly byKey = new Map<string, Skill>();
  private readonly byKeyVersion = new Map<string, Map<string, Skill>>();

  register(skill: Skill): void {
    this.byKey.set(skill.key, skill);
    const versions = this.byKeyVersion.get(skill.key) ?? new Map();
    versions.set(skill.version, skill);
    this.byKeyVersion.set(skill.key, versions);
  }

  unregister(key: string, version?: string): void {
    if (version) {
      this.byKeyVersion.get(key)?.delete(version);
    } else {
      this.byKeyVersion.delete(key);
      this.byKey.delete(key);
    }
  }

  get(key: string, version?: string): Skill | null {
    if (version) {
      return this.byKeyVersion.get(key)?.get(version) ?? null;
    }
    return this.byKey.get(key) ?? null;
  }

  has(key: string, version?: string): boolean {
    return this.get(key, version) !== null;
  }

  list(): readonly Skill[] {
    return [...this.byKey.values()];
  }

  /**
   * Select skills for an agent prompt. Simple substring match on
   * description + name. Phase 4 upgrades to embedding-based selection.
   */
  selectFor(prompt: string, opts: { maxSkills?: number } = {}): Skill[] {
    const maxSkills = opts.maxSkills ?? 10;
    const p = prompt.toLowerCase();
    const scored: Array<{ score: number; skill: Skill }> = [];
    for (const skill of this.byKey.values()) {
      let score = 0;
      if (skill.name.toLowerCase().includes(p)) score += 5;
      if (skill.description.toLowerCase().includes(p)) score += 3;
      for (const tag of skill.adapterTypes as string[])
        if (tag.toLowerCase().includes(p)) score += 1;
      if (score > 0) scored.push({ score, skill });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxSkills).map((s) => s.skill);
  }

  /**
   * Materialize a set of skills to a specific adapter's runtime.
   * Returns the list of paths that were written.
   */
  async materialize(
    skills: readonly Skill[],
    opts: { adapterType: string; runtimeBaseDir: string },
  ): Promise<{ written: string[]; errors: string[] }> {
    const target = adapterSkillsDir(opts.adapterType, opts.runtimeBaseDir);
    const written: string[] = [];
    const errors: string[] = [];

    for (const skill of skills) {
      try {
        await mkdir(target, { recursive: true });
        const skillDir = join(target, skill.key);
        await rm(skillDir, { recursive: true, force: true });
        await mkdir(skillDir, { recursive: true });
        await writeSkillFile(join(skillDir, "SKILL.md"), skill);
        for (const file of skill.files) {
          const filePath = join(skillDir, file.path);
          await mkdir(join(filePath, ".."), { recursive: true });
          await writeFile(filePath, file.content, "utf8");
        }
        written.push(skillDir);
      } catch (err) {
        errors.push(`${skill.key}@${skill.version}: ${(err as Error).message}`);
      }
    }

    log.info("materialized skills", {
      adapter: opts.adapterType,
      written: written.length,
      errors: errors.length,
    });
    return { written, errors };
  }
}

function adapterSkillsDir(adapterType: string, baseDir: string): string {
  // Foundation: per-adapter directory mapping
  const map: Record<string, string> = {
    claude_local: ".claude/skills",
    codex_local: ".codex/skills",
    cursor_local: ".cursor/skills",
    openclaw_gateway: ".openclaw/skills",
    hermes_gateway: ".hermes/skills",
  };
  const rel = map[adapterType] ?? `.${adapterType}/skills`;
  return join(baseDir, rel);
}
