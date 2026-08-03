/**
 * Skill catalog — a paperclip-style "bundled + optional" skill registry
 * that lives on disk. Walks a `catalog/{bundled,optional}/<category>/<slug>/`
 * tree, parses each `SKILL.md` (or `catalog-ref.json` for GitHub-pinned
 * skills), and registers everything into a `SkillRegistry`.
 *
 * The catalog format mirrors `@paperclipai/skills-catalog` closely
 * enough that the same JSON manifest can be consumed by either
 * system, but the runtime source of truth here is the on-disk
 * `SKILL.md` (with frontmatter) — no build step is required.
 *
 * Layout:
 *   catalog/
 *     bundled/
 *       <category>/
 *         <slug>/
 *           SKILL.md
 *           references/   (optional)
 *           scripts/      (optional)
 *           assets/       (optional)
 *     optional/
 *       <category>/
 *         <slug>/
 *           catalog-ref.json     ← alternative to SKILL.md, for
 *                                   GitHub-pinned skills. The file
 *                                   body is fetched on first access.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

const fs = { existsSync, readFileSync, statSync };

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Skill } from "@aaspai/contracts/phase2";
import { sha256HexSync } from "@aaspai/file-loader/okf-parser";
import { getLogger } from "@aaspai/observability";
import { classifySkillFilePath, loadSkillFile, parseSkillFile } from "./parsers.js";
import type { SkillRegistry } from "./registry.js";

const log = getLogger("skills.catalog");

/** Where a skill came from. */
export type CatalogSkillSource =
  | { type: "local"; baseDir: string; relPath: string }
  | {
      type: "github";
      hostname: string;
      owner: string;
      repo: string;
      ref: string;
      commit: string;
      path: string;
    };

/** A single entry in the catalog (paperclip-compatible). */
export interface CatalogSkill {
  id: string; // "<kind>:<category>:<slug>"
  key: string; // "<kind>/<category>/<slug>"
  kind: "bundled" | "optional";
  category: string;
  slug: string;
  name: string;
  description: string;
  relPath: string; // POSIX path under baseDir
  entrypoint: "SKILL.md";
  trustLevel: "markdown_only" | "assets" | "scripts_executables";
  defaultInstall: boolean;
  recommendedForRoles: string[];
  requires: string[];
  tags: string[];
  files: Array<{
    path: string;
    kind: Skill["files"][number]["kind"];
    sizeBytes: number;
    sha256: string;
  }>;
  contentHash: string;
  source: CatalogSkillSource;
}

export interface CatalogManifest {
  schemaVersion: 1;
  generatedAt: string;
  baseDir: string;
  skills: CatalogSkill[];
}

/** Reference descriptor for a GitHub-pinned skill. */
export interface CatalogRefJson {
  source: {
    type: "github";
    hostname?: string;
    owner: string;
    repo: string;
    ref: string;
    commit: string;
    path: string;
  };
  files?: string[];
  defaultInstall?: boolean;
  recommendedForRoles?: string[];
  requires?: string[];
  tags?: string[];
}

export interface BuildOptions {
  /** When true, return the manifest instead of mutating the registry. */
  manifestOnly?: boolean;
  /** If set, also fetch GitHub-pinned skills' file inventory. */
  fetchGithub?: boolean;
}

/**
 * Walk a `catalog/` directory and produce a `CatalogManifest` (and
 * optionally populate a `SkillRegistry`).
 *
 * The walker is symlink-aware: no broken symlinks, no symlinks that
 * escape the catalog root, no directory symlinks. This prevents a
 * malicious catalog from writing outside its tree.
 */
