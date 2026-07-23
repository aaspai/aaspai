# Agents

An **agent** in aaspai is a role with a system prompt, a list of tools, a
set of skills, and a scope of authority. Agents are defined as markdown
files with YAML frontmatter, live in the `agents/` directory, and are
**versioned in git**.

## Why files?

Because a change to an agent is a code change. The system prompt, the
tool allow-list, the skills the agent can use, the agent it reports to —
all of that should be reviewed in a pull request. Storing agents in the
database would make them invisible to git, untestable in CI, and
unchangeable without database access.

## Anatomy of an agent

Every agent is a directory under `agents/<id>/` with these files:

```
agents/
└── developer/
    ├── AGENT.md          # the agent's definition (frontmatter + markdown)
    ├── config.yaml       # adapterConfig + runtimeConfig (typed)
    ├── relations.yaml    # explicit relations to other agents
    ├── skills.lock.json  # pinned skill versions
    └── tools.yaml        # tool allow/deny/require-approval list
```

### `AGENT.md`

The agent's primary definition. The YAML frontmatter carries the
identity and the structural fields; the markdown body is the system
prompt.

```yaml
---
id: agent/developer
type: Agent
title: "Developer"
description: >
  Writes code. Reports to the operator.
timestamp: 2026-07-21T00:00:00Z
adapter: opencode_cli
model: opencode-go/mimo-v2.5
role: engineer
reportsTo: agent/operator
manages: []
peers:
  - agent/tester
tools:
  allow:    [Read, Write, Edit, Bash, ListSkills, AskUserQuestion]
  deny:     []
  require_approval_for: []
skills: []
knowledge:
  include: ["**"]
  exclude: []
runtime: {}
---
```

The important structural fields:

| Field | Meaning |
|---|---|
| `id` | Globally unique identity, e.g. `agent/developer`. Used by relations and loops. |
| `adapter` | Which harness to use (`opencode_cli`, `claude_local`, `codex_local`, `cursor_local`, `dry_run_local`, …). |
| `model` | The model identifier, passed to the harness. |
| `role` | A free-form role label (engineer, operator, tester, …). |
| `reportsTo` / `manages` / `peers` | The org chart. The CEO/parent pattern uses these. |
| `tools` | Allow/deny/require-approval list. Enforced by the runtime. |
| `skills` | Skill references. Skills are versioned separately and pinned in `skills.lock.json`. |
| `knowledge` | Glob include/exclude over the `knowledge/` directory. |

The body of `AGENT.md` is the system prompt. Anything you would put in a
Claude Code or Codex system prompt goes here.

### `config.yaml`

```yaml
adapterConfig: {}
runtimeConfig: {}
```

Per-agent configuration for the chosen adapter and runtime. Kept
separate from `AGENT.md` so the agent's identity stays a clean markdown
file and the typed config can have its own schema.

### `relations.yaml`

Optional explicit relations. Most teams write `reportsTo`, `manages`, and
`peers` directly in `AGENT.md` and leave this empty. Use this file when
relations are dynamic (loaded from a registry, computed at boot, etc.).

### `skills.lock.json`

Pinned skill versions. Skills change independently of agents; this file
makes the skill set reproducible.

### `tools.yaml`

Optional, allows keeping the tool list large and structured. The fields
mirror the `tools:` block in `AGENT.md`.

## The default agents

`aaspai init` scaffolds four agents by default:

- **`ceo`** - the chief of staff and user-facing coordinator. It turns
  requests into goals, delegates through sessions, tracks evidence, and owns
  delivery visibility. It does not write product code.

- **`operator`** — a read-only agent that runs loops, monitors state,
  and triages work. Defaults to `dry_run_local` so it runs without an
  API key. Flip to `claude_local` (or any real harness) when keys are
  available.
- **`developer`** — a write-capable agent that opens PRs. Reports to
  the operator.
- **`tester`** — peers with the developer. Runs the test suite on
  demand.

The defaults are designed so `aaspai` can dogfood `aaspai`: the CEO owns the
goal and delegates, the operator runs `daily-triage` on a cron, the developer
implements, and the tester verifies. Run the CEO through Codex explicitly with
`aaspai chat ceo --adapter codex_local --model gpt-5-codex` when desired.


## Choosing a harness

The `adapter:` field is the only change needed to switch an agent
between harnesses:

| Adapter | Use it for |
|---|---|
| `opencode_cli` | The default. The OpenCode CLI driving any compatible model. |
| `claude_local` | Claude Code, executed locally. |
| `codex_local` | OpenAI Codex CLI, executed locally. |
| `cursor_local` / `cursor_cloud` | Cursor agent. |
| `openclaw` / `hermes` | Custom agentic CLIs. |
| `dry_run_local` | Deterministic, no API key, no cost. Use it for tests and for running the platform without a real model. |

The harness is a port; the driver is an adapter. The same session code
runs against any of them.

## Where to go next

- [Loops](./loops.md) — how agents are scheduled.
- [Knowledge](./knowledge.md) — what agents read at session start.
- [Getting started](../getting-started.md) — initialize a project and
  create your first agent.
