# Concept

aaspai is a company operating system and orchestration control plane for work
performed through agentic CLIs.

An agentic CLI can execute a prompt. aaspai owns the surrounding system:

- which durable goal and work item caused the run;
- which versioned agent, skills, tools, and knowledge were selected;
- which workspace, runtime, provider, model, policy, and budget were used;
- what evidence was produced;
- who verified it;
- whether the system should complete, retry, request approval, or escalate.

## Product model

```text
Human intent
  -> company definitions and authority
  -> goals and dependent work items
  -> governed agent attempts
  -> isolated execution through an agentic CLI
  -> evidence and independent verification
  -> durable operational state and accepted knowledge
```

Definitions are files under `.aaspai/` so changes can be reviewed in Git.
Operational state is stored in the database so claims, retries, approvals,
events, and audit history survive process restarts.

## Core principles

1. **Agents are versioned roles, not model names.** A role carries purpose,
   authority, tools, skills, knowledge scope, and provider preferences.
2. **Work is durable.** Goals decompose into work items with dependencies;
   autonomous execution is not an untracked prompt call.
3. **Execution is reproducible.** An attempt pins the definition revision,
   target commit, execution plan, provider, runtime, and policy.
4. **Verification is independent.** Completion requires evidence and a
   checker/policy decision, not merely a successful process exit.
5. **Knowledge is reviewed.** Runtime memory and raw transcripts are evidence;
   accepted long-term knowledge is curated into Git.
6. **Providers and runtimes are replaceable.** Capability contracts isolate
   orchestration from a particular CLI or compute environment.
7. **The control plane does not execute work.** API/UI mutations enqueue or
   govern work; the worker owns execution.

## Current product surfaces

- The CLI initializes and operates a workspace, inspects definitions/state,
  runs bounded manual sessions, checks providers, and creates durable goals.
- The API exposes health, loop, session, execution, provider, and company
  control-plane operations.
- The worker schedules and executes durable work.
- The web command center exposes onboarding, company goals, agents,
  execution, governance, sessions, memory, knowledge, and state.

## What aaspai is not

- It is not a model host or training system.
- It is not a replacement for Codex, Claude Code, OpenCode, or another
  agentic CLI.
- It is not yet a production-ready multi-tenant hosted service.
- A deterministic dry run is not evidence that a real provider works.

Read [Architecture](./architecture.md) for the implemented boundaries and
[Getting started](./getting-started.md) for the local workflow.
