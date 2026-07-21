# Concept

## The problem

Modern teams want to **delegate** real work to AI agents: a developer to
write code, an operator to triage issues, a tester to run the suite. Each
agent runs in its own agentic CLI (Claude Code, Codex, Cursor, OpenClaw…)
and each CLI has its own way of being configured, scheduled, and observed.

The interesting question is not "can the agent solve this task?" — that is
the CLI's problem. The interesting question is: **who runs the
orchestration around it?**

Today most teams glue cron, shell scripts, and ad-hoc tools together. That
glue does not version, does not audit, does not survive a team handover,
and does not generalize from one agent to many.

## The idea

aaspai treats the agent workforce as **configuration**, not as code. You
write the agents, the knowledge they read, the tools they can call, and
the loops that wake them as files in a git repository. The runtime reads
those files, runs the agents, and writes back what happened to a database.

```
              ┌────────────────────────────────────────┐
              │            YOUR REPOSITORY             │
              │                                        │
              │   agents/      ─ versioned in git     │
              │   knowledge/   ─ versioned in git     │
              │   loops/       ─ versioned in git     │
              │   skills/      ─ versioned in git     │
              │   aaspai.config.ts                    │
              └────────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────────┐
              │            aaspai runtime              │
              │                                        │
              │   CLI  ─ schedules loops, runs agents │
              │   Worker ─ executes sessions           │
              │   API   ─ serves queries & webhooks    │
              └────────────────────────────────────────┘
                              │
                              ▼
              ┌────────────────────────────────────────┐
              │            STATE                       │
              │                                        │
              │   SQLite locally, Postgres in prod     │
              │   sessions, events, audit, budget      │
              └────────────────────────────────────────┘
```

Two storage tiers, one truth per tier:

- **Configuration** is files. A human wrote it; review it in a PR.
- **State** is rows. The system wrote it during a run; treat it as
  append-only.

This split is the central design choice. It means the agents and their
behaviour are code-reviewable, while the runtime data is free to evolve.

## The five ideas

1. **Agents are roles, not models.** An agent is a system prompt, a
   list of tools, a list of skills, and a scope of authority. The model
   that powers it is a property of the harness, not the agent.

2. **Loops are the unit of recurring work.** A loop is a markdown file
   with a gate, a budget, a schedule, and a session template. The
   scheduler wakes the loop, the gate decides whether to run, the budget
   caps it, the session runs the work.

3. **Knowledge is long-term, versioned memory.** Knowledge is stored in
   OKF (Open Knowledge Format) files — markdown with a typed YAML
   frontmatter. The agent's system prompt is built by indexing this
   knowledge at session start.

4. **The harness is swappable.** The same session can run against
   `claude_local`, `codex_local`, `cursor_local`, or a deterministic
   `dry_run_local`. The harness registry is a port; each driver is an
   adapter. Switch the harness in the agent's `AGENT.md` and the agent
   now talks to a different model.

5. **State is observable, not magical.** Every session writes to
   `session_events`. Every gate decision writes to a ledger. The CLI can
   render any of it back as a markdown STATE file you can paste into a
   pull request.

## What aaspai is not

- **Not a model.** aaspai does not train or host a model. It orchestrates
  the agentic CLIs that do.
- **Not a chat product.** aaspai is a runtime and an orchestration plane.
  It has an API and a CLI, but it does not ship a chat UI.
- **Not a hosted SaaS.** aaspai is self-hosted. You run it on your
  machine, your CI, or your servers. The AGPL license means that if
  someone else runs it as a service for you, they have to publish their
  changes.

## Who is it for?

- Engineers who want their agent workforce to be **reviewable** like any
  other piece of code.
- Teams that already use Claude Code, Codex, or Cursor and want a
  **shared substrate** to coordinate them.
- People who want to **dogfood** their own agent platform to build the
  agent platform.
- Anyone who has outgrown cron + shell scripts and wants a real
  scheduler, a real audit log, and a real budget system.

## The name

aaspai stands for **a**gent **a**s **s**ervice **p**latform with
**a**gentic **i**nterop. The short form is just "aaspai" (sounds like
"ASP AI").
