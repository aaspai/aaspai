# Bug 1 — `opencode_cli` sessions run in parallel despite per-process serialization

**Labels:** `bug`, `worker`, `opencode-cli`, `priority:high`

## Summary

`packages/harness/src/drivers/opencode-cli/index.ts` was updated with a per-process `cliChain` queue intended to serialize concurrent `opencode run` invocations. The pattern was verified in isolation (one Node test confirmed f2 starts after f1 completes). But when the worker daemon calls it in production, **3 `opencode.exe` processes run concurrently**, each consuming 150–800 MB of RAM, and racing on the opencode SQLite auth database.

## Reproduction

```bash
# From a fresh project
aaspai init && aaspai db migrate
aaspai-worker start --daemon
aaspai-api start --daemon

# Fire 3 sessions in parallel via the API
for agent in operator developer tester; do
  curl -X POST http://127.0.0.1:7420/v1/sessions \
    -H "Content-Type: application/json" \
    -d "{\"agentId\":\"agent/$agent\",\"prompt\":\"ping\",\"adapter\":\"opencode_cli\"}" \
    > /dev/null &
done
wait

# On Windows, observe 3 opencode.exe processes in tasklist simultaneously
tasklist | grep opencode
# → 3 entries, 150-800 MB each, all running concurrently
```

## Expected

One `opencode.exe` at a time, chained sequentially (f1 → f2 → f3).

## Actual

3 `opencode.exe` processes run in parallel. Memory blows up, and concurrent writes to `~/.local/share/opencode/opencode.db` cause intermittent "exit code 1" failures that look random.

## Hypothesis

Either:
- The worker spawn picks up a cached version of the harness (tsx module cache)
- The `cliChain` variable is being re-initialized per call (module evaluated multiple times)
- A second code path bypasses `serialize()` and spawns the CLI directly

## Acceptance criteria

- [ ] `gh issue body contains 3 sessions fired in parallel`
- [ ] At any point in time, `tasklist | grep opencode | wc -l` returns **1** (the single running CLI)
- [ ] Sessions complete in serial: f1 starts, f1 ends, f2 starts, f2 ends, f3 starts, f3 ends
- [ ] No "exit code 1" or "stream write after end" errors in the worker log
- [ ] End-to-end test: `aaspai state md` shows all 3 sessions with real LLM output
