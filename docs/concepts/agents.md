# Agents

An agent is a versioned role definition. It describes purpose, instructions,
relationships, tools, skills, knowledge scope, and execution preferences.
Definitions live under `.aaspai/agents/` and are intended to be reviewed in
Git.

```text
.aaspai/agents/<slug>/
|-- AGENT.md
|-- config.yaml
|-- relations.yaml
|-- skills.lock.json
`-- tools.yaml
```

`AGENT.md` is the primary definition: YAML frontmatter supplies typed fields
and the Markdown body supplies role instructions. The companion files keep
runtime/provider configuration, relationships, pinned skills, and tool policy
explicit.

## Identity and execution

Use stable IDs such as `agent/developer`. An `AgentDefinition` is not a live
process and not a work assignment. Autonomous execution creates separate
records for the `WorkItem`, `AgentAttempt`, isolated workspace, and provider
session. This separation preserves retries and evidence without mutating the
role definition.

The adapter/model fields select a preferred execution capability. Actual
availability must be checked with:

```sh
yarn workspace @aaspai/cli start provider capabilities
yarn workspace @aaspai/cli start provider doctor
```

## Commands

```sh
yarn workspace @aaspai/cli start agent list
yarn workspace @aaspai/cli start agent show agent/developer
yarn workspace @aaspai/cli start agent describe agent/developer
yarn workspace @aaspai/cli start agent new agent/reviewer
yarn workspace @aaspai/cli start agent validate
```

For explicit interactive work, use `chat` or `session start`. Durable,
autonomous work should be created as goals/work items and executed by the
worker.

See [Loops](./loops.md), [Knowledge](./knowledge.md), and
[Architecture](../architecture.md).