export class SkillCatalog {
  private readonly byId = new Map<string, CatalogSkill>();
  private readonly byKey = new Map<string, CatalogSkill>();
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir.replace(/[\\/]+$/, "");
  }

  /** Load the catalog from disk. */
  static async load(
    baseDir: string,
    opts: BuildOptions = {},
  ): Promise<{
    catalog: SkillCatalog;
    manifest: CatalogManifest;
    errors: string[];
  }> {
    const catalog = new SkillCatalog(baseDir);
    const errors: string[] = [];
    const skills: CatalogSkill[] = [];

    for (const kind of ["bundled", "optional"] as const) {
      const kindDir = join(baseDir, "catalog", kind);
      if (!existsSync(kindDir)) continue;
      const categories = await readdir(kindDir, { withFileTypes: true }).catch(() => []);
      for (const catEntry of categories) {
        if (!catEntry.isDirectory() || catEntry.isSymbolicLink()) continue;
        const category = catEntry.name;
        const categoryDir = join(kindDir, category);
        const slugs = await readdir(categoryDir, { withFileTypes: true }).catch(() => []);
        for (const slugEntry of slugs) {
          if (!slugEntry.isDirectory() || slugEntry.isSymbolicLink()) continue;
          const slug = slugEntry.name;
          const skillDir = join(categoryDir, slug);
          try {
            const skill = await catalog.loadOneFromDisk(skillDir, kind, category, slug);
            skills.push(skill);
            catalog.byId.set(skill.id, skill);
            catalog.byKey.set(skill.key, skill);
          } catch (err) {
            errors.push(`${kind}/${category}/${slug}: ${(err as Error).message}`);
          }
        }
      }
    }

    skills.sort((a, b) => a.id.localeCompare(b.id));
    const manifest: CatalogManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      baseDir: catalog.baseDir,
      skills,
    };

    if (!opts.manifestOnly) {
      for (const skill of skills) {
        try {
          const reg = await catalog.toSkill(skill, opts.fetchGithub ?? false);
          catalog.builtSkills.set(skill.id, reg);
        } catch (err) {
          errors.push(`${skill.id}: ${(err as Error).message}`);
        }
      }
    }

    return { catalog, manifest, errors };
  }

  private readonly builtSkills = new Map<string, Skill>();

  private async loadOneFromDisk(
    skillDir: string,
    kind: "bundled" | "optional",
    category: string,
    slug: string,
  ): Promise<CatalogSkill> {
    const skillMd = join(skillDir, "SKILL.md");
    const refJson = join(skillDir, "catalog-ref.json");
    const hasMd = existsSync(skillMd);
    const hasRef = existsSync(refJson);
    if (hasMd && hasRef) {
      throw new Error("contains both SKILL.md and catalog-ref.json");
    }
    if (!hasMd && !hasRef) {
      throw new Error("missing SKILL.md and catalog-ref.json");
    }
    const relPath = `${kind}/${category}/${slug}`;
    if (hasRef) {
      return this.loadRefJson(skillDir, refJson, kind, category, slug, relPath);
    }
    return this.loadSkillMd(skillDir, skillMd, kind, category, slug, relPath);
  }

  private async loadSkillMd(
    skillDir: string,
    skillMd: string,
    kind: "bundled" | "optional",
    category: string,
    slug: string,
    relPath: string,
  ): Promise<CatalogSkill> {
    const parsed = await loadSkillFile(skillMd);
    const skill = parsed.frontmatter;
    // Walk the skill directory and inventory every file.
    const allFiles = await walkFiles(skillDir);
    const fileEntries: CatalogSkill["files"] = allFiles
      .filter((rel) => rel !== "SKILL.md")
      .map((rel) => {
        const abs = join(skillDir, rel);
        const stat = fs.statSync(abs);
        const content = fs.readFileSync(abs, "utf8");
        return {
          path: rel,
          kind: classifySkillFilePath(rel),
          sizeBytes: stat.size,
          sha256: sha256HexSync(content),
        };
      });
    // Merge the in-SKILL.md frontmatter files with the on-disk walk.
    const frontmatterFilePaths = new Set(skill.files.map((f) => f.path));
    for (const f of skill.files) {
      if (!fileEntries.find((e) => e.path === f.path)) {
        fileEntries.push({
          path: f.path,
          kind: f.kind,
          sizeBytes: Buffer.byteLength(f.content, "utf8"),
          sha256: f.sha256 ?? sha256HexSync(f.content),
        });
      }
      frontmatterFilePaths.add(f.path);
    }
    fileEntries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      id: `${kind}:${category}:${slug}`,
      key: `${kind}/${category}/${slug}`,
      kind,
      category,
      slug,
      name: skill.name,
      description: skill.description,
      relPath,
      entrypoint: "SKILL.md",
      trustLevel: deriveTrustLevel(fileEntries),
      defaultInstall: false,
      recommendedForRoles: [],
      requires: [],
      tags: [],
      files: fileEntries,
      contentHash: contentHashOf(fileEntries),
      source: { type: "local", baseDir: this.baseDir, relPath: join("catalog", relPath) },
    };
  }

  private async loadRefJson(
    _skillDir: string,
    refJson: string,
    kind: "bundled" | "optional",
    category: string,
    slug: string,
    relPath: string,
  ): Promise<CatalogSkill> {
    const raw = await readFile(refJson, "utf8");
    const ref = JSON.parse(raw) as CatalogRefJson;
    if (ref.source?.type !== "github") {
      throw new Error("catalog-ref.json: source.type must be 'github'");
    }
    if (!/^[a-f0-9]{40}$/.test(ref.source.commit)) {
      throw new Error(
        `catalog-ref.json: source.commit must be 40-char hex, got ${ref.source.commit}`,
      );
    }
    const entries = (ref.files ?? ["SKILL.md"]).map((f) => ({
      path: f,
      kind: classifySkillFilePath(f),
      sizeBytes: 0,
      sha256: "",
    }));
    return {
      id: `${kind}:${category}:${slug}`,
      key: `${kind}/${category}/${slug}`,
      kind,
      category,
      slug,
      name: slug,
      description: `GitHub-pinned skill ${ref.source.owner}/${ref.source.repo}@${ref.source.ref}`,
      relPath,
      entrypoint: "SKILL.md",
      trustLevel: deriveTrustLevel(entries),
      defaultInstall: ref.defaultInstall ?? false,
      recommendedForRoles: ref.recommendedForRoles ?? [],
      requires: ref.requires ?? [],
      tags: ref.tags ?? [],
      files: entries,
      contentHash: contentHashOf(entries),
      source: {
        type: "github",
        hostname: ref.source.hostname ?? "github.com",
        owner: ref.source.owner,
        repo: ref.source.repo,
        ref: ref.source.ref,
        commit: ref.source.commit,
        path: ref.source.path,
      },
    };
  }

  /**
   * Convert a `CatalogSkill` into a runtime `Skill` by reading its
   * file contents. Local skills are read from disk; GitHub-pinned
   * skills require a `fetchGithub: true` option (otherwise the
   * returned Skill has no file contents and `instructions` is empty).
   */
  async toSkill(catalogSkill: CatalogSkill, fetchGithub: boolean): Promise<Skill> {
    const built = this.builtSkills.get(catalogSkill.id);
    if (built) return built;
    if (catalogSkill.source.type === "local") {
      return this.localToSkill(catalogSkill);
    }
    if (!fetchGithub) {
      throw new Error(`GitHub-pinned skill ${catalogSkill.id} requires fetchGithub: true`);
    }
    return this.githubToSkill(catalogSkill);
  }

  private async localToSkill(catalogSkill: CatalogSkill): Promise<Skill> {
    if (catalogSkill.source.type !== "local") throw new Error("not local");
    const skillDir = join(catalogSkill.source.baseDir, catalogSkill.source.relPath);
    const skillMd = join(skillDir, "SKILL.md");
    const parsed = await loadSkillFile(skillMd);
    const skill = parsed.frontmatter;
    // Fill in frontmatter from the catalog if not present.
    if (!skill.name) skill.name = catalogSkill.name;
    if (!skill.description) skill.description = catalogSkill.description;
    // The files from on-disk take precedence over the in-SKILL.md ones.
    const files: Skill["files"] = [];
    for (const f of catalogSkill.files) {
      const abs = join(skillDir, f.path);
      const content = (await readFile(abs, "utf8").catch(() => "")) as string;
      files.push({
        path: f.path,
        content,
        kind: f.kind,
        sha256: f.sha256,
      });
    }
    skill.files = files;
    skill.adapterTypes = skill.adapterTypes.length > 0 ? skill.adapterTypes : [catalogSkill.kind];
    return skill;
  }

  private async githubToSkill(catalogSkill: CatalogSkill): Promise<Skill> {
    if (catalogSkill.source.type !== "github") throw new Error("not github");
    const { hostname, owner, repo, commit, path } = catalogSkill.source;
    const tree = await fetchGithubTree(hostname, owner, repo, commit, path);
    const files: Skill["files"] = [];
    for (const f of catalogSkill.files) {
      const match = tree.find((t) => t.path === f.path);
      if (!match) continue;
      const content = await fetchGithubRaw(hostname, owner, repo, commit, match.path);
      // Tier 5 (this pass): verify the fetched content matches the
      // sha256 declared in the catalog. A mismatch means the catalog
      // and the source are out of sync (e.g. stale catalog-ref.json).
      const computed = sha256HexSync(content);
      if (f.sha256 && computed !== f.sha256) {
        throw new Error(
          `sha256 mismatch for ${catalogSkill.key}@${catalogSkill.id} file ${f.path}: ` +
            `expected ${f.sha256}, got ${computed}`,
        );
      }
      files.push({
        path: f.path,
        content,
        kind: f.kind,
        sha256: computed,
      });
    }
    const skillMd = files.find((f) => f.path === "SKILL.md")?.content ?? "";
    const parsed = skillMd ? loadSkillFileFromString(skillMd) : null;
    const skill: Skill = parsed
      ? parsed
      : {
          key: catalogSkill.key,
          version: "0.0.0",
          name: catalogSkill.name,
          description: catalogSkill.description,
          instructions: "",
          files,
          adapterTypes: [catalogSkill.kind],
          owner: "github",
          visibility: "public",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
        };
    skill.key = catalogSkill.key;
    skill.files = files;
    return skill;
  }

  /** Return all catalog skills sorted by id. */
  list(): readonly CatalogSkill[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Look up a catalog entry by id, key, or unique slug. */
  resolve(ref: string): CatalogSkill | null {
    ref = ref.trim();
    const byId = this.byId.get(ref);
    if (byId) return byId;
    const byKey = this.byKey.get(ref);
    if (byKey) return byKey;
    // Unique slug match
    const matches = this.list().filter((s) => s.slug === ref);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  /**
   * Register every catalog skill into the given registry. Local
   * skills are read synchronously; GitHub-pinned skills are
   * registered as placeholders unless `fetchGithub` is true.
   */
  async registerAllInto(
    registry: SkillRegistry,
    opts: { fetchGithub?: boolean } = {},
  ): Promise<{ registered: number; skipped: number; errors: string[] }> {
    const errors: string[] = [];
    let registered = 0;
    let skipped = 0;
    for (const cs of this.list()) {
      try {
        const skill = await this.toSkill(cs, opts.fetchGithub ?? false);
        registry.register(skill);
        registered += 1;
      } catch (err) {
        if ((err as Error).message.includes("requires fetchGithub")) {
          skipped += 1;
        } else {
          errors.push(`${cs.id}: ${(err as Error).message}`);
        }
      }
    }
    log.info("catalog registered", { registered, skipped, errors: errors.length });
    return { registered, skipped, errors };
  }

  /**
   * Write the manifest to `<baseDir>/generated/catalog.json` in the
   * same shape as `@paperclipai/skills-catalog`.
   */
  async writeManifest(manifest: CatalogManifest, dest: string): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(dest, "generated"), { recursive: true });
    const file = join(dest, "generated", "catalog.json");
    await writeFile(file, JSON.stringify(manifest, null, 2), "utf8");
  }
}

