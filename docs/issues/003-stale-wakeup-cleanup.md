# Bug 3 — Worker startup does not clean up stale `claimed` wakeups

**Labels:** `bug`, `worker`, `db`, `priority:medium`

## Summary

When a worker is killed mid-session (Ctrl+C, OOM, machine restart), any wakeup it was processing is left in `claimed` state. On worker restart, the worker polls `queued` wakeups and never touches the stale `claimed` ones. The wakeup queue grows forever.

The current production DB has **181 stale `claimed` wakeups** from previous test runs. They pollute metrics, block queue inspection, and confuse users.

## Reproduction

```bash
aaspai-worker start --daemon
# Fire some sessions, kill the worker mid-session
pkill -9 -f worker
aaspai-worker start --daemon
aaspai db status
# → wakeups table shows dozens of stuck "claimed" rows
```

## Expected

Worker startup should run a recovery pass that marks any `claimed` wakeups older than N minutes (e.g. 5 min) as `failed` (with reason "stale claim: worker restarted"). This is a standard worker-recovery pattern (paperclip has `recoverStaleWorkRuns` in `apps/worker/src/handlers/`).

## Acceptance criteria

- [ ] On worker startup, run a single SQL: `UPDATE wakeups SET status='failed', error='stale claim' WHERE status='claimed' AND claimed_at < now() - interval '5 minutes'`
- [ ] Log the count of recovered wakeups
- [ ] Tests: insert a stale `claimed` wakeup, start the worker, verify it's marked `failed`
- [ ] The "running wakeups" count in `aaspai db status` accurately reflects in-flight work, not stale ghosts
