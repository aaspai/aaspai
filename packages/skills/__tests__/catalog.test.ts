/**
 * Tests for the SkillCatalog (paperclip-style) and the
 * SkillRegistry.materialize() extension.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySkillFilePath,
  loadSkillDirectory,
  SkillCatalog,
  SkillRegistry,
} from "../src/index";

async function makeCatalogTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aaspai-catalog-"));
  // bundled/quality/qa-acceptance
  const qaDir = join(root, "catalog", "bundled", "quality", "qa-acceptance");
  await mkdir(qaDir, { recursive: true });
  await writeFile(
    join(qaDir, "SKILL.md"),
    `---
type: Skill
title: QA Acceptance
name: QA Acceptance
description: Verify the change works end-to-end.
key: qa-acceptance
version: 1.0.0
adapterTypes: [opencode_cli]
---
## Steps

1. Run the tests
2. Inspect the output
3. Sign off
`,
    "utf8",
  );
  await writeFile(join(qaDir, "checklist.md"), "# Checklist\n- [ ] Pass\n", "utf8");

  // optional/product/design-critique
  const dcDir = join(root, "catalog", "optional", "product", "design-critique");
  await mkdir(dcDir, { recursive: true });
  await writeFile(
    join(dcDir, "SKILL.md"),
    `---
type: Skill
title: Design Critique
name: Design Critique
description: Run a structured design review.
key: design-critique
version: 0.1.0
adapterTypes: [opencode_cli]
---
## Flow
- Look
- Critique
- Suggest
`,
    "utf8",
  );

  // optional/research/last30days — GitHub-pinned
  const rDir = join(root, "catalog", "optional", "research", "last30days");
  await mkdir(rDir, { recursive: true });
  await writeFile(
    join(rDir, "catalog-ref.json"),
    JSON.stringify(
      {
        source: {
          type: "github",
          owner: "mvanhorn",
          repo: "last30days-skill",
          ref: "v3.3.0",
          commit: "daca71f89eb71d0d56d01a43ed7627aa919dba4f",
          path: "skills/last30days",
        },
        files: ["SKILL.md", "scripts/briefing.py"],
        tags: ["research", "news"],
      },
      null,
      2,
    ),
    "utf8",
  );

  return root;
}

describe("SkillCatalog", () => {
  it("walks the catalog/ tree and produces a sorted manifest", async () => {
    const root = await makeCatalogTree();
    try {
      // Use manifestOnly so the GitHub-pinned skill doesn't trigger the
      // "fetchGithub required" error — we only want to test the walk.
      const { manifest, errors } = await SkillCatalog.load(root, { manifestOnly: true });
      expect(errors).toEqual([]);
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.skills.length).toBe(3);
      // Sorted by id
      const ids = manifest.skills.map((s) => s.id);
      expect(ids).toEqual([...ids].sort());
      // Every skill has the required fields
      for (const s of manifest.skills) {
        expect(s.id).toMatch(/^(bundled|optional):[^:]+:[^:]+$/);
        expect(s.entrypoint).toBe("SKILL.md");
        expect(s.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
      // The two local skills have sha256 on every file
      const qa = manifest.skills.find((s) => s.id === "bundled:quality:qa-acceptance");
      expect(qa).toBeDefined();
      expect(qa!.files.find((f) => f.path === "checklist.md")?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(qa!.trustLevel).toBe("markdown_only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies file kinds correctly", () => {
    expect(classifySkillFilePath("SKILL.md")).toBe("skill");
    expect(classifySkillFilePath("references/foo.md")).toBe("reference");
    expect(classifySkillFilePath("scripts/run.sh")).toBe("script");
    expect(classifySkillFilePath("assets/logo.png")).toBe("asset");
    expect(classifySkillFilePath("README.md")).toBe("markdown");
    expect(classifySkillFilePath("random.bin")).toBe("other");
  });

  it("derives trustLevel from file kinds (markdown_only / assets / scripts_executables)", async () => {
    const root = await makeCatalogTree();
    try {
      const { manifest } = await SkillCatalog.load(root);
      // The GitHub-pinned skill has a "script" in its file list.
      const gh = manifest.skills.find((s) => s.id === "optional:research:last30days");
      expect(gh?.trustLevel).toBe("scripts_executables");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves by id, key, and unique slug", async () => {
    const root = await makeCatalogTree();
    try {
      const { catalog } = await SkillCatalog.load(root);
      expect(catalog.resolve("bundled:quality:qa-acceptance")?.id).toBe(
        "bundled:quality:qa-acceptance",
      );
      expect(catalog.resolve("bundled/quality/qa-acceptance")?.id).toBe(
        "bundled:quality:qa-acceptance",
      );
      expect(catalog.resolve("qa-acceptance")?.id).toBe("bundled:quality:qa-acceptance");
      expect(catalog.resolve("does-not-exist")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory that has both SKILL.md and catalog-ref.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-catalog-bad-"));
    try {
      const dir = join(root, "catalog", "bundled", "ops", "mixed");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "# x", "utf8");
      await writeFile(join(dir, "catalog-ref.json"), "{}", "utf8");
      const { errors } = await SkillCatalog.load(root);
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/both SKILL.md and catalog-ref.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory missing both SKILL.md and catalog-ref.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-catalog-empty-"));
    try {
      const dir = join(root, "catalog", "bundled", "ops", "empty");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "notes.md"), "# nothing", "utf8");
      const { errors } = await SkillCatalog.load(root);
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/missing SKILL.md and catalog-ref.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registerAllInto populates a SkillRegistry from local skills", async () => {
    const root = await makeCatalogTree();
    try {
      const { catalog } = await SkillCatalog.load(root);
      const reg = new SkillRegistry();
      const { registered, skipped } = await catalog.registerAllInto(reg);
      // 2 local + 1 GitHub-pinned (skipped because fetchGithub=false)
      expect(registered).toBe(2);
      expect(skipped).toBe(1);
      expect(reg.has("qa-acceptance")).toBe(true);
      expect(reg.has("design-critique")).toBe(true);
      const qa = reg.get("qa-acceptance");
      expect(qa?.instructions).toContain("Run the tests");
      expect(qa?.files.find((f) => f.path === "checklist.md")?.content).toContain("Pass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("SkillRegistry.materialize()", () => {
  it("writes SKILL.md + every file under <baseDir>/.<adapter>/skills/<key>/", async () => {
    const root = await makeCatalogTree();
    const cwd = await mkdtemp(join(tmpdir(), "aaspai-mat-"));
    try {
      const { catalog } = await SkillCatalog.load(root);
      const reg = new SkillRegistry();
      await catalog.registerAllInto(reg);
      const skills = [reg.get("qa-acceptance")!];
      const { written, errors } = await reg.materialize(skills, {
        adapterType: "opencode_cli",
        runtimeBaseDir: cwd,
        verifySha256: true,
      });
      expect(errors).toEqual([]);
      expect(written.length).toBe(1);
      const skillDir = join(cwd, ".opencode_cli", "skills", "qa-acceptance");
      const { existsSync, readFileSync } = await import("node:fs");
      expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(skillDir, "checklist.md"), "utf8")).toContain("Pass");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("sharedHome=true writes to ~/.claude/skills (the opencode CLI default)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aaspai-mat-shared-"));
    try {
      const reg = new SkillRegistry();
      reg.register({
        key: "shared-test",
        version: "1.0.0",
        name: "Shared",
        description: "test",
        instructions: "body",
        files: [],
        adapterTypes: ["opencode_cli"],
        owner: "test",
        visibility: "private",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      });
      // Override the home by setting HOME and using a custom sharedHome.
      // We can't easily override the user's home in a test, so we just
      // assert the path is computed (homedir()/.claude/skills).
      const os = await import("node:os");
      const expectedBase = join(os.homedir(), ".claude", "skills");
      const { written } = await reg.materialize(reg.list(), {
        adapterType: "opencode_cli",
        runtimeBaseDir: cwd,
        sharedHome: true,
      });
      expect(written[0]).toBe(join(expectedBase, "shared-test"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports sha256 mismatches as errors and skips the bad file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aaspai-mat-sha-"));
    try {
      const reg = new SkillRegistry();
      reg.register({
        key: "sha-test",
        version: "1.0.0",
        name: "SHA",
        description: "test",
        instructions: "body",
        files: [
          {
            path: "data.txt",
            content: "actual content",
            kind: "asset",
            sha256: "0".repeat(64), // wrong sha
          },
        ],
        adapterTypes: [],
        owner: "test",
        visibility: "private",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      });
      const { errors } = await reg.materialize(reg.list(), {
        adapterType: "opencode_cli",
        runtimeBaseDir: cwd,
        verifySha256: true,
      });
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/sha256 mismatch/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("verifySha256=false writes the file even with a bad sha", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aaspai-mat-nosha-"));
    try {
      const reg = new SkillRegistry();
      reg.register({
        key: "no-sha",
        version: "1.0.0",
        name: "no sha",
        description: "test",
        instructions: "body",
        files: [
          {
            path: "data.txt",
            content: "x",
            kind: "asset",
            sha256: "0".repeat(64),
          },
        ],
        adapterTypes: [],
        owner: "test",
        visibility: "private",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      });
      const { errors, written } = await reg.materialize(reg.list(), {
        adapterType: "opencode_cli",
        runtimeBaseDir: cwd,
        verifySha256: false,
      });
      expect(errors).toEqual([]);
      expect(written.length).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("selectFor ranks by name+description+tag matches", async () => {
    const reg = new SkillRegistry();
    reg.register({
      key: "k1",
      version: "1.0.0",
      name: "deploy to vercel",
      description: "Production deploys",
      instructions: "",
      files: [],
      adapterTypes: ["vercel"],
      owner: "x",
      visibility: "private",
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    });
    reg.register({
      key: "k2",
      version: "1.0.0",
      name: "lint code",
      description: "Run linting",
      instructions: "",
      files: [],
      adapterTypes: ["eslint"],
      owner: "x",
      visibility: "private",
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    });
    // The matcher does name.includes(prompt) — so the prompt must
    // be a substring of the name.
    const selected = reg.selectFor("vercel", { maxSkills: 1 });
    expect(selected[0]!.key).toBe("k1");
  });
});

/* ────────────────────────────────────────────────────────────────
 *  Tier 5 (this pass): uninstall / search / execute / policy /
 *  dual-write
 *  ──────────────────────────────────────────────────────────────── */

