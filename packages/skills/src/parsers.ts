/**
 * SKILL.md parser. Same OKF-style frontmatter as a knowledge file,
 * with a different semantic meaning (a skill is a packaged
 * instruction, not a knowledge concept).
 */
import { readFile, writeFile } from "node:fs/promises";
import { type Skill, skillSchema } from "@aaspai/contracts/phase2";
import {
  type ParsedFile,
  parseOkfFile,
  serializeOkfFile,
  sha256HexSync,
} from "@aaspai/file-loader/okf-parser";
import { z } from "zod";

/**
 * The skill frontmatter is much more permissive than the OKF
 * knowledge frontmatter — it doesn't require `path`, `body`, or
 * `appliesToAgents`. Use a custom schema that just captures the
 * raw fields the parser needs.
 */
const skillFrontmatterSchema = z
  .object({
    key: z.string().optional(),
    version: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            content: z.string(),
            kind: z.string().optional(),
            sha256: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    adapterTypes: z.array(z.string()).optional(),
    owner: z.string().optional(),
    visibility: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    archivedAt: z.union([z.string(), z.null()]).optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Classify a file path within a skill directory into one of the
 * `SkillFileKind` values. Mirrors the convention from
 * `@paperclipai/skills-catalog` so the same catalog entries can be
 * consumed without translation.
 */
export function classifySkillFilePath(relativePath: string): Skill["files"][number]["kind"] {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "SKILL.md" || normalized.endsWith("/SKILL.md")) return "skill";
  if (normalized.includes("/references/") || normalized.startsWith("references/"))
    return "reference";
  if (normalized.includes("/scripts/") || normalized.startsWith("scripts/")) return "script";
  if (normalized.includes("/assets/") || normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md") || normalized.endsWith(".mdx")) return "markdown";
  return "other";
}

export function parseSkillFile(raw: string, opts: { filePath?: string } = {}): ParsedFile<Skill> {
  const parsed = parseOkfFile<z.infer<typeof skillFrontmatterSchema>>(raw, {
    ...opts,
    frontmatterSchema: skillFrontmatterSchema,
  });
  const fm = parsed.frontmatter as unknown as Record<string, unknown>;
  const rawFiles =
    (fm.files as Array<{ path: string; content: string; kind?: string; sha256?: string }>) ?? [];
  // Auto-fill kind + sha256 if not set in the frontmatter.
  const files: Skill["files"] = rawFiles.map((f) => ({
    kind: (f.kind as Skill["files"][number]["kind"]) ?? classifySkillFilePath(f.path),
    sha256: f.sha256 ?? sha256HexSync(f.content),
    path: f.path,
    content: f.content,
  }));
  const skill: Skill = {
    key: (fm.key as string) ?? basenameNoExt(opts.filePath ?? "skill"),
    version: (fm.version as string) ?? "0.0.0",
    name: (fm.name as string) ?? (fm.title as string) ?? "Untitled",
    description: (fm.description as string) ?? "",
    instructions: parsed.body,
    files,
    adapterTypes: (fm.adapterTypes as string[]) ?? [],
    owner: (fm.owner as string) ?? "default",
    visibility: (fm.visibility as Skill["visibility"]) ?? "private",
    createdAt: (fm.createdAt as string) ?? new Date().toISOString(),
    updatedAt: (fm.updatedAt as string) ?? new Date().toISOString(),
    archivedAt: ((fm.archivedAt as string | null | undefined) ?? null) as string | null,
  };
  const validated = skillSchema.parse(skill);
  return { ...parsed, frontmatter: validated };
}

export async function loadSkillFile(path: string): Promise<ParsedFile<Skill>> {
  const raw = await readFile(path, "utf8");
  return parseSkillFile(raw, { filePath: path });
}

export async function writeSkillFile(path: string, skill: Skill): Promise<void> {
  const fm: Record<string, unknown> = {
    type: "Skill",
    title: skill.name,
    timestamp: skill.updatedAt,
    key: skill.key,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    files: skill.files,
    adapterTypes: skill.adapterTypes,
    owner: skill.owner,
    visibility: skill.visibility,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    archivedAt: skill.archivedAt ?? null,
  };
  const content = serializeOkfFile({ frontmatter: fm, body: skill.instructions });
  await writeFile(path, content, "utf8");
}

function basenameNoExt(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.md$/, "");
}

export { sha256HexSync };
