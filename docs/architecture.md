# Architecture

A high-level tour of how aaspai is put together. The deep dive (with the
phase plan, the storage model, and the CLI reference) lives in the
private `study/` directory; this document covers only the public shape.

## The four layers

aaspai is built in layers. Each layer depends only on the layers below it.

```
┌─────────────────────────────────────────────────────────────────────┐
│  L4  ORCHESTRATION              (deferred)                          │
│      parent agent (CEO) · workers · projects · tasks                │
│      heartbeat · policies · channels · memory                      │
├─────────────────────────────────────────────────────────────────────┤
│  L3  LOOPS + SESSIONS + SKILLS + TOOLS                              │
│      loops library · unified execution surface · skill registry    │
│      tool registry · knowledge layer · file-loader                 │
├─────────────────────────────────────────────────────────────────────┤
│  L2  RUNTIME / EXECUTION TARGETS                                   │
│      local · docker · ssh · sandbox (e2b · daytona · cloudflare)   │
├─────────────────────────────────────────────────────────────────────┤
│  L1  ADAPTERS / HARNESS                                            │
│      claude_local · codex_local · cursor · opencode_local         │
│      opencode_cli · openclaw · hermes · dry_run_local              │
├─────────────────────────────────────────────────────────────────────┤
│  L0  FOUNDATION                                                    │
│      contracts · config · observability · identity · auth          │
│      audit · db · crypto · testing                                  │
└─────────────────────────────────────────────────────────────────────┘
```

| Layer | Role | Representative packages |
|---|---|---|
| **L0 Foundation** | Ports, adapters, crypto, and the storage seam. Every other layer depends on this. | `contracts`, `db`, `auth`, `identity`, `audit`, `crypto`, `config`, `observability`, `testing` |
| **L1 Adapters / Harness** | Speak to a specific agentic CLI: Claude Code, Codex, Cursor, OpenCode (CLI or local), OpenClaw, Hermes, or a deterministic dry-run. | `harness` |
| **L2 Runtime / Execution** | Where the agent actually executes: a local subprocess, a Docker container, a remote SSH host, or a cloud sandbox. | `runtime` |
| **L3 Orchestration** | The reusable orchestration library: sessions, skills, tools, loops, knowledge, file loading. | `sessions`, `skills`, `tools`, `loops`, `knowledge`, `file-loader` |
| **L4 Orchestration** (future) | The CEO/parent-agent pattern, multi-project workspaces, heartbeat, channels. | (deferred) |

## Configuration vs state

aaspai deliberately splits storage into two tiers:

| Tier | What's in it | Format | Backed by | Versioned |
|---|---|---|---|---|
| **Configuration** | agents, knowledge, loops, gates, skills, harnesses | Markdown + YAML frontmatter | Files in the repo | **Yes — git** |
| **State** | wakeups, sessions, events, budget, audit | SQL tables | SQLite locally, Postgres in prod | No — append-only by row |

The rule is simple: **if a human wrote it, it's a file. If the system
wrote it during a run, it's a row.**

This means:

- A change to an agent is a pull request, not a database migration.
- A change to the runtime is a release, not a config change.
- A change to *what happened* is a new row in the events table, not an
  edit to a log file.

## The port/adapter seam

The single most important abstraction in aaspai is the
**port/adapter pattern** for storage. There are three ports, all defined
in [`packages/contracts/`](https://github.com/aaspai/aaspai/tree/main/packages/contracts):

- `AgentConfigSource` — load agents from somewhere (file by default, DB
  later)
- `KnowledgeSource` — load knowledge chunks from somewhere
- `LoopConfigSource` — load loop definitions from somewhere

The default implementation in `packages/file-loader/` reads them from
the working tree. The default storage for state in `packages/db/` reads
SQLite. Adapters in `packages/db/` also support Postgres.

The seam lets the same orchestration code run against:

- A local file tree + SQLite (development)
- A remote git repository + Postgres (production)
- An in-memory fixture (tests)

## The three apps

aaspai ships three deployable applications in
[`apps/`](https://github.com/aaspai/aaspai/tree/main/apps):

- **`@aaspai/api`** — Hono-based HTTP API. Serves queries, webhooks,
  and the public read surface. Backed by `packages/db`.
- **`@aaspai/worker`** — The long-running daemon that executes
  scheduled loops, runs sessions, and writes events to the database.
- **`@aaspai/cli`** — The `aaspai` command. Use it to initialize a
  project, inspect state, run an agent, and stream a session.

All three depend on the same shared packages; there is no private
"internal" API between them.

## The runtime data flow

A single session in steady state looks like this:

```
  1. Scheduler fires a loop  ──►  loop engine  (packages/loops)
  2. Loop engine reads gate  ──►  gate decides run / skip
  3. Run accepted             ──►  build a Session
  4. Session.execute()       ──►  packages/sessions
  5. Resolve harness         ──►  packages/harness (port)
  6. Resolve runtime         ──►  packages/runtime  (port)
  7. Stream TranscriptEntry  ──►  session_events table
  8. Final result            ──►  sessions row + audit log
```

## Where to go next

- Read [Concept](./concept.md) to see why the design is shaped this way.
- Read [Getting started](./getting-started.md) to install aaspai and run
  your first session.
- For per-concept deep dives, see
  [Agents](./concepts/agents.md), [Loops](./concepts/loops.md), and
  [Knowledge](./concepts/knowledge.md).