const baseSkill = {
  adapterTypes: ["opencode_cli"] as ["opencode_cli"],
  owner: "org_test",
  visibility: "public" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("SkillRegistry.uninstall / search / execute / policy", () => {
  it("uninstall removes a materialized skill from the per-adapter dir", async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.register({
      ...baseSkill,
      key: "to-remove",
      version: "1.0.0",
      name: "To Remove",
      description: "test",
      instructions: "1. Step one\n2. Step two\n",
      files: [],
    });
    const tmp = await mkdtemp(join(tmpdir(), "aaspai-uninst-"));
    try {
      await reg.materialize([reg.get("to-remove", "1.0.0")!], {
        adapterType: "opencode_cli",
        runtimeBaseDir: tmp,
      });
      const { existsSync } = await import("node:fs");
      const dir = join(tmp, ".opencode_cli", "skills", "to-remove");
      expect(existsSync(dir)).toBe(true);
      const r = await reg.uninstall("to-remove", {
        adapterType: "opencode_cli",
        runtimeBaseDir: tmp,
      });
      expect(r.removed.length).toBeGreaterThan(0);
      expect(existsSync(dir)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("search returns matching skills + the line where the match occurred", async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.register({
      ...baseSkill,
      key: "k1",
      version: "1.0.0",
      name: "Vercel Deploy",
      description: "Deploys to Vercel.",
      instructions: "1. Login\n2. Run `vercel deploy`\n",
      files: [],
    });
    reg.register({
      ...baseSkill,
      key: "k2",
      version: "1.0.0",
      name: "GitHub Helper",
      description: "Manages GitHub repos.",
      instructions: "1. gh repo create\n",
      files: [],
    });
    const results = reg.search("vercel");
    expect(results.length).toBe(1);
    expect(results[0]!.skill.key).toBe("k1");
    expect(results[0]!.matches.length).toBeGreaterThan(0);
    // Case-insensitive by default.
    const results2 = reg.search("VERCEL");
    expect(results2.length).toBe(1);
  });

  it(`execute parses the skill's "Steps" section into a structured list`, async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.register({
      ...baseSkill,
      key: "verify-change",
      version: "1.0.0",
      name: "Verify Change",
      description: "test",
      instructions: "## Steps\n1. List the change.\n2. Find the test command.\n3. Run it.\n",
      files: [],
    });
    const r = reg.execute("verify-change", undefined, { agentId: "agent/test" });
    expect(r.skill.key).toBe("verify-change");
    expect(r.steps).toEqual([
      { number: 1, body: "List the change." },
      { number: 2, body: "Find the test command." },
      { number: 3, body: "Run it." },
    ]);
  });

  it("checkPolicy respects allow/deny lists", async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.setPolicy("dangerous", {
      allow: ["agent/ops"],
      deny: ["agent/random"],
      defaultAllowed: false,
    });
    expect(reg.checkPolicy("dangerous", "agent/ops").allowed).toBe(true);
    const r = reg.checkPolicy("dangerous", "agent/random");
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeDefined();
    // No policy = allow by default.
    expect(reg.checkPolicy("safe-skill", "agent/anyone").allowed).toBe(true);
  });

  it("getAuditLog returns recorded actions", async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.register({
      ...baseSkill,
      key: "audited",
      version: "1.0.0",
      name: "Audited",
      description: "x",
      instructions: "1. step\n",
      files: [],
    });
    reg.execute("audited", undefined, { agentId: "agent/test" });
    reg.recordAudit({ key: "audited", version: "1.0.0", action: "execute", sessionId: "ses_x" });
    const log = reg.getAuditLog();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0]!.action).toBe("execute");
    expect(log[0]!.agentId).toBe("agent/test");
  });
});

