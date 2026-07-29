# Architecture

This document describes the current repository. Future architecture is
tracked separately and is not implied by this page.

## System shape

```text
Human / automation
        |
        v
CLI ----+---- Web command center
        |             |
        v             v
             API control plane
                    |
                    v
          durable database state
                    ^
                    |
       Worker: scheduler + executor
                    |
                    v
 workspace -> runtime -> agentic CLI
                    |
                    v
       events, artifacts, verification
```

The repository has four applications:

| Application | Current responsibility |
|---|---|
| `@aaspai/api` | Hono HTTP control plane for health, loops, sessions, providers, execution, and company operations. Mutating execution routes require an injected auth verifier. |
| `@aaspai/worker` | Long-running scheduler and autonomous executor. Claims durable work, manages capacity and workspaces, invokes harnesses, and records evidence. |
| `@aaspai/cli` | Workspace setup, definition inspection, manual sessions/chat, durable goal creation, provider checks, and local daemon operation. |
| `@aaspai/web` | Next.js command center for onboarding, company goals, agents, execution, governance, sessions, memory, knowledge, and state. It currently uses server-side local workspace/database access. |

## Sources of truth

| Information | Canonical source |
|---|---|
| Agent, loop, and knowledge definitions | Git-backed files under `.aaspai/` |
| Project configuration | `.aaspai/aaspai.config.ts` |
| Goals, work items, attempts, approvals, sessions, events, and audit records | Database |
| Raw execution output and artifacts | Durable execution evidence referenced by database records |
| Accepted organizational knowledge | Reviewed files under `.aaspai/knowledge/` |
| Product deliverables | The target Git repository and its commits |

The practical rule is: definitions are reviewed in Git; operational
transitions are recorded in the database. Runtime output must not silently
rewrite a definition.

Local state defaults to `.aaspai/state.db`. Environment variables can override
definition paths and preserve compatibility with legacy layouts.

## Package layers

The code is organized by ownership rather than by UI feature:

| Layer | Responsibilities | Main packages |
|---|---|---|
| Foundation | contracts, config, persistence, identity, auth, audit, observability, Git | `contracts`, `config`, `db`, `identity`, `auth`, `audit`, `observability`, `crypto`, `git`, `testing` |
| Execution fabric | harness capabilities, runtimes, sessions, isolated workspaces, execution plans | `harness`, `runtime`, `sessions`, `execution` |
| Agents and processes | definitions, skills, tools, knowledge, loops | `file-loader`, `skills`, `tools`, `knowledge`, `loops` |
| Functional work state | goals, work items, attempts, dependencies, verification, approvals | `execution`, `db` |
| Company control plane | departments, service agents, authority, routing, delegation, escalation, autonomy changes | `company`, `api`, `db` |

The implementation order is foundation, execution fabric, agents/processes,
functional work state, then company control plane. The conceptual company
layer sits above the other layers even though its code is being delivered
incrementally.

## Execution paths

Autonomous work follows one governed path:

```text
Goal / workflow
  -> WorkItem and dependencies
  -> scheduler claim and capacity locks
  -> AgentAttempt
  -> immutable ExecutionPlan
  -> isolated Workspace
  -> Runtime
  -> HarnessAdapter / external CLI
  -> normalized events and artifacts
  -> independent verification
  -> completion, retry, approval, or escalation
```

The API enqueues work; it does not execute agent sessions inside request
handlers. The worker owns autonomous execution.

Direct session execution remains available for explicit chat and bounded
manual runs. It is a compatibility/user-interaction path, not a shortcut for
autonomous work.

### Execution responsibility

The harness adapter defines how to invoke and interpret an agentic CLI. The
runtime target defines where that CLI executes. For a sandbox target such as
Daytona, the intended execution boundary places the CLI and mutable repository
inside the sandbox while the worker retains durable control and evidence.

The current Daytona integration proves the real worker claim, selected-skill
use, prebuilt snapshot execution, workspace round-trip, streamed CLI execution,
timeout, cancellation, same-lease provider-session resume, external
session/log persistence, durable branches and declared artifacts,
attempt-scoped gateway credentials, runtime identity, and cleanup. See
[Harnesses and execution runtimes](./execution-runtimes.md) for the current
boundary and acceptance criteria.

## Important identities

These records are intentionally distinct:

- `AgentDefinition`: versioned role and capability configuration.
- `WorkItem`: durable unit of coordination.
- `AgentAttempt`: one governed attempt to complete a work item.
- `HarnessSession`: one provider/CLI invocation.
- `Workspace`: isolated mutable checkout.
- `EnvironmentLease`: allocated execution environment.
- `Verification`: independent assessment of submitted evidence.

Keeping them separate provides retry history, provider lineage, workspace
ownership, and auditable verification.

## Current boundaries

- SQLite is the default and best-verified local operating mode.
- Postgres support exists in the database package, but the complete
  multi-process production topology is not yet claimed as verified.
- `dry_run_local` proves orchestration deterministically; it does not prove a
  real provider integration.
- Real-provider support must be checked with `provider capabilities`,
  `provider doctor`, and the opt-in real test suites.
- The web app is currently a trusted local/server-side control surface, not a
  separately deployable stateless frontend.
- Default worker concurrency is deliberately conservative.

See [Deployment](./deployment.md) before exposing the system beyond a trusted
development environment.
