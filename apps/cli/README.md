# aaspai

> Self-hosted control plane for AI-agent workforces.

`aaspai` is a CLI for running a team of AI agents (operator, developer,
tester, …) on a file-based config. You define agents, knowledge, and
recurring loops in your project directory; `aaspai` reads them, schedules
work, runs sessions, and records every decision to a local SQLite
database.

## Install

```bash
npm install -g @aaspai/cli
```

After install, the `aaspai` binary is on your PATH.

## Quick start

```bash
mkdir my-project && cd my-project
aaspai init                 # scaffold agents/, knowledge/, loops/
aaspai db migrate           # create the state DB
aaspai agent list           # see the 3 seeded agents
aaspai session start \
  --agent agent/operator \
  --adapter dry_run_local \
  --prompt "say hello"
```

The `dry_run_local` adapter synthesizes a response — no API key
required, no network call. Switch to a real LLM by setting
`adapter: opencode_cli` (or `claude_local`, `codex_local`, …) in
`agents/operator/AGENT.md`.

## What you get

- **File-based config** — agents in `agents/<name>/AGENT.md`, knowledge
  in `knowledge/<concept>/<file>.md` (OKF v0.1), loops in
  `loops/<name>/LOOP.md`. Version your project config in git; the
  runtime state (`.aaspai/state.db`) stays out.
- **Two-storage tier** — your project (versioned) vs. `.aaspai/`
  (gitignored). The CLI enforces the boundary.
- **Eight harness adapters** — `dry_run_local`, `claude_local`,
  `codex_local`, `cursor_local`, `cursor_cloud`, `opencode_local`,
  `opencode_cli`, plus `dry_run_local` as a default. Same agent
  contract, swap adapters per agent.
- **Seven starter loops** — `daily-triage`, `pr-babysitter`,
  `ci-sweeper`, `dependency-sweeper`, `changelog-drafter`,
  `post-merge-cleanup`, `issue-triage`. Only `daily-triage` is wired
  end-to-end today; the rest are stubs for you to extend.
- **Port-and-adapter design** — every external system (filesystem
  watcher, LLM harness, DB) is behind a `Source` interface. Swap
  SQLite for Postgres, or file-based config for a database, without
  touching the orchestration code.

## Subcommands

```
aaspai init          Scaffold a new aaspai project
aaspai db            Database operations (migrate, status, backup)
aaspai agent         Agent operations (list, show, validate)
aaspai knowledge     Knowledge (OKF) operations
aaspai loop          Loop operations (list, show, tick)
aaspai session       Session operations (list, show, start, stop, cancel)
aaspai skill         Skill operations
aaspai tool          Tool operations
aaspai state         Workspace state (counts, recent activity)
aaspai start         Start the worker + API daemons
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Your project (versioned in git)                    │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐               │
│  │ agents/ │ │knowledge/│ │ loops/  │  AGENTS.md    │
│  └────┬────┘ └─────┬────┘ └────┬────┘               │
│       └────────────┴───────────┘                    │
│            FileSource (port+adapter)                │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  aaspai runtime (this CLI)                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐     │
│  │ Scheduler  │→ │ LoopRunner │→ │  Sessions  │     │
│  └────────────┘  └────────────┘  └─────┬──────┘     │
│                                       │             │
│                                  ┌────┴─────┐       │
│                                  │ Harness  │       │
│                                  │ adapters │       │
│                                  └──────────┘       │
└──────────────────────┬──────────────────────────────┘
                       │
                  .aaspai/state.db (gitignored)
```

## Configuration

Each project has an `aaspai.config.ts` at the root:

```ts
import { defineConfig } from "@aaspai/config";

export default defineConfig({
  database: {
    url: process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db",
  },
  organization: { id: "default", name: "My Project" },
  defaults: {
    adapter: "claude_local",
    runtime: { kind: "local" },
  },
  agents:     { root: "./agents" },
  knowledge:  { root: "./knowledge" },
  loops:      { root: "./loops" },
});
```

The CLI also accepts a JSON variant (`aaspai.config.json`).

## Project status

This is a v0 release. The four reliability bugs found in Phase 3
testing are fixed in `@aaspai/cli@0.1.x` and later:

- Atomic wakeup claim (`UPDATE ... WHERE status='queued'`)
- In-flight guard on the 5s poll
- Retry-with-backoff on session errors
- Cross-process file-based lock for `opencode-cli`
- Graceful shutdown (SIGINT/SIGTERM)

See [github.com/aaspai/aaspai](https://github.com/aaspai/aaspai) for
the full monorepo, issues, and architecture docs.

## License

AGPL-3.0-only. See `LICENSE` in the source repo.
