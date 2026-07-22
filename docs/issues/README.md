# Open Issues — Phase 3 Operational Bugs

The Phase 3 dogfooding surfaced 4 bugs that need to be filed and fixed. Each has a detailed issue body in this directory. The links below are pre-built to file them on the GitHub web UI with one click.

## How to file the issues

The links below point to GitHub's "New Issue" form with the title and body pre-filled. The body is the contents of the corresponding `00X-*.md` file in this directory.

### 1. opencode-cli serialize bug (priority: high)

> `opencode_cli` sessions run in parallel despite per-process serialization. 3 opencode processes run simultaneously instead of one at a time.

[File this issue →](https://github.com/aaspai/aaspai/issues/new?title=[bug]+opencode_cli+sessions+run+in+parallel+despite+per-process+serialization&body=See+docs/issues/001-opencode-cli-serialize-bug.md)

### 2. wakeup session leak (priority: high)

> Wakeups stuck in `claimed` state with no session row when worker is killed mid-session. 181 stale wakeups currently in production DB.

[File this issue →](https://github.com/aaspai/aaspai/issues/new?title=[bug]+wakeups+stuck+in+claimed+state+with+no+session+row&body=See+docs/issues/002-wakeup-session-leak.md)

### 3. stale wakeup cleanup (priority: medium)

> Worker startup does not clean up stale `claimed` wakeups. 181 wakeups accumulated from test runs.

[File this issue →](https://github.com/aaspai/aaspai/issues/new?title=[bug]+worker+startup+does+not+clean+up+stale+claimed+wakeups&body=See+docs/issues/003-stale-wakeup-cleanup.md)

### 4. poll pile-up (priority: medium)

> 5s poll creates a hidden pile-up: new sessions start before old ones complete.

[File this issue →](https://github.com/aaspai/aaspai/issues/new?title=[bug]+5s+poll+creates+a+hidden+pile-up%3A+new+sessions+start+before+old+ones+complete&body=See+docs/issues/004-poll-pileup.md)

## PR Plan (fix one by one)

| # | PR | Branch | Estimate |
|---|---|---|---|
| 1 | Fix opencode-cli serialize bug | `fix/001-opencode-cli-serialize` | 1-2 hours |
| 2 | Fix wakeup session leak + add stale-claim recovery (covers #2 + #3) | `fix/002-wakeup-leak-recovery` | 1-2 hours |
| 3 | Add poll gate (single in-flight by default) | `fix/004-poll-gate` | 1 hour |
| 4 | Update CHANGELOG + docs | `docs/post-fixes` | 30 min |

Recommended merge order: 1 → 2 → 3 → 4 (each PR builds on the previous one's tests).

## Verification after each fix

```bash
# Build and typecheck
yarn typecheck

# Run the test suite
yarn test

# Manual end-to-end (matches the test we ran together)
mkdir /tmp/aaspai-verify && cd /tmp/aaspai-verify
node /path/to/aaspai/apps/cli/src/cli.ts init
node /path/to/aaspai/apps/cli/src/cli.ts db migrate
node /path/to/aaspai/apps/worker/src/main.ts start --daemon
node /path/to/aaspai/apps/api/src/main.ts start --daemon

# Fire 3 sessions in parallel (operator, developer, tester)
for agent in operator developer tester; do
  curl -X POST http://127.0.0.1:7420/v1/sessions \
    -H "Content-Type: application/json" \
    -d "{\"agentId\":\"agent/$agent\",\"prompt\":\"ping\",\"adapter\":\"opencode_cli\"}" \
    > /dev/null &
done
wait

# Check: 1 opencode process at a time, 3 sessions succeed with real LLM output
tasklist | grep opencode | wc -l    # should be 1
node /path/to/aaspai/apps/cli/src/cli.ts state md  # should show 3 LLM responses
```

## Notes

- The fixes are mostly in `apps/worker/src/daemon.ts` and `packages/harness/src/drivers/opencode-cli/index.ts`
- The DB schema doesn't need to change — only runtime behavior
- Each PR should add a test in `__tests__/` that proves the bug is fixed
- The verification end-to-end test runs against `mimo-v2.5` (free model on the user's opencode auth)
