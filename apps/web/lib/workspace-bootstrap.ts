import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionTarget } from "@aaspai/contracts/runtime";
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
  runtime?: ExecutionTarget;
};

export type FrontendOnboarding = {
  ceoProvider: string;
  ceoModel?: string;
  ceoAgenda: string;
  ceoInstructions: string;
  runtime: ExecutionTarget;
  completedAt: string;
};

const defaultAgenda =
  "Set the company direction, turn the mission into measurable goals, and keep every team focused on the next useful outcome.";
const defaultInstructions =
  "Act as the company CEO. Clarify priorities, delegate execution to the right agent, ask for evidence, and surface blockers instead of hiding them.";
const companySkills = [
  { key: "company-operator", version: "1.0.0" },
  { key: "company-work", version: "1.0.0" },
] as const;

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
    runtime:
      options.runtime ?? stored?.runtime ?? ({ kind: "local", envPassthrough: false } as const),
    completedAt:
      options.ceoProvider ||
      options.ceoModel ||
      options.ceoAgenda ||
      options.ceoInstructions ||
      options.runtime
        ? new Date().toISOString()
        : (stored?.completedAt ?? ""),
  };
  await mkdir(join(root, AASPAI_DIR), { recursive: true });
  await mkdir(join(root, DEFAULT_KNOWLEDGE_DIR, "company"), { recursive: true });
  await mkdir(join(root, DEFAULT_LOOPS_DIR), { recursive: true });
  for (const skill of companySkills) {
    await mkdir(join(root, "skills", skill.key), { recursive: true });
  }
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
    `---\nid: agent/ceo\ntype: Agent\ntitle: "Chief Executive Officer"\ndescription: ${JSON.stringify(`Chief Executive Officer for ${companyName}`)}\ntimestamp: ${new Date().toISOString()}\nadapter: ${onboarding.ceoProvider}\n${onboarding.ceoModel ? `model: ${JSON.stringify(onboarding.ceoModel)}\n` : ""}role: ceo\nreportsTo: null\nmanages: []\npeers: []\nknowledge:\n  include: ["**"]\n  exclude: []\nruntime:\n  default: ${JSON.stringify(onboarding.runtime)}\n---\n\n# Chief Executive Officer\n\n## Company mission\n${onboarding.ceoAgenda}\n\n## Operating principles and boundaries\n${onboarding.ceoInstructions}\n\nYou are the only initial employee. Turn founder direction into a measurable operating plan. Use native CLI research tools, cite sources in durable artifacts, and never treat an unsourced model statement as evidence. Do useful work yourself until a specialist is justified. When a hire is needed, submit a typed hire_and_delegate action; never merely describe or invent an employee. In OpenCode call company_action. In Codex, return the exact final line AASPAI_COMPANY_ACTIONS={"actions":[...]}. Include projectId and projectRole ("manager" or "member"), the role, why it is needed now, scope, evidence requirements, and durable artifact paths. A new project manager's first assignment must require create_milestone and define_and_start_process company actions. Never claim external actions happened. Ask for approval before spending money, contacting people, publishing, deploying, or changing company governance.\n\nEnd every run with decisions made, evidence produced, blockers, requested founder decisions, and the next action.\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "config.yaml"),
    `${JSON.stringify(
      {
        adapterConfig: {},
        runtimeConfig: { default: onboarding.runtime },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(directory, "tools.yaml"), toolsYaml(onboarding.ceoProvider), "utf8");
  await writeFile(
    join(directory, "skills.lock.json"),
    `${JSON.stringify(companySkills, null, 2)}\n`,
    "utf8",
  );

  const skillTimestamp = onboarding.completedAt || new Date().toISOString();
  await writeFile(
    join(root, "skills", "company-operator", "SKILL.md"),
    `---
key: company-operator
version: 1.0.0
name: Company Manager
description: Use typed AASPAI company actions to staff and direct the company.
adapterTypes: []
owner: aaspai
visibility: private
createdAt: ${skillTimestamp}
updatedAt: ${skillTimestamp}
---

Use this skill only when the company must change its operating state. Never simulate a hire, delegation, milestone, or process in prose.

- OpenCode: call \`company_action\` with a JSON-string \`payload\` shaped as \`{"actions":[...]}\`.
- Codex or another CLI without that tool: make the exact final response line \`AASPAI_COMPANY_ACTIONS={"actions":[...]}\`.
- To delegate, use \`hire_and_delegate\` with \`agentId\`, \`title\`, \`role\`, \`description\`, \`workTitle\`, \`workDescription\`, \`projectId\`, and \`projectRole\`.
- \`role\` must be one of \`ceo|cto|cmo|cfo|security|engineer|designer|pm|qa|devops|researcher|operator|general\`. A project manager uses a domain role such as \`pm\` plus \`projectRole:"manager"\`.
- Valid manager hire (replace example IDs): \`{"actions":[{"type":"hire_and_delegate","agentId":"agent/project-manager","title":"Project Manager","role":"pm","description":"Owns one approved project.","workTitle":"Set up the approved project","workDescription":"Hire one immediately needed specialist, create one measurable milestone, and start one minimal process owned by that specialist.","projectId":"project/example","projectRole":"manager","skillKeys":["company-operator","company-work"]}]}\`.
- Give a project manager \`skillKeys:["company-operator","company-work"]\`; give a member \`skillKeys:["company-work"]\`.
- Include relative \`artifactPaths\`. Growth, lead, campaign, outreach, sales, or prospect work must also include non-empty \`citationPaths\` and \`commercialClaimPaths\`.
- A new project manager must hire one immediately needed member, create a milestone, then use \`define_and_start_process\` with that already-hired specialist. Pass the milestone's \`sequence\` back as \`milestoneSequence\`.
- Valid minimal process (replace example IDs, \`ORGANIZATION_ID\`, and timestamp; \`agent/project-specialist\` must already be hired and assigned): \`{"actions":[{"type":"define_and_start_process","projectId":"project/example","milestoneSequence":1,"definition":{"id":"process/example-v1","organizationId":"ORGANIZATION_ID","revision":1,"contentHash":"example-v1","name":"Minimal project loop","description":"Run one bounded evidence-backed cycle.","steps":[{"id":"step/execute","agent":"agent/project-specialist","dependsOn":[],"prompt":"Complete one bounded cycle and persist evidence.","skills":[],"tools":[],"workKind":"general","deliveryMode":"none","timeoutMs":86400000,"maxAttempts":3,"acceptanceCriteria":"One evidence-backed result is persisted.","failureAction":"escalate","approvalPolicy":{}}],"maxDurationMs":86400000,"maxAttempts":3,"createdAt":"2026-01-01T00:00:00.000Z"}}]}\`.

Delegated work runs in its own session. End your turn after the typed action instead of doing the employee's assignment yourself.
`,
    "utf8",
  );
  await writeFile(
    join(root, "skills", "company-work", "SKILL.md"),
    `---
key: company-work
version: 1.0.0
name: Company Work
description: Complete assigned company work with native tools and durable evidence.
adapterTypes: []
owner: aaspai
visibility: private
createdAt: ${skillTimestamp}
updatedAt: ${skillTimestamp}
---

Start actionable work in this session. Use the runtime's native read, write, shell, and web tools as needed. Produce the requested durable artifacts inside the assigned workspace, verify them with the smallest relevant checks, and cite public sources for factual claims. Never invent tool output, external actions, contacts, replies, revenue, or completed approvals. Stop and request approval before spending money, contacting people, publishing, deploying, or changing governance.

Finish with the work completed, artifact paths, verification evidence, limitations or blockers, and the next action.
`,
    "utf8",
  );

  const operatorDirectory = join(root, DEFAULT_AGENTS_DIR, "operator");
  await mkdir(operatorDirectory, { recursive: true });
  await writeFile(
    join(operatorDirectory, "AGENT.md"),
    `---\nid: agent/operator\ntype: Agent\ntitle: "Company Manager"\ndescription: ${JSON.stringify(`Internal non-CLI manager control-loop coordinator for ${companyName}`)}\ntimestamp: ${new Date().toISOString()}\nadapter: ${onboarding.ceoProvider}\n${onboarding.ceoModel ? `model: ${JSON.stringify(onboarding.ceoModel)}\n` : ""}role: operator\nreportsTo: agent/ceo\nmanages: []\npeers: []\nruntime:\n  default: { kind: local }\n---\n\n# Company Manager\n\nThis definition represents the deterministic internal coordinator, not an employee CLI session. Run one bounded control decision at a time. Inspect durable state, schedule the next wakeup, and never execute tools or mutate strategic state outside typed company commands.\n`,
    "utf8",
  );
  await writeFile(
    join(operatorDirectory, "config.yaml"),
    "adapterConfig: {}\nruntimeConfig: {}\n",
    "utf8",
  );
  await writeFile(
    join(operatorDirectory, "tools.yaml"),
    "allow: []\ndeny: []\nrequire_approval_for: []\n",
    "utf8",
  );
  await writeFile(join(operatorDirectory, "skills.lock.json"), "[]\n", "utf8");
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
              "browser_snapshot",
              "edit",
              "read",
              "write",
              "glob",
              "grep",
              "list",
              "webfetch",
              "websearch",
              "todowrite",
              "skill",
              "company_action",
            ]
          : [];
  return `allow:${tools.map((tool) => `\n  - ${tool}`).join("")}\ndeny: []\nrequire_approval_for: []\n`;
}
