# Bug 4 — 5s poll creates a hidden pile-up: new sessions start before old ones complete

**Labels:** `bug`, `worker`, `priority:medium`

## Summary

`WorkerDaemon.pollWakeups()` runs every 5 seconds. It calls `claimAndRun` for each queued wakeup, with an `await` in the for loop. While the `await` should serialize within a single tick, **the NEXT tick fires 5 seconds later and starts new wakeups even if previous ones are still running**.

Combined with the opencode-cli serialize bug (#1), this means:
- Tick 1: starts 3 wakeups in sequence
- Tick 2 (5s later): starts another batch
- Tick 3: another batch
- The "running wakeups" count in the DB grows unboundedly
- The opencode CLI process count grows unboundedly
- Memory grows unboundedly

The poll should either:
1. Skip ticks while sessions are running, OR
2. Have a max in-flight limit (e.g. 5) and wait for one to finish before starting another

## Reproduction

```bash
# Fire 10 sessions in rapid succession (each takes ~30-60s)
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -X POST http://127.0.0.1:7420/v1/sessions \
    -H "Content-Type: application/json" \
    -d '{"agentId":"agent/operator","prompt":"ping","adapter":"opencode_cli"}' &
done
wait

# Wait 30 seconds
sleep 30

# Count running opencode processes
tasklist | grep opencode | wc -l
# → 10+ (should be 1 if serialization works)
```

## Expected

At any moment, ≤ 1 opencode process is running (after #1 is fixed). If the user wants parallelism, they can configure a max-in-flight concurrency (e.g. 3).

## Actual

Up to 10+ opencode processes running simultaneously. Memory grows. Sessions complete in random order, sometimes with "exit code 1" errors from the opencode CLI racing on its auth database.

## Acceptance criteria

- [ ] Single in-flight opencode process at any moment (after #1)
- [ ] Optional: `AASPAI_MAX_INFLIGHT` env var to allow N concurrent opencode calls (default 1)
- [ ] The poll loop checks if there's an in-flight session before starting a new one, OR uses a semaphore
- [ ] Worker startup logs the in-flight count
- [ ] End-to-end: fire 10 sessions, only 1 opencode process exists at a time
