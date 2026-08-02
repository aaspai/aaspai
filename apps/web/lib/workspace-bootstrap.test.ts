import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseOkfFile } from "@aaspai/file-loader";
import { loadSkillDirectory } from "../../../packages/skills/src/load-directory";
import { ensureFrontendWorkspace } from "./workspace-bootstrap";

test("UI onboarding creates an executable OpenCode company workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "aaspai-onboarding-"));
  const previousWorkspace = process.env.AASPAI_CWD;
  const previousCwd = process.cwd();
  process.env.AASPAI_CWD = root;

  try {
    const companyName = 'Acme "\nrole: attacker';
    await ensureFrontendWorkspace(companyName, {
      ceoProvider: "opencode_cli",
      ceoModel: "opencode-go/mimo-v2.5",
      ceoAgenda: "Build a measurable and evidence-backed growth engine.",
      ceoInstructions: "Delegate specialist work and require durable evidence.",
      runtime: { kind: "docker", image: "node:20", network: "bridge" },
    });

    const agentRoot = join(root, ".aaspai", "agents");
    const ceoSkills = JSON.parse(
      await readFile(join(agentRoot, "ceo", "skills.lock.json"), "utf8"),
    );
    assert.deepEqual(ceoSkills, [
      { key: "company-operator", version: "1.0.0" },
      { key: "company-work", version: "1.0.0" },
    ]);
    const ceoConfig = JSON.parse(await readFile(join(agentRoot, "ceo", "config.yaml"), "utf8"));
    assert.deepEqual(ceoConfig.runtimeConfig.default, {
      kind: "docker",
      image: "node:20",
      network: "bridge",
    });
    const openCodeTools = await readFile(join(agentRoot, "ceo", "tools.yaml"), "utf8");
    for (const tool of [
      "bash",
      "browser_snapshot",
      "company_action",
      "read",
      "skill",
      "webfetch",
      "websearch",
      "write",
    ]) {
      assert.match(openCodeTools, new RegExp(`  - ${tool}(?:\\r?\\n|$)`));
    }

    const managerDefinition = await readFile(join(agentRoot, "operator", "AGENT.md"), "utf8");
    const ceoDefinition = await readFile(join(agentRoot, "ceo", "AGENT.md"), "utf8");
    assert.equal(
      parseOkfFile(ceoDefinition).frontmatter.description,
      `Chief Executive Officer for ${companyName}`,
    );
    assert.equal(parseOkfFile(ceoDefinition).frontmatter.role, "ceo");
    assert.equal(
      parseOkfFile(managerDefinition).frontmatter.description,
      `Internal non-CLI manager control-loop coordinator for ${companyName}`,
    );
    assert.equal(parseOkfFile(managerDefinition).frontmatter.role, "operator");
    const managerTools = await readFile(join(agentRoot, "operator", "tools.yaml"), "utf8");
    assert.match(managerDefinition, /title: "Company Manager"/);
    assert.match(managerDefinition, /Internal non-CLI manager control-loop coordinator/);
    assert.match(managerDefinition, /not an employee CLI session/);
    assert.equal(managerTools, "allow: []\ndeny: []\nrequire_approval_for: []\n");

    const operatorSkill = await readFile(
      join(root, "skills", "company-operator", "SKILL.md"),
      "utf8",
    );
    const workSkill = await readFile(join(root, "skills", "company-work", "SKILL.md"), "utf8");
    assert.match(operatorSkill, /skillKeys:\["company-operator","company-work"\]/);
    assert.match(operatorSkill, /Delegated work runs in its own session/);
    assert.match(workSkill, /native read, write, shell, and web tools/);
    assert.match(workSkill, /durable artifacts/);

    process.chdir(root);
    assert.equal(resolve("./skills"), join(root, "skills"));
    const skills = await loadSkillDirectory("./skills");
    assert.ok(skills.has("company-operator", "1.0.0"));
    assert.ok(skills.has("company-work", "1.0.0"));

    await ensureFrontendWorkspace("Acme", { ceoProvider: "codex_local" });
    const codexTools = await readFile(join(agentRoot, "ceo", "tools.yaml"), "utf8");
    for (const tool of ["apply_patch", "shell", "web_search", "view_image"]) {
      assert.match(codexTools, new RegExp(`  - ${tool}(?:\\r?\\n|$)`));
    }
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) delete process.env.AASPAI_CWD;
    else process.env.AASPAI_CWD = previousWorkspace;
    await rm(root, { recursive: true, force: true });
  }
});
