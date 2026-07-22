# Bug #1 — opencode_cli sessions run in parallel despite per-process serialization

**Status:** CLOSED via PR #8
**Labels:** bug, worker, opencode-cli, priority:high

## Symptoms
On Windows, when 3 wakeups were dispatched in quick succession,
3 separate `opencode.exe` processes appeared in Task Manager
simultaneously. The cliChain serializer was supposed to prevent
this but it didn't.

## Root cause
The cliChain only serialized within a single Node process. The
worker had no in-flight guard on its 5s `setInterval`, so 3 polls
could each fire `claimAndRun` before the first session's
`opencode.exe` exited. Combined with no cross-process lock, two
worker processes could both call `opencode run` at the same time
and race on the opencode SQLite DB at
`~/.local/share/opencode/opencode.db`.

## Fix (PR #6 + PR #8)
- **PR #6 (worker):** in-flight guard on `pollWakeups`, atomic
  claim (`UPDATE ... WHERE status='queued'`), retry-with-backoff,
  graceful shutdown. Now the worker itself only starts one session
  at a time.
- **PR #8 (this fix, opencode-cli):** file-based cross-process
  advisory lock at `${tmpdir}/aaspai-opencode.lock`. The lock
  contains the holder's PID + hostname. Stale locks (PID not
  running) are stolen. Same-process calls go through the existing
  cliChain. Cross-process calls block on the file lock with a
  50ms × 200 = 10s max wait, then throw a timeout error which
  becomes a wakeup retry via PR #6's retry-with-backoff.

## Acceptance
- [x] Unit test: 3 concurrent `opencodeCli.execute()` calls keep
  peak concurrent children ≤ 1 (`packages/harness/__tests__/opencode-cli-serialize.test.ts`).
- [x] Unit test: lock is acquired and released between calls.
- [ ] Manual: 2 worker processes firing in parallel don't both
  run `opencode` (verified via `tasklist | grep opencode`).
- [x] Monorepo: 275+ tests pass, typecheck clean.
