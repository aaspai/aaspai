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

`AGENT.md` supplies typed defaults and role instructions. Companion files have
explicit precedence: `config.yaml` merges over frontmatter runtime/adapter
configuration, while `relations.yaml`, `skills.lock.json`, and `tools.yaml`
replace their matching frontmatter fields when present.

Resolved tool policy is enforced at execution time. Tools requiring approval
fail closed when no approval broker is available, and harness-native tools are
restricted to the resolved allowlist. An adapter that cannot enforce its
native allowlist is refused for autonomous execution.

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
