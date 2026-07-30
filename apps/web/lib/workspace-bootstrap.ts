import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AASPAI_DIR,
  DEFAULT_AGENTS_DIR,
  DEFAULT_JSON_CONFIG_PATH,
  DEFAULT_KNOWLEDGE_DIR,
  DEFAULT_LOOPS_DIR,
} from "@aaspai/file-loader";
import { workspaceRoot } from "./aaspai";

export type FrontendWorkspaceOptions = {
  ceoProvider?: string;
  ceoModel?: string;
  ceoAgenda?: string;
  ceoInstructions?: string;
};

export type FrontendOnboarding = {
  ceoProvider: string;
  ceoModel?: string;
  ceoAgenda: string;
  ceoInstructions: string;
  completedAt: string;
};

const defaultAgenda =
  "Set the company direction, turn the mission into measurable goals, and keep every team focused on the next useful outcome.";
const defaultInstructions =
  "Act as the company CEO. Clarify priorities, delegate execution to the right agent, ask for evidence, and surface blockers instead of hiding them.";

async function readStoredOnboarding(): Promise<FrontendOnboarding | null> {
  try {
    return JSON.parse(
      await readFile(join(workspaceRoot(), ".aaspai", "frontend-onboarding.json"), "utf8"),
    ) as FrontendOnboarding;
  } catch {
    return null;
  }
}

export async function readFrontendOnboarding(): Promise<FrontendOnboarding | null> {
  return readStoredOnboarding();
}

export async function ensureFrontendWorkspace(
  companyName: string,
  options: FrontendWorkspaceOptions = {},
): Promise<void> {
  const root = workspaceRoot();
  const stored = await readStoredOnboarding();
  const onboarding: FrontendOnboarding = {
    ceoProvider: options.ceoProvider ?? stored?.ceoProvider ?? "opencode_cli",
    ceoModel: options.ceoModel ?? stored?.ceoModel,
    ceoAgenda: options.ceoAgenda?.trim() || stored?.ceoAgenda || defaultAgenda,
    ceoInstructions:
      options.ceoInstructions?.trim() || stored?.ceoInstructions || defaultInstructions,
    completedAt:
      options.ceoProvider || options.ceoModel || options.ceoAgenda || options.ceoInstructions
        ? new Date().toISOString()
        : (stored?.completedAt ?? ""),
  };
  await mkdir(join(root, AASPAI_DIR), { recursive: true });
  await mkdir(join(root, DEFAULT_KNOWLEDGE_DIR, "company"), { recursive: true });
  await mkdir(join(root, DEFAULT_LOOPS_DIR), { recursive: true });
  await writeFile(
    join(root, DEFAULT_JSON_CONFIG_PATH),
    `${JSON.stringify({ database: { url: "sqlite:./.aaspai/state.db" }, organization: { id: "default", name: companyName }, agents: { root: "./.aaspai/agents" }, knowledge: { root: "./.aaspai/knowledge" }, loops: { root: "./.aaspai/loops" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, AASPAI_DIR, "AGENTS.md"),
    `# ${companyName}\n\nThis company is operated through auditable aaspai goals, work items, and sessions.\n`,
    "utf8",
  );
  if (onboarding.completedAt) {
    await writeFile(
      join(root, ".aaspai", "frontend-onboarding.json"),
      `${JSON.stringify(onboarding, null, 2)}\n`,
      "utf8",
    );
  }
  const directory = join(root, DEFAULT_AGENTS_DIR, "ceo");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "AGENT.md"),
    `---\nid: agent/ceo\ntype: Agent\ntitle: "Chief Executive Officer"\ndescription: "Chief Executive Officer for ${companyName}"\ntimestamp: ${new Date().toISOString()}\nadapter: ${onboarding.ceoProvider}\n${onboarding.ceoModel ? `model: ${JSON.stringify(onboarding.ceoModel)}\n` : ""}role: ceo\nreportsTo: null\nmanages: []\npeers: []\nknowledge:\n  include: ["**"]\n  exclude: []\nruntime:\n  default: ${onboarding.ceoProvider === "dry_run_local" ? "{ kind: local }" : "{ kind: sandbox, provider: daytona, remoteCwd: /workspace }"}\n---\n\n# Chief Executive Officer\n\n## Company mission\n${onboarding.ceoAgenda}\n\n## Operating principles and boundaries\n${onboarding.ceoInstructions}\n\nYou are the only initial employee. Turn founder direction into a measurable operating plan. Do useful work yourself until a specialist is justified. When a hire is needed, call the company_action tool with a hire_and_delegate action; never merely describe or invent an employee. Include the role, why it is needed now, scope, evidence requirements, and durable artifact paths. Never claim external actions happened. Ask for approval before spending money, contacting people, publishing, deploying, or changing company governance.\n\nEnd every run with decisions made, evidence produced, blockers, requested founder decisions, and the next action.\n`,
    "utf8",
  );
  await writeFile(join(directory, "config.yaml"), "adapterConfig: {}\nruntimeConfig: {}\n", "utf8");
  await writeFile(join(directory, "tools.yaml"), toolsYaml(onboarding.ceoProvider), "utf8");
  await writeFile(join(directory, "skills.lock.json"), "[]\n", "utf8");
}

function toolsYaml(provider: string): string {
  const tools =
    provider === "codex_local"
      ? ["apply_patch", "shell", "web_search", "view_image"]
      : provider === "claude_local"
        ? ["Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"]
        : provider === "opencode_cli"
          ? [
              "bash",
              "edit",
              "read",
              "write",
              "glob",
              "grep",
              "list",
              "webfetch",
              "skill",
              "company_action",
            ]
          : [];
  return `allow:${tools.map((tool) => `\n  - ${tool}`).join("")}\ndeny: []\nrequire_approval_for: []\n`;
}
