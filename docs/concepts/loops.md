# Loops

A loop is a versioned recurring-work definition under `.aaspai/loops/`. It
combines a schedule, target agent, gate, budget, and concurrency/catch-up
policy.

```text
.aaspai/loops/<slug>/
|-- LOOP.md
|-- gate.yaml
`-- budget.yaml
```

The scheduler converts a timer or manual fire into a durable wakeup. The
worker claims wakeups and routes accepted autonomous work into the governed
work-item/attempt execution path. API request handlers do not run the agent
inline.

`LOOP.md` owns the schedule, autonomy level, and instructions. `gate.yaml` and
`budget.yaml` are parsed and validated when the definition loads; invalid
policy disables the loop instead of silently falling back to an empty policy.
File definitions override matching starter-pattern metadata.

## Lifecycle

```text
definition loaded
  -> scheduled or manually fired
  -> durable pause and catch-up check
  -> durable wakeup
  -> state, budget, gate, and concurrency decision
  -> governed work and attempt
  -> actual-diff gate, independent verification, approval, and delivery
  -> evidence and durable state for the next run
```

Database rows hold wakeups, claims, outcomes, and history. The Git definition
continues to describe desired recurring behavior.

## Commands

```sh
yarn workspace @aaspai/cli start loop list
yarn workspace @aaspai/cli start loop create release-notes
yarn workspace @aaspai/cli start loop show loop/daily-triage
yarn workspace @aaspai/cli start loop fire loop/daily-triage
yarn workspace @aaspai/cli start loop pause loop/daily-triage
yarn workspace @aaspai/cli start loop resume loop/daily-triage
```

`dry_run_local` is useful for deterministic validation, but only a real
provider test proves an external CLI execution.

See [Agents](./agents.md) and [Architecture](../architecture.md).
