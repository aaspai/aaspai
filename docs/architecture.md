# Architecture

This page describes the architecture implemented by this repository. Design
proposals and dated validation reports live in the internal `study/` directory
when present and are not product guarantees.

## System shape

```text
Human / automation
       |
       +---------------- CLI ------------------+
       |                                       |
       +---------------- Web ------------------+---> API control plane
                                               |       (Hono)
                                               v
                                      durable SQLite state
                                               ^
                                               |
                                   worker scheduler/executor
                                               |
                         workspace -> runtime -> harness -> agentic CLI
                                               |
                                  events, output, artifacts, evidence
```

The API and web app control state and enqueue work. The worker is the only
autonomous execution owner.

## Applications

| Application | Responsibility |
|---|---|
| `@aaspai/api` | Hono control plane for health, loops, sessions, providers, execution, strategic views, and company operations. |
| `@aaspai/worker` | Durable wakeup recovery, scheduling, capacity/lease handling, company-action brokerage, attempts, retries, and execution. |
| `@aaspai/cli` | Workspace setup, database operations, definitions, manual sessions, provider checks, goals, loops, state, and daemon operation. |
| `@aaspai/web` | Next.js command center for onboarding, company/portfolio, goals/projects, execution, governance, knowledge, memory, and evidence. It currently uses trusted server-side local workspace/database access. |

## Durable domain flow

Strategic company work uses this hierarchy:

```text
Company profile
  -> Goal
  -> Project
  -> Milestone
  -> Process definition + process binding
  -> WorkflowRun
  -> OperatorRun + control decisions
  -> WorkItems + dependencies
  -> AgentAttempt(s)
  -> HarnessSession + Workspace + Runtime lease
  -> events / raw output / artifacts
  -> verification / approval / delivery or escalation
```

Not every manual session has the complete strategic hierarchy. A manual chat
is a bounded session path. Autonomous work must use durable work items and
attempts so retries, cancellation, evidence, and recovery remain queryable.

## Control lanes

Execution observation separates three lanes:

| Lane | Meaning | Examples |
|---|---|---|
| `company` | A validated organizational mutation | `hire_and_delegate`, `create_milestone`, `define_and_start_process`, `company_action` |
| `work` | Agent work inside an assigned attempt | file edits, shell/tool calls, research, declared deliverables |
| `system` | Runtime and control-plane lifecycle | claim, workspace setup, CLI start, retry, cancel, failure, cleanup |

Agent prose is not a company mutation. A native CLI must submit a typed
company action through the attempt-scoped broker; the worker validates and
records the resulting durable IDs. The observer is a read model over durable
execution/company records, not a second state store.

## Sources of truth

| Concern | Canonical source |
|---|---|
| Agent, loop, and knowledge definitions | Git-backed files under `.aaspai/` |
| Project configuration | `.aaspai/aaspai.config.ts` |
| Goals, projects, work items, runs, attempts, claims, approvals, budgets, and governance | SQLite database by default; Postgres support exists but is not fully production-verified |
| Company departments, authority, routing, delegations, escalations, service agents, and autonomy proposals | Database company/control tables |
| Raw execution output and normalized events | Execution evidence tables, with durable artifact files referenced by database rows |
| Operational memory | Scoped database records with provenance |
| Accepted knowledge | Reviewed Markdown files under `.aaspai/knowledge/` |
| Product deliverables | Governed commits, pull requests, artifacts, or approved external actions |
| Provider credentials | Native CLI/platform credential stores or short-lived attempt/runtime credentials; never definition files |

Definitions describe desired behavior and are pinned by revision for a run.
Runtime state must not silently rewrite Git-backed definitions.

## Package ownership

| Layer | Main packages | Owns |
|---|---|---|
| Foundation | `contracts`, `config`, `db`, `identity`, `auth`, `audit`, `crypto`, `git`, `observability`, `testing` | Schemas, persistence, identity, authorization, audit, logging, and provider-neutral contracts |
| Definitions and agent capabilities | `file-loader`, `skills`, `tools`, `knowledge` | Git-backed definitions and resolved agent inputs |
| Coordination and company control | `loops`, `company` | Schedules, process compilation, strategic projections, authority, company commands, governance views |
| Execution fabric | `execution`, `sessions`, `harness`, `runtime` | Work-item lifecycle, plans, attempts, workspaces, leases, CLI invocation, restore, cancellation, and evidence |
| Applications | `apps/cli`, `apps/api`, `apps/worker`, `apps/web` | User/control surfaces and process ownership |

`@aaspai/execution` remains the source of truth for work-item and attempt
state. `@aaspai/company` may project and mutate company-level records, but it
must not create a competing task queue.

## Attempt execution

Every governed attempt pins an immutable execution plan containing the
definition revision, agent/profile inputs, repository target, harness, runtime
configuration, prompt, timeout, and workspace policy.

```text
claim WorkItem and capacity locks
  -> create AgentAttempt
  -> create immutable ExecutionPlan
  -> acquire isolated Workspace / EnvironmentLease
  -> materialize skills, knowledge, instructions, and tools
  -> run HarnessAdapter in the selected RuntimeTarget
  -> persist lifecycle/events/raw output
  -> restore changes and collect declared artifacts
  -> verify and apply approval/delivery policy
  -> complete, retry, cancel, or escalate
```

The harness owns CLI command construction, provider parsing, usage, and
provider session IDs. The runtime owns environment identity, workspace
transfer, process execution, and cleanup. The worker/execution store owns
durable control, not the CLI.

Retries create a new attempt and preserve the original attempt/session
evidence. Cancellation and interruption are durable requests that the worker
propagates to the live process when it is running.

## Loops and recurring processes

File-defined loops are scheduled into durable `WorkflowRun`/wakeup state. A
process binding can start a repeatable project process, and a valid interval or
cron policy can queue its next occurrence after the current run settles. The
same operator/workflow lineage is retained where the process supports resume.

Wakeups are scheduler signals, not the business work model. Startup recovery
reconciles stale claims and missed executable wakeups before normal polling.

## Runtime and authentication boundaries

The selected agentic CLI runs inside the selected runtime target: local,
Docker, SSH, or a configured sandbox provider. Harness adapters do not own
runtime behavior, and runtime targets do not interpret provider output.

The control plane does not call an LLM API directly. Local Codex/OpenCode runs
use each CLI's native authentication. Managed remote execution is intended to
use short-lived, attempt-scoped credentials; permanent host credentials are
not copied into disposable sandboxes.

Use the executable capability and doctor commands before real work:

```sh
yarn workspace @aaspai/cli start provider capabilities
yarn workspace @aaspai/cli start provider doctor
```

## Current boundaries

- SQLite at `.aaspai/state.db` is the default and best-verified topology.
- Postgres primitives exist, but full autonomous/company-control parity is not
  a production claim.
- `dry_run_local` validates orchestration deterministically; it is not proof of
  a real provider integration.
- Remote runtime acceptance is environment-dependent. Local company-control
  execution is validated; remote company-control parity still requires the
  selected runtime's authenticated bridge and acceptance tests.
- The web app is a trusted local/server-side control surface, not a separately
  hardened stateless multi-tenant frontend.
- Worker concurrency is intentionally conservative and should be increased
  only with measured provider/runtime capacity and recovery evidence.

See [Deployment](./deployment.md), [Getting started](./getting-started.md),
and [Harnesses and execution runtimes](./execution-runtimes.md).
