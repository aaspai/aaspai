# `@aaspai/cli`

The CLI is the local control-plane entry point for an aaspai workspace. It
loads file-backed agents, knowledge, skills, and loops, then records durable
session and execution state in SQLite.

## Quick start

```bash
aaspai init
aaspai agent list
aaspai session start \
  --agent agent/operator \
  --adapter opencode_local \
  --prompt "say hello"
```

The production harness registry exposes `opencode_local` only. It talks to an
authenticated `opencode serve` process through HTTP/SSE and receives a Runtime
V2 execution boundary from the caller. Runtime discovery exposes Local and
Daytona; the CLI does not create or persist Daytona leases itself.

## Commands

```text
aaspai init          scaffold a workspace
aaspai agent         list, show, validate, and create agents
aaspai provider      inspect production adapter/runtime capabilities
aaspai session       list, show, start, stop, and cancel sessions
aaspai knowledge     inspect OKF knowledge files
aaspai skill         inspect and materialize skills
aaspai tool          inspect caller-prepared tools
aaspai loop          manage recurring loops
aaspai state         show workspace state
aaspai start         run the scheduler worker
aaspai db            migrate, inspect, and back up SQLite state
```

## Configuration

Workspace definitions live below `.aaspai/`. Keep definitions in version
control and keep `.aaspai/state.db`, runtime artifacts, and credentials out of
source control. OpenCode credentials are supplied through ephemeral process
environment values; the CLI never writes `auth.json` or a global OpenCode
configuration.

```ts
import { defineConfig } from "@aaspai/config";

export default defineConfig({
  database: { url: process.env.AASPAI_DB ?? "sqlite:./.aaspai/state.db" },
  organization: { id: "default", name: "My Project" },
  defaults: {
    adapter: "opencode_local",
    runtime: { kind: "local", envPassthrough: false },
  },
});
```

## Verification

```bash
yarn workspace @aaspai/cli typecheck
yarn workspace @aaspai/cli test
yarn test:real:production
```

The real production smoke writes JSON and HTML results under
`.aaspai/artifacts/real-production-smoke/`.
