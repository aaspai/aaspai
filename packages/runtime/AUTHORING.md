# `@aaspai/runtime` — Authoring Notes

In-repo notes for execution target authors. The user-facing guide lives
at the project docs (TBD); this file holds invariants that are easy to
violate from inside a runtime driver.

## No-remote-git contract (cross-run persistence)

The local execution-workspace cwd is the only persistence boundary across
runs. No driver may depend on a git remote for cross-run state.

**Why:** aaspai resolves a local execution workspace (a worktree or a
plain directory) for each run. Code state is carried forward by syncing
that local cwd to wherever the agent actually runs — over ssh, into a
sandbox, into a managed runtime — and then syncing changes back when the
run finishes. Treating a `git remote` as the source of truth breaks
dependent runs gated on the local worktree being caught up, and breaks
isolated execution workspaces that have no remote configured at all.

**How to apply:**

- Never `git push` from runtime code. Never assume the local worktree
  has any `git remote` configured. If you need data from the previous
  run, read it from the local cwd aaspai handed you.
- When running on a different host (ssh, sandbox, remote container), use
  the round-trip helpers in `@aaspai/runtime`:
  `prepareRuntimeForExecution({spec, localDir, remoteDir})` bundles the
  local cwd to the remote dir before the run;
  `restoreRuntimeFromExecution({spec, localDir, remoteDir})` syncs
  remote-side changes (including new git commits) back into the local
  cwd after the run. Both run with no `git remote` configured.
- A failed restore is a run-level error. Do not swallow restore errors.

The invariant is enforced by the static check `scripts/check-no-git-push.mjs`
which fails CI if any unapproved `git push` invocation is added. If you
are building an operator-configured path that legitimately must push,
add a `// aaspai:allow-git-push: <reason>` comment on the line (or the
line above) so the opt-in shows up in code review.

## Runtime contract

Every execution target is a `RuntimeTarget` (see
[`@aaspai/contracts/runtime`](../contracts/src/runtime.ts)) and exposes:

- `info` — `RuntimeTargetInfo` (kind, provider, label, status)
- `run(options)` — runs a process, returns `RunProcessResult`
- `prepareWorkspace(options)` — STUB until L3
- `restoreWorkspace(options)` — STUB until L3

## Sandbox driver contract

Every sandbox driver implements the `SandboxClient` interface (6 methods:
`makeDir`, `writeFile`, `readFile`, `listFiles`, `remove`, `run`) and
the lease lifecycle (`acquire`, `resume`, `release`, `destroy`). See
`packages/runtime/src/shared/sandbox-client.ts`.
