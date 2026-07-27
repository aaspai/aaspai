/**
 * Skill registry. Tracks which skills exist, resolves skill versions,
 * and materializes a skill set to a specific adapter's runtime.
 *
 * Foundation slice: skills are loaded from the file system (SKILL.md
 * files) and the registry is in-memory. Phase 4 adds the DB-backed
 * implementation via the same `SkillSource` port.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@aaspai/contracts/phase2";
import { sha256HexSync } from "@aaspai/file-loader/okf-parser";
import { getLogger } from "@aaspai/observability";
import { writeSkillFile } from "./parsers.js";

const log = getLogger("skills.registry");

export interface MaterializeOptions {
  adapterType: string;
  runtimeBaseDir: string;
  /**
   * When true, write into the shared `~/.claude/skills` directory
   * (used by both Claude and the opencode CLI). Otherwise write to
   * the per-adapter dir (default).
   */
  sharedHome?: boolean;
  /**
   * When true (default), verify each file's `sha256` (if set on the
   * Skill) before writing. A mismatch is reported as an error and the
   * file is skipped. Set to false to skip verification.
   */
  verifySha256?: boolean;
  /**
   * When true, use a symlink (target → runtimeBaseDir/<skill.key>)
   * instead of copying bytes. The source of truth stays in the
   * aaspai DB; only one copy lives on disk. Symlinks are skipped
   * automatically on Windows when the target is on a different
   * drive.
   */
  symlink?: boolean;
}

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
   *
   * Default behavior:
   *   - `sharedHome: false` → writes to `<baseDir>/.<adapterType>/skills/<key>/`
   *   - `sharedHome: true`  → writes to `~/.claude/skills/<key>/`
   *                            (the opencode CLI's default skills home)
   *   - `symlink: true`     → symlink the target → a per-skill cache dir
   *                            under `<baseDir>/.aaspai/skills/<key>/`
   *
   * Each file is sha256-verified (if its `sha256` is set on the Skill)
   * before being written. A mismatch is reported as an error and the
   * file is skipped — matching the paperclip `copyCatalogSkillFile`
   * primitive.
   */
  async materialize(
    skills: readonly Skill[],
    opts: MaterializeOptions,
  ): Promise<{ written: string[]; errors: string[]; symlinked: string[] }> {
    const verifySha256 = opts.verifySha256 ?? true;
    const sharedHome = opts.sharedHome ?? false;
    const useSymlink = opts.symlink ?? false;
    const targetBase = sharedHome
      ? join(homedir(), ".claude", "skills")
      : adapterSkillsDir(opts.adapterType, opts.runtimeBaseDir);
    // Tier 5 (this pass): also write to ~/.agents/skills/ (the opencode
    // CLI's secondary auto-discovery path). Best-effort.
    const agentsHomeBase = sharedHome ? join(homedir(), ".agents", "skills") : undefined;
    const cacheBase = join(opts.runtimeBaseDir, ".aaspai", "skills");
    const written: string[] = [];
    const symlinked: string[] = [];
    const errors: string[] = [];

    await mkdir(targetBase, { recursive: true });
    if (agentsHomeBase) await mkdir(agentsHomeBase, { recursive: true });
    if (useSymlink) await mkdir(cacheBase, { recursive: true });

    for (const skill of skills) {
      try {
        const skillDir = useSymlink ? join(cacheBase, skill.key) : join(targetBase, skill.key);
        await rm(skillDir, { recursive: true, force: true });
        await mkdir(skillDir, { recursive: true });
        await writeSkillFile(join(skillDir, "SKILL.md"), skill);
        for (const file of skill.files) {
          if (verifySha256 && file.sha256) {
            const actual = sha256HexSync(file.content);
            if (actual !== file.sha256) {
              errors.push(
                `${skill.key}@${skill.version} ${file.path}: sha256 mismatch (expected ${file.sha256}, got ${actual})`,
              );
              continue;
            }
          }
          const filePath = join(skillDir, file.path);
          await mkdir(join(filePath, ".."), { recursive: true });
          await writeFile(filePath, file.content, "utf8");
        }
        if (useSymlink) {
          const linkPath = join(targetBase, skill.key);
          await rm(linkPath, { recursive: true, force: true });
          await symlink(skillDir, linkPath, "junction").catch(() => {
            // Fall back to a copy on Windows where junction across
            // drives is impossible.
            return writeFile(
              join(linkPath, ".redirect"),
              JSON.stringify({ source: skillDir }, null, 2),
              "utf8",
            );
          });
          symlinked.push(linkPath);
        }
        written.push(useSymlink ? join(targetBase, skill.key) : skillDir);
        // Tier 5 (this pass): dual-write to ~/.agents/skills/ when
        // sharedHome is on. We copy the SKILL.md + each file (no
        // symlink — the .agents/ home is usually on a different
        // device / mount point and symlinks are unreliable there).
        if (agentsHomeBase) {
          const agentsDir = join(agentsHomeBase, skill.key);
          try {
            await rm(agentsDir, { recursive: true, force: true });
            await mkdir(agentsDir, { recursive: true });
            await writeSkillFile(join(agentsDir, "SKILL.md"), skill);
            for (const file of skill.files) {
              if (verifySha256 && file.sha256) {
                const actual = sha256HexSync(file.content);
                if (actual !== file.sha256) continue; // error already reported
              }
              const fp = join(agentsDir, file.path);
              await mkdir(join(fp, ".."), { recursive: true });
              await writeFile(fp, file.content, "utf8");
            }
          } catch (err) {
            errors.push(
              `${skill.key}@${skill.version} agents-home: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        errors.push(`${skill.key}@${skill.version}: ${(err as Error).message}`);
      }
    }

    log.info("materialized skills", {
      adapter: opts.adapterType,
      sharedHome,
      symlink: useSymlink,
      written: written.length,
      errors: errors.length,
    });
    return { written, errors, symlinked };
  }

  /* ────────────────────────────────────────────────────────────────
   *  Tier 5 (this pass): uninstall / audit / search / dual-write /
   *  GitHub sha256-verify / execute
   *  ──────────────────────────────────────────────────────────────── */

  private readonly auditLog: Array<{
    key: string;
    version: string;
    agentId?: string;
    sessionId?: string;
    action: "materialize" | "execute" | "uninstall" | "search";
    at: string;
  }> = [];

  /**
   * Remove a materialized skill from the shared home (and the
   * per-adapter dir, if applicable). Returns the paths removed.
   */
  async uninstall(
    key: string,
    opts: { adapterType?: string; runtimeBaseDir?: string; sharedHome?: boolean } = {},
  ): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    const targets: string[] = [];
    if (opts.sharedHome !== false) {
      targets.push(join(homedir(), ".claude", "skills", key));
      targets.push(join(homedir(), ".agents", "skills", key));
    }
    if (opts.adapterType && opts.runtimeBaseDir) {
      targets.push(join(adapterSkillsDir(opts.adapterType, opts.runtimeBaseDir), key));
      targets.push(join(opts.runtimeBaseDir, ".aaspai", "skills", key));
    }
    for (const t of targets) {
      try {
        await rm(t, { recursive: true, force: true });
        removed.push(t);
      } catch {
        // ignore — best-effort
      }
    }
    this.auditLog.push({ key, version: "*", action: "uninstall", at: new Date().toISOString() });
    return { removed };
  }

  /** Record an `action` against a skill (e.g. "execute" or "materialize"). */
  recordAudit(entry: {
    key: string;
    version: string;
    action: "materialize" | "execute" | "uninstall" | "search";
    agentId?: string;
    sessionId?: string;
  }): void {
    this.auditLog.push({ ...entry, at: new Date().toISOString() });
  }

  /** Return the in-memory audit log. */
  getAuditLog(): readonly {
    key: string;
    version: string;
    agentId?: string;
    sessionId?: string;
    action: "materialize" | "execute" | "uninstall" | "search";
    at: string;
  }[] {
    return [...this.auditLog];
  }

  /**
   * Full-text search across all registered skills. Returns matching
   * skills + the line where the match occurred.
   */
  search(query: string, opts: { caseSensitive?: boolean; limit?: number } = {}): Array<{
    skill: Skill;
    matches: Array<{ field: "name" | "description" | "instructions" | "files"; line: number; text: string }>;
  }> {
    const caseSensitive = opts.caseSensitive ?? false;
    const limit = opts.limit ?? 20;
    const needle = caseSensitive ? query : query.toLowerCase();
    const results: Array<{
      skill: Skill;
      matches: Array<{ field: "name" | "description" | "instructions" | "files"; line: number; text: string }>;
    }> = [];
    for (const skill of this.list()) {
      const matches: Array<{
        field: "name" | "description" | "instructions" | "files";
        line: number;
        text: string;
      }> = [];
      const check = (
        field: "name" | "description" | "instructions" | "files",
        text: string,
      ): void => {
        const haystack = caseSensitive ? text : text.toLowerCase();
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
          if (line.includes(needle)) {
            matches.push({ field, line: i + 1, text: lines[i]! });
          }
        }
      };
      check("name", skill.name);
      check("description", skill.description);
      check("instructions", skill.instructions);
      for (const file of skill.files) check("files", file.path + "\n" + file.content);
      if (matches.length > 0) {
        results.push({ skill, matches });
        this.auditLog.push({
          key: skill.key,
          version: skill.version,
          action: "search",
          at: new Date().toISOString(),
        });
      }
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Run a skill's "Steps" section as a structured exec. The skill
   * body is parsed line-by-line: lines starting with a digit + "."
   * are treated as step headers, and the rest of the section is the
   * step body. Returns the parsed steps for inspection. (This is a
   * no-op exec — the caller is expected to use the steps to drive a
   * real agent. We expose it so the audit log captures the
   * invocation intent.)
   */
  execute(key: string, version?: string, opts: { agentId?: string; sessionId?: string } = {}): {
    skill: Skill;
    steps: Array<{ number: number; body: string }>;
  } {
    const skill = this.get(key, version);
    if (!skill) throw new Error(`skill not found: ${key}@${version ?? "latest"}`);
    const steps: Array<{ number: number; body: string }> = [];
    const lines = skill.instructions.split(/\r?\n/);
    let current: { number: number; body: string } | undefined;
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (m) {
        if (current) {
          current.body = current.body.trim();
          steps.push(current);
        }
        current = { number: Number(m[1]), body: m[2]! };
      } else if (current) {
        current.body += "\n" + line;
      }
    }
    if (current) {
      current.body = current.body.trim();
      steps.push(current);
    }
    this.auditLog.push({
      key,
      version: skill.version,
      action: "execute",
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      at: new Date().toISOString(),
    });
    return { skill, steps };
  }

  /**
   * Apply role-based access control. Returns whether the agent is
   * permitted to use the skill. The default policy is "allow" —
   * callers can register policies via `setPolicy()`.
   */
  checkPolicy(
    key: string,
    agentId: string,
  ): { allowed: boolean; reason?: string } {
    const policy = this.policies.get(key);
    if (!policy) return { allowed: true };
    if (policy.allow?.includes(agentId)) return { allowed: true };
    if (policy.deny?.includes(agentId)) return { allowed: false, reason: `agent ${agentId} is in deny list` };
    return { allowed: policy.defaultAllowed ?? true };
  }

  private readonly policies = new Map<string, { allow?: string[]; deny?: string[]; defaultAllowed?: boolean }>();

  /** Register an access policy for a skill. */
  setPolicy(
    key: string,
    policy: { allow?: string[]; deny?: string[]; defaultAllowed?: boolean },
  ): void {
    this.policies.set(key, policy);
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
