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

const agents = [
  ["ceo", "Chief Executive Officer", "ceo", "null"],
  ["operator", "Operations Lead", "operator", "agent/ceo", "dry_run_local"],
  // Keep interactive roles dry-run by default. Verification must use an
  // adapter whose autonomous tool policy can be enforced.
  ["developer", "Developer", "engineer", "agent/operator", "dry_run_local"],
  ["tester", "Tester", "qa", "agent/operator", "opencode_cli"],
] as const;

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
    ceoProvider: options.ceoProvider ?? stored?.ceoProvider ?? "dry_run_local",
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
  for (const [id, title, role, reportsTo, defaultAdapter] of agents) {
    const adapter = id === "ceo" ? onboarding.ceoProvider : defaultAdapter;
    const directory = join(root, DEFAULT_AGENTS_DIR, id);
    await mkdir(directory, { recursive: true });
    const body =
      id === "ceo"
        ? `# ${title}\n\n## Core agenda\n${onboarding.ceoAgenda}\n\n## Operating instructions\n${onboarding.ceoInstructions}\n\nReport decisions, delegation, evidence, blockers, and the next action.\n`
        : `# ${title}\n\nWork toward measurable company goals. Report evidence, blockers, and the next action.\n`;
    await writeFile(
      join(directory, "AGENT.md"),
      `---\nid: agent/${id}\ntype: Agent\ntitle: "${title}"\ndescription: "${title} for ${companyName}"\ntimestamp: ${new Date().toISOString()}\nadapter: ${adapter}\n${id === "ceo" && onboarding.ceoModel ? `model: ${JSON.stringify(onboarding.ceoModel)}\n` : ""}role: ${role}\nreportsTo: ${reportsTo}\nmanages: []\npeers: []\nknowledge:\n  include: ["**"]\n  exclude: []\nruntime:\n  default: ${adapter === "dry_run_local" ? "{ kind: local }" : "{ kind: sandbox, provider: daytona, remoteCwd: /workspace }"}\n---\n\n${body}`,
      "utf8",
    );
    await writeFile(
      join(directory, "config.yaml"),
      "adapterConfig: {}\nruntimeConfig: {}\n",
      "utf8",
    );
    await writeFile(
      join(directory, "tools.yaml"),
      id === "tester"
        ? "allow:\n  - Read\n  - Bash\ndeny:\n  - Write\n  - Edit\nrequire_approval_for: []\n"
        : "allow:\n  - Read\n  - ListSkills\n  - ListAgents\n  - AskUserQuestion\ndeny: []\nrequire_approval_for: []\n",
      "utf8",
    );
    await writeFile(join(directory, "skills.lock.json"), "[]\n", "utf8");
  }
}
