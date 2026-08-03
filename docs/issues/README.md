# Historical issues — Phase 3 operational bugs

These records came from Phase 3 dogfooding. They are preserved as incident
history and regression-test context; they are not an active backlog. The
repository contains regression coverage for the serialization, stale-claim
recovery, poll-gating, and managed-runtime paths.

## Records

| Record | Current disposition |
|---|---|
| [001](./001-opencode-cli-serialize-bug.md) | Fixed path covered by OpenCode serialization tests; rerun real-provider acceptance before claiming production readiness. |
| [002](./002-wakeup-session-leak.md) | Fixed by durable wakeup/attempt settlement and failure recovery; keep the restart tests. |
| [003](./003-stale-wakeup-cleanup.md) | Fixed by worker startup stale-claim reconciliation; keep the stale-claim tests. |
| [004](./004-poll-pileup.md) | Fixed by the worker in-flight poll gate; do not add parallelism without a capacity decision. |
| [005](./005-managed-runtime-bypass.md) | Resolved; runtime identity and environment isolation remain acceptance boundaries. |

## Reverification

```sh
yarn typecheck
yarn lint
yarn test
```

For real-provider and runtime acceptance, use the commands in
[`../execution-runtimes.md`](../execution-runtimes.md). Any future change to
these paths should add or update a focused regression test.
