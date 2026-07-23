import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillFile, writeSkillFile } from "../src/parsers";

describe("skill files", () => {
  it("round-trips through the persisted workspace format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aaspai-skill-"));
    const path = join(directory, "SKILL.md");
    const timestamp = "2026-07-24T00:00:00.000Z";
    await writeSkillFile(path, {
      key: "verification",
      version: "1.0.0",
      name: "Verification",
      description: "Verifies an outcome.",
      instructions: "Include evidence.",
      files: [],
      adapterTypes: ["codex_local"],
      owner: "qa",
      visibility: "private",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    expect((await loadSkillFile(path)).frontmatter.key).toBe("verification");
    await rm(directory, { recursive: true });
  });
});
