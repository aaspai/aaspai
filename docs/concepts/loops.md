# Loops

A loop is a versioned recurring-work definition under `.aaspai/loops/`. It
combines a schedule, target agent, gate, budget, and concurrency/catch-up
policy.

```text
.aaspai/loops/<slug>/
|-- LOOP.md
|-- schedule.yaml
|-- gate.yaml
`-- budget.yaml
```

The scheduler converts a timer or manual fire into a durable wakeup. The
worker claims wakeups and routes accepted autonomous work into the governed
work-item/attempt execution path. API request handlers do not run the agent
inline.

## Lifecycle

```text
definition loaded
  -> scheduled or manually fired
  -> durable wakeup
  -> gate/concurrency decision
  -> governed work and attempt
  -> evidence and final status
```

Database rows hold wakeups, claims, outcomes, and history. The Git definition
continues to describe desired recurring behavior.

## Commands

```sh
yarn workspace @aaspai/cli start loop list
yarn workspace @aaspai/cli start loop show loop/daily-triage
yarn workspace @aaspai/cli start loop fire loop/daily-triage
yarn workspace @aaspai/cli start loop pause loop/daily-triage
yarn workspace @aaspai/cli start loop resume loop/daily-triage
```

`dry_run_local` is useful for deterministic validation, but only a real
provider test proves an external CLI execution.

See [Agents](./agents.md) and [Architecture](../architecture.md).
