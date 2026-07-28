# Getting started

This guide runs aaspai from the monorepo with SQLite and the deterministic
`dry_run_local` adapter.

## Requirements

- Node.js `>=20.18.0 <21`
- Corepack and Yarn 4.5
- Git

## Install

```sh
git clone https://github.com/aaspai/aaspai.git
cd aaspai
corepack enable
yarn install
yarn build
```

The standalone CLI is not published yet. In this repository, replace
`aaspai ...` with:

```sh
yarn workspace @aaspai/cli start ...
```

## Initialize the workspace

```sh
yarn workspace @aaspai/cli start init
```

Initialization creates and migrates:

```text
.aaspai/
|-- AGENTS.md
|-- aaspai.config.ts
|-- agents/
|-- knowledge/
|-- loops/
`-- state.db
```

It also adds runtime-only entries to `.gitignore`. If an older workspace has
root-level `AGENTS.md`, `aaspai.config.ts`, `agents/`, `knowledge/`, or
`loops/`, `init` moves each item into `.aaspai/` only when the destination
does not already exist. It never overwrites the destination.

## Inspect the installation

```sh
yarn workspace @aaspai/cli start db status
yarn workspace @aaspai/cli start agent list
yarn workspace @aaspai/cli start loop list
yarn workspace @aaspai/cli start provider capabilities
yarn workspace @aaspai/cli start provider doctor
```

`provider capabilities` reports implemented harness and runtime features.
`provider doctor` checks which external agent CLIs are installed locally.

## Run locally

Use separate terminals:

```sh
# API: http://127.0.0.1:7420
yarn workspace @aaspai/api dev

# durable scheduler and executor
yarn workspace @aaspai/worker dev

# web command center: Next.js development server
yarn workspace @aaspai/web dev
```

The worker loads definitions from `.aaspai/`, polls durable wakeups, schedules
eligible work, creates isolated execution workspaces, and records attempts and
evidence in SQLite.

For a single scheduler tick:

```sh
yarn workspace @aaspai/cli start start --once
```

## Try the user surfaces

```sh
# interactive/manual execution path
yarn workspace @aaspai/cli start chat ceo --adapter dry_run_local

# create a durable goal and dependent work items
yarn workspace @aaspai/cli start goal create \
  --description "Prepare a verified change" \
  --step "Implement the change" \
  --step "Verify the result"

# inspect operational state
yarn workspace @aaspai/cli start state show
yarn workspace @aaspai/cli start session list
```

Manual chat uses the bounded session path. Autonomous work uses the durable
`WorkItem -> AgentAttempt -> ExecutionPlan` path described in
[Architecture](./architecture.md#execution-paths).

## Use a real agentic CLI

Install and authenticate a supported CLI, then verify it:

```sh
yarn workspace @aaspai/cli start provider doctor
```

Select the adapter and model in the agent definition or pass an explicit
override for manual chat/session commands. Authentication remains owned by
the external CLI; do not place provider credentials in `.aaspai/`.

## Validate changes

```sh
yarn typecheck
yarn lint
yarn test
```

Real-provider tests are opt-in because they require installed, authenticated
CLIs and can incur cost.
