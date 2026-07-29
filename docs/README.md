# aaspai documentation

aaspai is a self-hosted control plane for assigning durable work to AI agents
that run through agentic CLIs. Agent, knowledge, and loop definitions are kept
in Git; operational state, execution evidence, and governance decisions are
kept in a database.

## Start here

| Guide | Purpose |
|---|---|
| [Getting started](./getting-started.md) | Install the monorepo, initialize a workspace, and inspect the local system. |
| [Concept](./concept.md) | Understand the product model and its boundaries. |
| [Architecture](./architecture.md) | See the implemented components, source-of-truth rules, and execution flow. |
| [Harnesses and runtimes](./execution-runtimes.md) | Understand where agentic CLIs run, credential direction, and remote-runtime acceptance. |
| [Deployment](./deployment.md) | Run the current system and understand its production-readiness limits. |

## Core definitions

| Definition | Location | Guide |
|---|---|---|
| Agents | `.aaspai/agents/` | [Agents](./concepts/agents.md) |
| Knowledge | `.aaspai/knowledge/` | [Knowledge](./concepts/knowledge.md) |
| Loops | `.aaspai/loops/` | [Loops](./concepts/loops.md) |
| Project config | `.aaspai/aaspai.config.ts` | [Getting started](./getting-started.md) |
| Local runtime state | `.aaspai/state.db` | [Architecture](./architecture.md#sources-of-truth) |

`aaspai init` keeps the complete workspace under `.aaspai/`. Definitions and
config may be committed; runtime files such as `state.db`, logs, and PID files
must remain ignored.

## Documentation policy

The public `docs/` directory describes behavior available in the current
repository. Forward-looking design and engineering evidence live in the
internal `study/` directory and are not public product promises. Files under
`docs/issues/` are historical issue records.

## License

[AGPL-3.0](../LICENSE).