/* ──────────────────────────────────────────────────────────────────
 *  Helpers
 *  ────────────────────────────────────────────────────────────────── */

async function walkFiles(dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    const entries = await fs.readdir(cur, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks in the catalog
      const rel = relative(dir, join(cur, e.name));
      if (e.isDirectory()) stack.push(join(cur, e.name));
      else if (e.isFile()) out.push(rel.split(sep).join("/"));
    }
  }
  return out.sort();
}

function deriveTrustLevel(
  files: Array<{ kind: Skill["files"][number]["kind"] }>,
): CatalogSkill["trustLevel"] {
  if (files.some((f) => f.kind === "script")) return "scripts_executables";
  if (files.some((f) => f.kind === "asset" || f.kind === "other")) return "assets";
  return "markdown_only";
}

function contentHashOf(files: Array<{ path: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const list = sorted.map((f) => `${f.path}:${f.sha256}`).join("\n");
  return `sha256:${sha256HexSync(list)}`;
}

function loadSkillFileFromString(raw: string): Skill {
  // Re-use parseSkillFile via a fake filePath so basename derivation works.
  return parseSkillFile(raw, { filePath: "SKILL.md" }).frontmatter;
}

/* ──────────────────────────────────────────────────────────────────
 *  GitHub fetching (lightweight — uses the public REST API)
 *  ────────────────────────────────────────────────────────────────── */

interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

async function fetchGithubTree(
  hostname: string,
  owner: string,
  repo: string,
  commit: string,
  path: string,
): Promise<GithubTreeEntry[]> {
  const apiBase =
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`;
  const url = `${apiBase}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "aaspai-skills" },
  });
  if (!res.ok) {
    throw new Error(`GitHub tree fetch ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { tree: GithubTreeEntry[] };
  const prefix = path.endsWith("/") ? path : `${path}/`;
  return json.tree.filter((t) => t.type === "blob" && t.path.startsWith(prefix));
}

async function fetchGithubRaw(
  hostname: string,
  owner: string,
  repo: string,
  commit: string,
  path: string,
): Promise<string> {
  const url =
    hostname === "github.com"
      ? `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`
      : `https://${hostname}/raw/${owner}/${repo}/${commit}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "aaspai-skills" } });
  if (!res.ok) {
    throw new Error(`GitHub raw fetch ${res.status}: ${url}`);
  }
  return await res.text();
}
