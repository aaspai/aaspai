# aaspai Project

Read this file before every agent wake. It is the shared operating contract
for the aaspai control plane.

## What this project is

aaspai is a local-first control plane for AI-agent workforces. Agents are
versioned file-based roles. Sessions are the only execution surface, and the
session database is the audit trail for prompts, results, and events.

## Non-negotiable rules

- Read `STATE.md`, the relevant agent definitions, and recent session history
  before acting on an existing task.
- Keep configuration in versioned files under `agents/`, `knowledge/`, and
  `loops/`. Keep runtime state under `.aaspai/`.
- All agent execution and state changes go through the aaspai session/runtime
  APIs. Do not invent a second orchestration path.
- Never put secrets in prompts, logs, commits, or agent files.
- Runtime code never pushes to Git. GitHub changes are performed by an
  explicitly delegated worker using GitHub CLI and are reported back.
- Branch names must be descriptive and must not contain `codex`.
- A major issue discovered during work is recorded locally in
  `docs/issues/<number>-<slug>.md` with evidence and next action. Do not open
  a GitHub issue unless the human asks for one.

## Standard work loop

1. Convert the request into one measurable goal and acceptance criteria.
2. Inspect the current state and existing implementation before proposing work.
3. Create a focused branch, then delegate implementation and validation.
4. Review the diff, run focused checks, and open a pull request with GitHub CLI.
5. Check CI and the PR, fix every actionable failure, then merge only when
   checks pass and the change is understood.
6. Update `STATE.md` with the goal, sessions, decisions, blockers, and next step.

## Reset protocol

When the human says "reset" or starts a new task, keep the repository and
audit history but discard stale conversational assumptions. Re-read this
file, `STATE.md`, recent sessions, and the current branch/diff. Summarize
what is known, identify unfinished work, and establish a new goal before
delegating. If the human asks for Codex, use the existing `codex_local`
adapter explicitly; do not create a new adapter or bypass session logging.
