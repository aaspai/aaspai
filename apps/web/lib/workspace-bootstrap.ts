import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "./aaspai";

const agents = [
  ["ceo", "Chief Executive Officer", "ceo", "null", "dry_run_local"],
  ["operator", "Operations Lead", "operator", "agent/ceo", "dry_run_local"],
  // Keep the first frontend flow runnable on a clean machine. The setup page
  // still verifies the installed CLIs before a real provider is selected.
  ["developer", "Developer", "engineer", "agent/operator", "dry_run_local"],
  ["tester", "Tester", "qa", "agent/operator", "codex_local"],
] as const;

export async function ensureFrontendWorkspace(companyName: string): Promise<void> {
  const root = workspaceRoot();
  await mkdir(join(root, ".aaspai"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "knowledge", "company"), { recursive: true });
  await mkdir(join(root, "loops"), { recursive: true });
  await writeFile(
    join(root, "aaspai.config.json"),
    `${JSON.stringify({ database: { url: "sqlite:./.aaspai/state.db" }, organization: { id: "default", name: companyName }, agents: { root: "./agents" }, knowledge: { root: "./knowledge" }, loops: { root: "./loops" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "AGENTS.md"),
    `# ${companyName}\n\nThis company is operated through auditable aaspai goals, work items, and sessions.\n`,
    "utf8",
  );
  for (const [id, title, role, reportsTo, adapter] of agents) {
    const directory = join(root, "agents", id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "AGENT.md"),
      `---\nid: agent/${id}\ntype: Agent\ntitle: "${title}"\ndescription: "${title} for ${companyName}"\ntimestamp: ${new Date().toISOString()}\nadapter: ${adapter}\nrole: ${role}\nreportsTo: ${reportsTo}\nmanages: []\npeers: []\nknowledge:\n  include: ["**"]\n  exclude: []\n---\n\n# ${title}\n\nWork toward measurable company goals. Report evidence, blockers, and the next action.\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "config.yaml"),
      "adapterConfig: {}\nruntimeConfig: {}\n",
      "utf8",
    );
    await writeFile(
      join(directory, "tools.yaml"),
      "allow: []\ndeny: []\nrequire_approval_for: []\n",
      "utf8",
    );
    await writeFile(join(directory, "skills.lock.json"), "[]\n", "utf8");
  }
}
