<div align="center">

# aaspai

**A self-hosted control plane for running AI-agent workforces on top of agentic CLIs.**

Configuration in files · State in a database · Port/adapter seam throughout

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-blue.svg)](package.json)
[![Yarn 4](https://img.shields.io/badge/yarn-4-blueviolet.svg)](.yarnrc.yml)

</div>

---

## What this is

aaspai orchestrates many AI-agent sessions — running on top of
**any agentic CLI** (Claude Code, Codex, OpenCode, …) — from a single
control plane with:

- **A file-based project** (`agents/`, `knowledge/`, `loops/`) — versioned in git
- **A small HTTP API** + a **long-lived worker daemon** that executes sessions
- **A SQLite-or-Postgres database** for state (sessions, wakeups, audit, budget)
- **A loop engine** that runs scheduled patterns (daily-triage, pr-babysitter, etc.)

The interface to the LLM is a **port**. The default is `dry_run_local`
(no API key needed). Switching to a real model is a one-line change
in the agent's `AGENT.md`.

## Architecture in one diagram

```
┌────────────┐  HTTP  ┌────────────┐  enqueue  ┌──────────────┐
│   cli      │ ─────► │   api      │ ────────► │  wakeups.db  │
│ (operator) │        │ (Hono)     │           └──────┬───────┘
└────────────┘        └────────────┘                  │
                            │                          ▼
                            │ reads                ┌──────────────┐
                            ▼                     │  worker      │
                      ┌────────────┐             │  (daemon)    │
                      │  state.db  │ ◄─────────── │  - scheduler │
                      │  (SQLite)  │              │  - wakeup    │
                      └────────────┘              │  - sessions  │
                                                  └──────┬───────┘
                                                         │
                                                         ▼
                                                  ┌──────────────┐
                                                  │  harness     │
                                                  │  (opencode_  │
                                                  │   cli, etc.) │
                                                  └──────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Quick start

```bash
# 1. Install
corepack enable
yarn install

# 2. Scaffold a project in a new workspace
mkdir my-project && cd my-project
node ../apps/cli/src/cli.ts init
node ../apps/cli/src/cli.ts db migrate

# 3. Start the daemons
node ../apps/worker/src/main.ts start --daemon
node ../apps/api/src/main.ts start --daemon

# 4. Trigger a session
curl -X POST http://127.0.0.1:7420/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"agentId":"agent/operator","prompt":"reply with just the word pong","adapter":"dry_run_local"}'

# 5. Render STATE.md
node ../apps/cli/src/cli.ts state md > STATE.md
```

To switch from `dry_run_local` to a real LLM, edit `agents/operator/AGENT.md`
and set `adapter: opencode_cli` (or `claude_local`, etc.) and
`model: opencode-go/mimo-v2.5` (or whichever model). No code changes.

## Workspace layout

```
your-aaspai-project/
├── .aaspai/                        ← runtime state (gitignored)
│   ├── state.db                    SQLite database
│   ├── worker.log / api.log        daemon logs
│   └── worker.pid / api.pid        daemon PIDs
├── aaspai.config.ts                 ← project config (versioned)
├── agents/                          ← your company (versioned)
│   ├── _index.md
│   ├── operator/AGENT.md, config.yaml, tools.yaml, ...
│   ├── developer/...
│   └── tester/...
├── knowledge/                       ← OKF knowledge (versioned)
│   ├── _index.md
│   ├── company/mission.md
│   └── ...
├── loops/                           ← loop configs (versioned)
│   ├── daily-triage/LOOP.md, gate.yaml, budget.yaml
│   └── ...
├── tools/                           ← tool configs (versioned)
└── aaspai.config.ts                 ← project config (versioned)
```

## Packages

| Package | Purpose |
|---|---|
| `apps/cli` | The `aaspai` command — operator + admin tool |
| `apps/api` | The HTTP control plane (Hono, port 7420) |
| `apps/worker` | The long-lived execution daemon |
| `packages/harness` | Adapter registry + 9 harness adapters (claude, codex, cursor, opencode, hermes, openclaw, dry-run) |
| `packages/runtime` | Execution target registry (local, docker, ssh, sandbox) |
| `packages/loops` | Loop engine: 6 building blocks (state, gate, ledger, budget, kill-switch, worktree) + 1 starter pattern (daily-triage) + LoopRunner |
| `packages/sessions` | Unified execution surface (compose harness + runtime + skills + knowledge) |
| `packages/skills` | Skill registry + materializer |
| `packages/tools` | Tool registry + 12 built-ins |
| `packages/file-loader` | File-based port implementations (OKF parser, watcher, composite router) |
| `packages/knowledge` | Knowledge loader (resolves agent's include/exclude patterns) |
| `packages/db` | Drizzle schema + dual-dialect connection factory (SQLite ↔ Postgres) |
| `packages/contracts` | The seam — all port interfaces + Zod schemas + protocol versions |
| `packages/config` | `defineConfig` helper for the project's `aaspai.config.ts` |
| `packages/observability` | Structured JSON logger + progress reporter |
| `packages/identity` | Actor model (user / agent / system) |
| `packages/auth` | BetterAuth + InMemory adapters |
| `packages/audit` | Immutable append-only event log |
| `packages/testing` | Shared contract test suites (describeIdentityVerifierContract, etc.) |

## Scripts

```bash
yarn install              # corepack + dependencies
yarn build                # build all packages
yarn test                 # run all tests
yarn lint                 # biome
yarn typecheck            # tsc --noEmit across all workspaces
```

## Documentation

- [`docs/concept.md`](docs/concept.md) — what aaspai is and the ideas
  behind it
- [`docs/architecture.md`](docs/architecture.md) — the four layers, the
  file/DB split, the port/adapter seam
- [`docs/getting-started.md`](docs/getting-started.md) — install, init,
  run your first agent
- [`docs/deployment.md`](docs/deployment.md) — production deployment with
  Postgres
- [`docs/concepts/agents.md`](docs/concepts/agents.md),
  [`docs/concepts/loops.md`](docs/concepts/loops.md),
  [`docs/concepts/knowledge.md`](docs/concepts/knowledge.md) — per-concept
  deep dives
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release

## License

[AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) for the
contribution workflow, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for
community norms, and [SECURITY.md](SECURITY.md) for private
vulnerability reporting.
