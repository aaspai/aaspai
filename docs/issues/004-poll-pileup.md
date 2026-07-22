# Bug #4 — 5s poll creates a hidden pile-up: new sessions start before old ones complete

**Status:** OPEN · priority:medium
**Labels:** bug, worker

## Symptoms
With `wakeupPollIntervalMs = 5000`, after a slow session starts, the
5s `setInterval` keeps firing. Each fire calls `pollWakeups()` which
walks queued wakeups. If more than one worker (or one worker + a
crashed-then-restarted worker) is running, the queued list is
double-claimed and multiple `opencode.exe` processes spawn.

In our test on Windows we observed 3+ `opencode.exe` processes
running concurrently when 3 wakeups were dispatched rapidly.

## Root cause
`setInterval(() => pollWakeups(), 5_000)` does not guard against
overlap. A `pollWakeups()` invocation that takes 30s will be
re-entered up to 6 times by the interval. The `for (const wakeup of
queued) { await claimAndRun(...) }` loop is synchronous per call, so
it doesn't itself start the 2nd session before the 1st finishes —
but the bug is more visible in two failure modes:

1. Two pollWakeups() invocations can race on the same `queued` row
   if a stale snapshot of the queue was taken before the previous
   mark-as-claimed finished writing. SQLite + better-sqlite3
   serializes writes per process, but reads are not transactionally
   isolated against writes committed in the same process.
2. When a worker is restarted (e.g. by the dev loop), the new
   worker picks up wakeups that the old worker was in the middle
   of. The new worker doesn't know about the in-flight session.

## Fix
Add a single-in-flight semaphore:

```ts
private pollInFlight = false;

private async pollWakeups(): Promise<void> {
  if (this.pollInFlight) {
    log.debug("poll already in flight, skipping tick");
    return;
  }
  this.pollInFlight = true;
  try {
    // existing body
  } finally {
    this.pollInFlight = false;
  }
}
```

In addition, mark wakeups as `claimed` in a single SQL statement
with `WHERE status = 'queued'` so that only one worker can win the
race even across processes (this is the same change as bug #2's
recovery flow — the existing claim uses an UPDATE without a
WHERE-status check, so any number of workers can mark the same
wakeup `claimed` if they read it at the same time).

## Acceptance
- [ ] `yarn test` includes a unit test for the in-flight guard.
- [ ] Manual test: fire 3 wakeups in quick succession, observe
  exactly 1 `opencode.exe` running at a time, all 3 sessions
  complete.
- [ ] Manual test: restart the worker mid-session; the new worker
  does NOT start a second session for the same wakeup.
