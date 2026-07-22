# Bug 2 — Wakeups stuck in `claimed` state with no session row

**Labels:** `bug`, `worker`, `db`, `priority:high`

## Summary

`WorkerDaemon.claimAndRun` sets `wakeups.status = "claimed"` and `claimedAt = now()` **before** creating the session row. If the worker is killed (Ctrl+C, OOM, machine restart) between the claim and the session insert, the wakeup is permanently stuck in `claimed` with no associated session. There is no retry or recovery path — the wakeup never gets processed again.

The current production DB has **181 wakeups in `claimed` state** accumulated from previous test runs. They block the queue, distort statistics, and silently absorb any future retry attempts that match by id.

## Reproduction

```bash
# Start the worker
aaspai-worker start --daemon

# Fire a session
curl -X POST http://127.0.0.1:7420/v1/sessions -d '...'

# Within ~100ms, kill the worker
pkill -9 -f worker.*src/main

# Restart the worker
aaspai-worker start --daemon

# The wakeup is permanently in 'claimed' state, never gets reprocessed
aaspai session list
# → shows 1 row with status=running (because we don't update the session either)
```

## Expected

Wakeup either transitions to `running` (with a session) or is marked `failed` and is eligible for a retry. The worker restart should not leave dangling claims.

## Actual

Wakeup is stuck in `claimed` forever. Sessions row never created. The `claimed_at` timestamp is the only record of the failure. No way to detect, retry, or clean up.

## Acceptance criteria

- [ ] Wakeup transitions: `queued → running (with session_id) → completed/failed`
- [ ] `claimAndRun` is wrapped in a try/finally that marks the wakeup `failed` (or `queued` for retry) if the session row creation fails
- [ ] On worker startup, any wakeup in `claimed` state for more than N minutes is marked `failed` (stale-claim recovery)
- [ ] Tests: simulate the race (kill the worker between claim and session insert) and verify the wakeup is recovered on restart
