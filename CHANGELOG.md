# Changelog

All notable changes to aaspai are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`opencode_cli` adapter** (`packages/harness`) — spawns the `opencode`
  CLI (installed via `npm i -g opencode-ai`) and parses its `--format
  json` event stream. Auth via `~/.local/share/opencode/auth.json`.
  No API key in env required.
- **`dry_run_local` adapter** — deterministic, no-API-key adapter that
  synthesizes a plan from the prompt. Foundation slice uses this to
  prove the orchestration without external dependencies.
- **`LoopRunner`** (`packages/loops/src/loop-runner.ts`) — composes
  discover + decide + act, runs the session inline, emits an audit
  event. The wiring between the loop engine and the session surface.
- **Dual-dialect DB connection** (`packages/db/src/connection.ts`) —
  `AASPAI_DB=sqlite:./.aaspai/state.db` (default) or
  `postgres://...`. Same Drizzle schema, two drivers.
- **`defineConfig` helper** (`packages/config`) — typed project config
  (`aaspai.config.ts`) with Zod validation.
- **Per-process serialization** of `opencode_cli` calls — the opencode
  CLI uses a single SQLite database (`opencode.db`) and concurrent
  invocations can race on writes.

### Fixed
- `Sessions.execute` no longer sets `errorMessage` to the success-path
  summary; only set for actual failures.
- `apps/cli` package name was `"aaspai"`, colliding with the root
  workspace — renamed to `"@aaspai/cli"`.

### Known issues
- The `opencode_cli` adapter on Windows has known flakiness when called
  in rapid parallel — the CLI sometimes returns non-zero exit codes.
  Per-process serialization mitigates this. Cross-process serialization
  (with leader election) is deferred to Phase 4.

## [0.1.0] — Phase 3 dogfooding

### Added
- `apps/api` — minimal HTTP control plane. Routes: `GET /healthz`,
  `GET /v1/loops`, `POST /v1/loops/:id/fire`, `POST /v1/sessions`,
  `GET /v1/sessions/:id`, `GET /v1/sessions/:id/events` (SSE).
- `apps/worker` — long-lived daemon. Watches `agents/`, `knowledge/`,
  `loops/` via chokidar; ticks the scheduler every 60s; polls queued
  wakeups; runs sessions via `@aaspai/sessions`.
- `apps/cli` — operator + admin tool. The `aaspai` command with
  `init / db / agent / knowledge / loop / session / skill / tool /
  state / start` subcommands.

## [0.0.0] — Phase 2 orchestration library

### Added
- `packages/loops` — the loop engine library: 6 building blocks
  (state, gate, ledger, budget, kill-switch, worktree) + 1 starter
  pattern (`daily-triage`).
- `packages/sessions` — the unified execution surface. Composes harness
  + runtime + skills + knowledge. Wires `onLog` events to the
  `session_events` table.
- `packages/skills` — first-class skill registry with materialization
  per adapter.
- `packages/tools` — tool registry + 12 built-in tools (Read, Write,
  Edit, Bash, WebFetch, WebSearch, QueryDb, ListTables,
  ListSkills, ListAgents, AskUserQuestion, Yield).
- `packages/file-loader` — file-based port implementations. OKF parser,
  chokidar-backed file watcher, composite router for per-agent
  migration.
- `packages/knowledge` — knowledge loader. Resolves an agent's
  `include`/`exclude` patterns, builds a context block.
- Port interfaces in `packages/contracts/sources.ts` —
  `AgentConfigSource`, `KnowledgeSource`, `LoopConfigSource`,
  `SkillSource`, `ToolSource`. Each with `get/has/list/watch/describe`
  (plus `search` for knowledge).

## [0.0.0] — Phase 1 foundation

### Added
- `packages/harness` — adapter registry + 9 harness adapters
  (`claude_local`, `codex_local`, `cursor_local`, `cursor_cloud`,
  `openclaw_gateway`, `hermes_gateway`, `opencode_local`, `opencode_cli`,
  `dry_run_local`).
- `packages/runtime` — execution target registry (local, docker,
  ssh, sandbox). 7 stub drivers.
- Foundation packages: `audit`, `auth`, `config`, `contracts`,
  `crypto`, `db`, `identity`, `observability`, `testing`.
