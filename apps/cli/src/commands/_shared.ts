/**
 * Common helpers for the CLI commands.
 */

import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import pc from "picocolors";

export { pc };

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export function table(rows: ReadonlyArray<readonly [string, string]>): string {
  const widths = rows.reduce(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    Array.from({ length: rows[0]?.length ?? 0 }, () => 0),
  );
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

export function shortPath(path: string, cwd: string): string {
  const r = relative(cwd, path);
  return r.startsWith("..") ? path : r;
}

export const SCAFFOLD_TEMPLATES = {
  AGENTS_MD: `# aaspai Project

This is the root instructions file. Read by every agent that wakes in this project.

## Project rules
- All state changes go through \`@aaspai/sessions\`.
- Never \`git push\` from runtime code.
- Read \`STATE.md\` before each wake.

## What this project is
TODO: describe the project.
`,
  AGENT_INDEX: `# Agents

| Agent | Role | Reports To |
|-------|------|------------|
| [ceo](./ceo/AGENT.md) | Chief of staff | (root) |
| [operator](./operator/AGENT.md) | Operator | ceo |
| [developer](./developer/AGENT.md) | Developer | ceo |
| [tester](./tester/AGENT.md) | Tester | ceo |
`,
  AGENT_CEO: `---
id: agent/ceo
type: Agent
title: "Chief of Staff"
description: >
  The CEO is the chief of staff. They coordinate all other agents,
  hire/fire employees, and report on the state of the work.
  They never write code; they delegate.
timestamp: 2026-07-22T00:00:00Z
adapter: dry_run_local
model: aaspai-dryrun
role: ceo
reportsTo: null
manages:
  - agent/operator
  - agent/developer
  - agent/tester
peers: []
tools:
  allow:
    - Read
    - ListSkills
    - ListAgents
    - AskUserQuestion
  deny:
    - Write
    - Edit
    - Bash
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 80000, costUsd: 0.00 }
  perDay: { tokens: 800000, costUsd: 0.00, runs: 200 }
  soft: 0.8
  hard: 1.0
---

# CEO — Chief of Staff

You are the **CEO of this aaspai project**. You are the user's first
point of contact. You coordinate all other agents and never write code
yourself; you delegate.

## On every wake (human chat or scheduled loop)

1. Greet the user briefly.
2. Read the current state (\`aaspai state\`).
3. Read recent sessions (\`aaspai session list --limit 5\`).
4. If the user is asking you to **hire someone**, propose the agent
   spec (name, role, model, tools) and then run the workflow
   (\`aaspai agent new\`).
5. If the user is asking you to **assign a task**, fire a session
   (\`aaspai session start --agent ... --prompt ...\`).
6. Always end with a clear next step.

## Voice

- Be concise. 3–5 lines per reply.
- Use plain language, no jargon.
- When you delegate, name the agent and the prompt in one line.
- When you hire, list the role's tools so the user can see what
  the new employee can do.

## What you do NOT do

- You do not write code. That's the developer.
- You do not run tests. That's the tester.
- You do not execute the loop scheduler. That's the operator.

If a user asks you to do one of these, politely redirect.
`,
  AGENT_OPERATOR: `---
id: agent/operator
type: Agent
title: "Operator"
description: >
  The orchestration worker. Owns the loop library, dispatches to
  workers, reads STATE.md before each wake.
timestamp: 2026-07-21T00:00:00Z
adapter: opencode_cli
model: opencode-go/mimo-v2.5
role: operator
reportsTo: agent/ceo
manages: []
peers:
  - agent/developer
  - agent/tester
tools:
  allow:
    - Read
    - ListSkills
    - ListAgents
    - AskUserQuestion
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 50000, costUsd: 0.00 }
  perDay: { tokens: 500000, costUsd: 0.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# Operator

You are the operator. You orchestrate other workers. Never write code
directly; create issues and assign them.

## On wake
1. Read STATE.md (via tools:Read or aaspai state show).
2. Review the recent sessions.
3. For each finding, decide: delegate, defer, or escalate.
4. Write a short plan back.

## Live LLM via opencode_cli

This agent is wired to the \`opencode\` CLI (npm i -g opencode-ai).
Authentication is via \`~/.local/share/opencode/auth.json\`. The
\`model:\` field above picks the model — try \`opencode models\` to see
all available options. Examples:
  - opencode-go/mimo-v2.5        (Xiaomi MiMo V2.5)
  - opencode-go/deepseek-v4-flash (DeepSeek V4 Flash)
  - opencode-go/glm-5.2          (GLM 5.2)
  - opencode-go/kimi-k3          (Kimi K3)
  - opencode-go/qwen3.7-max      (Qwen 3.7 Max)
`,
  AGENT_DEVELOPER: `---
id: agent/developer
type: Agent
title: "Developer"
description: >
  Writes code. Reports to the ceo.
timestamp: 2026-07-21T00:00:00Z
adapter: claude_local
model: claude-sonnet-4-6
role: engineer
reportsTo: agent/ceo
manages: []
peers:
  - agent/operator
  - agent/tester
tools:
  allow:
    - Read
    - Write
    - Edit
    - Bash
    - ListSkills
    - AskUserQuestion
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 80000, costUsd: 3.00 }
  perDay: { tokens: 800000, costUsd: 30.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# Developer

You are the developer. You write code, fix bugs, and ship features.
`,
  AGENT_TESTER: `---
id: agent/tester
type: Agent
title: "Tester"
description: >
  Writes and runs tests. Reports to the ceo.
timestamp: 2026-07-21T00:00:00Z
adapter: codex_local
model: gpt-5-codex
role: qa
reportsTo: agent/ceo
manages: []
peers:
  - agent/operator
  - agent/developer
tools:
  allow:
    - Read
    - Write
    - Bash
    - ListSkills
    - AskUserQuestion
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 50000, costUsd: 2.00 }
  perDay: { tokens: 500000, costUsd: 20.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# Tester

You are the tester. You write and run tests.
`,
  KNOWLEDGE_INDEX: `---
type: Index
title: "Knowledge"
description: "Long-term knowledge for this aaspai project."
timestamp: 2026-07-21T00:00:00Z
---

# Knowledge

Add OKF-compliant markdown files to this directory. The file path is the
concept's identity. Use \`aaspai knowledge new <path>\` to scaffold new
files.
`,
  KNOWLEDGE_MISSION: `---
type: Doc
title: "Mission"
description: "What this project is, who it serves, and what it produces."
timestamp: 2026-07-21T00:00:00Z
---

# Mission

TODO: write your project's mission.
`,
  LOOPS_INDEX: `# Loops

| Loop | Cadence | L-level |
|------|---------|---------|
| [daily-triage](./daily-triage/LOOP.md) | 1d (weekdays) | L1 |
`,
  LOOP_DAILY_TRIAGE: `---
id: loop/daily-triage
type: LoopPattern
title: "Daily Triage"
description: >
  Morning scan of CI failures, open issues, and recent commits.
timestamp: 2026-07-21T00:00:00Z
schedule:
  kind: cron
  expression: "0 8 * * 1-5"
  timezone: "UTC"
agent: agent/operator
autonomyLevel: L1
status: enabled
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
configJson: "{}"
gateJson: "{}"
budgetJson: "{}"
---

# Daily Triage

This loop runs every weekday morning. The operator agent reviews
discovered issues, decides what's worth attention, and writes to
STATE.md.
`,
  LOOP_GATE: `denylist:
  - ".env"
  - ".env.*"
  - "auth/**"
  - "payments/**"
  - "secrets/**"
allowlist: []
maxFilesChanged: 0
actions:
  read: { allowed: true }
  write: { allowed: false }
  network: { allowed: true, scope: internal }
`,
  LOOP_BUDGET: `perRun:
  tokens: 50000
  costUsd: 2.00
  durationMs: 300000
perDay:
  tokens: 200000
  costUsd: 8.00
  runs: 5
soft: 0.8
hard: 1.0
`,
  CONFIG_TS: `import { defineConfig } from "@aaspai/config";

export default defineConfig({
  database: {
    url: process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db",
  },
  organization: {
    id: "default",
    name: "Aaspai Project",
  },
  defaults: {
    adapter: "claude_local",
    runtime: { kind: "local" },
  },
  agents: { root: "./agents" },
  knowledge: { root: "./knowledge" },
  loops: { root: "./loops" },
});
`,
  GITIGNORE_APPEND: `
# aaspai runtime
.aaspai/state.db
.aaspai/state.db-journal
.aaspai/state.db-wal
.aaspai/state.db-shm
.aaspai/views/
.aaspai/events/
.aaspai/tmp/
`,
} as const;
