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

export function parseSkillFile(raw: string, opts: { filePath?: string } = {}): ParsedFile<Skill> {
  const parsed = parseOkfFile(raw, opts);
  const fm = parsed.frontmatter as unknown as Record<string, unknown>;
  const skill: Skill = {
    key: (fm.key as string) ?? basenameNoExt(opts.filePath ?? "skill"),
    version: (fm.version as string) ?? "0.0.0",
    name: (fm.name as string) ?? (fm.title as string),
    description: (fm.description as string) ?? "",
    instructions: parsed.body,
    files: (fm.files as Skill["files"]) ?? [],
    adapterTypes: (fm.adapterTypes as string[]) ?? [],
    owner: (fm.owner as string) ?? "default",
    visibility: (fm.visibility as Skill["visibility"]) ?? "private",
    createdAt: (fm.createdAt as string) ?? new Date().toISOString(),
    updatedAt: (fm.updatedAt as string) ?? new Date().toISOString(),
    archivedAt: (fm.archivedAt as string | null) ?? null,
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
