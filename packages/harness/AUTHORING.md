# `@aaspai/harness` — Authoring Notes

In-repo notes for adapter authors. The user-facing guide lives at the
project docs (TBD); this file holds invariants that are easy to violate
from inside an adapter.

## No-remote-git contract (cross-run persistence)

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

**Why:** aaspai resolves a local execution workspace (a worktree or a
plain directory) for each run. Code state is carried forward by syncing
that local cwd to wherever the agent actually runs — over ssh, into a
sandbox, into a managed runtime — and then syncing changes back when the
run finishes. Treating a `git remote` as the source of truth (`git push`
from inside the agent, fetch on the next wake) breaks dependent runs
that are gated on the local worktree being caught up, and breaks
isolated execution workspaces that have no remote configured at all.

**How to apply:**

- Never `git push` from adapter runtime code. Never assume the local
  worktree has any `git remote` configured. If you need data from the
  previous run, read it from the local cwd aaspai handed you.
- If your adapter runs the agent on a different host (ssh, sandbox,
  remote container), use the round-trip helpers in `@aaspai/runtime`:
  `prepareRuntimeForExecution({spec, localDir, remoteDir})` bundles the
  local cwd to the remote dir before the run, and
  `restoreRuntimeFromExecution({spec, localDir, remoteDir})` syncs
  remote-side changes (including new git commits) back into the local
  cwd after the run. Both run with no `git remote` configured.
- If your adapter runs the agent locally, you can read and write the
  cwd directly — same invariant applies: changes that future runs need
  must live in the local cwd by the time `execute()` returns.
- A failed restore is a run-level error. Do not swallow restore errors.

The invariant is enforced by the static check `scripts/check-no-git-push.mjs`
(scans `packages/harness/`, `packages/runtime/`, and any app source)
which fails CI if any unapproved `git push` invocation is added. If you
are building an operator-configured path that legitimately must push,
add a `// aaspai:allow-git-push: <reason>` comment on the line (or the
line above) so the opt-in shows up in code review.

## Adapter contract

Every adapter is a `ServerAdapterModule` (see
[`@aaspai/contracts/harness`](../contracts/src/harness.ts)). It must
expose:

- `info` — `AdapterInfo` (type, label, transport, models, doc, status)
- `execute(ctx)` — runs the agent once, returns `AdapterExecutionResult`
- `testEnvironment(ctx)` — health checks, returns
  `AdapterEnvironmentTestResult`

Optional capabilities follow the same shape as `@paperclipai/adapter-utils`
and are not part of the foundation slice.
