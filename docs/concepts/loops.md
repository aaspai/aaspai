# Loops

A **loop** in aaspai is a piece of recurring scheduled work. Loops wake
on a schedule, decide whether to run via a gate, cap their work via a
budget, and execute a session against a specific agent.

Loops are the unit of automation. Without loops, aaspai is a
single-shot runner; with loops, it is a workforce.

## Why loops?

Most agent platforms treat "run an agent" as the primitive. That is
fine for a chat product, but it does not match how real work is
structured: a triage that runs every morning, a sweeper that runs when
CI goes red, a changelog drafter that runs when a release is tagged.

Loops make that pattern first-class. A loop is:

- **A schedule** (cron or event)
- **A gate** (should this run right now?)
- **A budget** (how much work is this allowed to do?)
- **An agent** (who runs the work?)
- **A session template** (what does the work look like?)

## Anatomy of a loop

Every loop is a directory under `loops/<id>/`:

```
loops/
└── daily-triage/
    ├── LOOP.md        # the loop's definition (frontmatter + markdown)
    ├── schedule.yaml  # the cron / event schedule
    ├── gate.yaml      # the run / skip decision
    └── budget.yaml    # the cost / time cap
```

### `LOOP.md`

The loop's primary definition. Frontmatter carries the identity and
points to the other files; the markdown body documents what the loop
does.

```yaml
---
id: loop/daily-triage
type: LoopPattern
title: "Daily Triage"
description: >
  Morning scan of CI failures, open issues, and recent commits.
timestamp: 2026-07-21T00:00:00Z
schedule:
  kind: cron
  expression: "0 8 * * 1-5"
  timezone: "UTC"
agent: agent/operator
autonomyLevel: L1
status: enabled
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
configJson: "{}"
gateJson: "{}"
budgetJson: "{}"
---
```

| Field | Meaning |
|---|---|
| `id` | Globally unique identity, e.g. `loop/daily-triage`. |
| `schedule` | A schedule object. `kind: cron` with a 5-field expression, or `kind: event` with a trigger. |
| `agent` | Which agent to wake when the loop fires. |
| `autonomyLevel` | `L0` (fully autonomous) through `L3` (plan only, human runs it). |
| `status` | `enabled` or `paused`. |
| `concurrencyPolicy` | What to do if a run is already in progress: `coalesce_if_active` or `queue` or `skip`. |
| `catchUpPolicy` | What to do for missed runs after a downtime: `skip_missed` or `run_missed`. |

### `gate.yaml`

A small decision script. The gate runs every time the loop wakes. It
can return `run`, `skip`, or `defer`. Typical uses:

- Skip if no CI failures and no new issues since the last run.
- Skip outside business hours.
- Defer until a related PR is merged.

The gate has access to the loop's previous run state and to read-only
query helpers.

### `budget.yaml`

Caps the work the session is allowed to do. Budgets are checked against
`session_events` and the token accounting. Typical entries:

```yaml
maxTokens: 200000
maxWallClockSeconds: 900
maxCostUsd: 1.00
```

The session is killed when any limit is hit. A killed session shows up
in the audit log with the reason.

## How a loop runs

1. The scheduler fires the loop at the next scheduled time.
2. The loop engine loads the loop's `LOOP.md`, `gate.yaml`, and
   `budget.yaml`.
3. The gate runs and returns `run`, `skip`, or `defer`.
4. On `run`, the loop engine builds a `Session` and calls
   `Session.execute()`.
5. `Session.execute()` resolves the harness, the runtime, and the
   knowledge, then streams the result.
6. The final result is written to `sessions`; every event is written to
   `session_events`; the gate's decision and the budget consumption are
   written to the audit log.
7. The CLI can render any of this as a `STATE.md` view you can paste
   into a pull request.

## Autonomy levels

aaspai uses a four-level autonomy model:

| Level | Meaning |
|---|---|
| **L0** | Fully autonomous. The agent acts without human approval. |
| **L1** | Read-only by default; writes require a one-line approval. |
| **L2** | Every state-changing action requires explicit approval. |
| **L3** | The agent only proposes a plan; a human runs it. |

The default `operator` agent is **L1**: it can read anything but cannot
mutate without a token. Flip the agent to **L0** for fully autonomous
mode, or to **L2** for stricter review.

## Where to go next

- [Agents](./agents.md) — what gets woken when a loop fires.
- [Knowledge](./knowledge.md) — what the agent reads at session start.
- [Getting started](../getting-started.md) — see a loop run end-to-end.
