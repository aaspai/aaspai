# Concept

aaspai is a self-hosted company operating system above agentic CLIs. The CLI
does the reasoning and tool use; aaspai owns durable intent, authority,
execution, evidence, and recovery.

## Product model

```text
Founder intent
  -> company definitions and authority
  -> goals and projects
  -> milestones and repeatable processes
  -> durable workflow/work items
  -> governed agent attempts through an agentic CLI
  -> evidence, verification, approval, and delivery
  -> reviewed knowledge and the next control decision
```

Definitions are versioned files under `.aaspai/`. Operational transitions are
database records so claims, retries, approvals, artifacts, and worker
restarts do not depend on a live conversation.

## Core principles

1. **Agents are versioned roles.** A role is not the same thing as a model,
   provider session, or assignment.
2. **Company changes are typed.** Hiring, delegation, milestone creation, and
   process starts go through validated company-control commands; agent prose
   alone cannot change company state.
3. **Work is durable.** Goals and processes create dependency-aware WorkItems.
   An agent session is an execution record, not the planning primitive.
4. **Attempts are reproducible.** Each attempt pins definitions, repository
   revision, plan, harness, runtime, policy, and workspace identity.
5. **Evidence closes work.** A successful CLI exit is not independent
   verification. Required criteria, artifacts, checker results, and approvals
   determine completion.
6. **Retries preserve history.** A retry creates another attempt; it does not
   overwrite the failed attempt or its evidence.
7. **Knowledge is reviewed.** Memory and transcripts are scoped evidence.
   Accepted organizational knowledge returns to Git through review.
8. **The control plane does not execute work.** API/UI mutations enqueue or
   govern; the worker executes and recovers.

## Current surfaces

- CLI: initialize/inspect the workspace, run manual sessions, manage goals and
  loops, check providers, and inspect state.
- API: health, session/loop/provider access, execution control, strategic
  projections, and company operations.
- Worker: wakeup recovery, scheduling, process/operator decisions, attempts,
  company-action brokerage, evidence, retry, and cleanup.
- Web: local command center for company structure, goals/projects, live
  attempts, governance, artifacts, knowledge, memory, and recovery.

## What aaspai is not

- It is not a model host or training system.
- It is not a replacement for Codex, Claude Code, OpenCode, or another CLI.
- It is not yet a production-ready horizontally scaled multi-tenant service.
- A deterministic dry run is not evidence that a real provider works.

Read [Architecture](./architecture.md) for ownership boundaries and
[Getting started](./getting-started.md) for the local workflow.
