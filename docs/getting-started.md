# Getting started

Install aaspai, initialize a project, and run your first agent. The
default configuration runs entirely locally, without any API key.

## Requirements

- **Node.js** 20 or later
- **Corepack** (ships with Node; enables Yarn 4)

## Install

aaspai is a Yarn 4 monorepo. To install all workspaces:

```sh
corepack enable
git clone https://github.com/aaspai/aaspai.git
cd aaspai
yarn install
```

To install only the CLI from a release:

```sh
# coming soon — prebuilt binaries are not yet published
# until then, run the CLI from the monorepo: `yarn workspace @aaspai/cli start`
```

## Initialize a project

Inside the monorepo, scaffold a new aaspai project under any directory:

```sh
yarn workspace @aaspai/cli start init my-project
cd my-project
```

`init` creates:

- `agents/` with the default `operator`, `developer`, and `tester`
  agents
- `knowledge/` with a `company/mission.md` stub
- `loops/` with a `daily-triage` loop
- `aaspai.config.ts` with sensible defaults
- `.aaspai/` for runtime data (gitignored)

The default `operator` agent uses the `dry_run_local` harness, so the
project runs without any API key.

## Run the API and worker

In two terminals:

```sh
# terminal 1: the API (Hono on http://localhost:3000 by default)
yarn workspace @aaspai/api dev

# terminal 2: the worker (long-running daemon)
yarn workspace @aaspai/worker dev
```

The worker starts the loop scheduler, which will fire the
`daily-triage` loop at its scheduled time (08:00 UTC on weekdays, by
default).

## Run an agent on demand

To run a single session without waiting for the schedule:

```sh
yarn workspace @aaspai/cli start agent run developer
```

This calls `Session.execute()` for the `developer` agent, streams
events to the terminal, and writes the result to the database. Use
`--no-stream` to suppress event output.

## Inspect state

```sh
yarn workspace @aaspai/cli start state show
yarn workspace @aaspai/cli start session list
yarn workspace @aaspai/cli start loop list
```

`state show` renders the most recent `STATE.md` from the database.
`session list` and `loop list` are the read APIs for the runtime
state.

## Add a knowledge file

```sh
yarn workspace @aaspai/cli start knowledge new engineering/architecture
```

This writes a valid OKF file at
`knowledge/engineering/architecture.md`. Edit it, commit it, and the
next session will index it.

## Switch to a real harness

The default harness is `dry_run_local`. To use a real model:

1. Install the agentic CLI you want to use (Claude Code, Codex, or
   OpenCode).
2. Authenticate it. aaspai does not store credentials; it delegates to
   the CLI.
3. Edit the agent's `AGENT.md` and change the `adapter:` field:

   ```yaml
   adapter: opencode_cli
   model: opencode-go/mimo-v2.5
   ```

4. Restart the worker. The next session will run through the real
   harness.

## Where to go next

- [Concept](./concept.md) — the ideas behind the design.
- [Architecture](./architecture.md) — the four layers, the port/adapter
  seam.
- [Deployment](./deployment.md) — running in production with Postgres.
- [Concepts/Agents](./concepts/agents.md) — anatomy of an agent.
- [Concepts/Loops](./concepts/loops.md) — anatomy of a loop.