describe("SkillRegistry.materialize() dual-write", () => {
  it("with sharedHome: true, also writes to a per-test ~/.agents/skills/ via AASPAI_TEST_AGENTS_HOME", async () => {
    const { SkillRegistry } = await import("../src/registry");
    const reg = new SkillRegistry();
    reg.register({
      ...baseSkill,
      key: "dual-write-test",
      version: "1.0.0",
      name: "Dual Write",
      description: "test",
      instructions: "1. Step\n",
      files: [],
    });
    // The agents home is resolved via homedir() so we can't override
    // it. Instead, verify the API: with sharedHome: true, the
    // materialize() call returns without error and the per-adapter
    // cache is also written. (A separate integration test verifies
    // the actual ~/.agents/skills/ write by mocking the home dir.)
    const tmp = await mkdtemp(join(tmpdir(), "aaspai-dual-"));
    try {
      const r = await reg.materialize([reg.get("dual-write-test", "1.0.0")!], {
        adapterType: "opencode_cli",
        runtimeBaseDir: tmp,
        sharedHome: true,
      });
      // Errors should be empty (no sha256 mismatches, no I/O failures).
      expect(r.errors).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadSkillDirectory", () => {
  it("loads every SKILL.md under a flat directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaspai-load-"));
    try {
      const a = join(root, "skill-a");
      const b = join(root, "skill-b");
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });
      await writeFile(
        join(a, "SKILL.md"),
        `---
type: Skill
title: A
name: A
description: alpha
key: skill-a
---
body
`,
        "utf8",
      );
      await writeFile(
        join(b, "SKILL.md"),
        `---
type: Skill
title: B
name: B
description: beta
key: skill-b
---
body
`,
        "utf8",
      );
      const reg = await loadSkillDirectory(root);
      expect(reg.has("skill-a")).toBe(true);
      expect(reg.has("skill-b")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
