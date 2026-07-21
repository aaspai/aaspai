# aaspai Documentation

Public documentation for the aaspai project.

## What is aaspai?

aaspai is a **control plane for running AI-agent workforces on top of
agentic CLIs**. You define agents, knowledge, skills, and recurring loops as
files in a git repository; aaspai runs them, tracks what they did, and
streams the results back to your state file.

It is self-hosted, file-config-first, and works with the agentic CLI you
already use (Claude, Codex, Cursor, OpenClaw, or a deterministic dry-run
adapter for tests).

## Start here

| Doc | What's in it |
|---|---|
| [Concept](./concept.md) | The problem aaspai solves and the ideas behind it. |
| [Architecture](./architecture.md) | The four layers, the file/DB split, the port/adapter seam. |
| [Getting started](./getting-started.md) | Install, initialize a project, run your first agent. |
| [Deployment](./deployment.md) | Running in production with Postgres and a real harness. |

## Core concepts

| Concept | What it is |
|---|---|
| [Agents](./concepts/agents.md) | Roles with system prompt, tools, and skills. Versioned in git. |
| [Loops](./concepts/loops.md) | Recurring scheduled work that wakes an agent on a cadence. |
| [Knowledge](./concepts/knowledge.md) | Versioned long-term memory in OKF files. |

## Conventions

- Configuration is **files**. State is **rows**. See
  [Architecture](./architecture.md#configuration-vs-state).
- The port/adapter seam lives in
  [`packages/contracts/`](https://github.com/aaspai/aaspai/tree/main/packages/contracts).
  Implementation adapters are in `packages/{db,auth,identity,audit,harness,runtime}/`.
- CLI reference and internal architecture live in the (private) `study/`
  directory. Public docs only cover the concepts.

## License

[AGPL-3.0](../LICENSE). See [`../LICENSE`](../LICENSE) for the full
text.
