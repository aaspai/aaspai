# Deployment

aaspai is self-hosted. The default development setup uses SQLite and
the `dry_run_local` harness; production deployments use Postgres and
a real agentic CLI.

This document covers the high-level production layout. For concrete
recipes (Docker Compose, Kubernetes, systemd), see the deployment
examples in the private `study/` directory.

## Components

A production deployment has three processes, each in its own
container or pod:

| Process | Image | Role |
|---|---|---|
| `aaspai-api` | `apps/api` | Hono HTTP API. Serves queries and webhooks. |
| `aaspai-worker` | `apps/worker` | Long-running daemon. Executes scheduled loops and runs sessions. |
| Postgres | any | The state database. |

The CLI (`apps/cli`) is not a long-running process. It is invoked
from a shell, from CI, or from a job runner.

## Storage

State lives in Postgres. Configuration lives in a git repository that
the API and worker mount as a read-only volume.

```
/etc/aaspai/
├── aaspai.config.ts     # the project config
├── agents/              # versioned in git
├── knowledge/           # versioned in git
└── loops/               # versioned in git
```

The schema is managed by the migration runner in
`packages/db/src/migrate.ts`. Run it on every deploy:

```sh
yarn workspace @aaspai/db start migrate
```

## Configuration

`aaspai.config.ts` is the project-level config. It declares:

- Where to find agents, knowledge, and loops (the `file-loader`
  sources).
- Which harness to use per agent (overridable by each agent's
  `AGENT.md`).
- Which runtime to use per session (local, docker, ssh, sandbox).
- Database connection string and observability settings.

A typical production config:

```ts
export default {
  sources: {
    agents:   { kind: 'file', root: '/etc/aaspai/agents' },
    knowledge:{ kind: 'file', root: '/etc/aaspai/knowledge' },
    loops:    { kind: 'file', root: '/etc/aaspai/loops' },
  },
  database: {
    url: process.env.DATABASE_URL!,
    pool: { min: 2, max: 20 },
  },
  observability: {
    logLevel: 'info',
    metrics: { enabled: true, endpoint: '/metrics' },
    tracing: { enabled: true, exporter: 'otlp' },
  },
  runtime: { default: 'docker' },
} satisfies AaspaiConfig;
```

## Networking

- The **API** listens on `http://0.0.0.0:3000` by default. Terminate
  TLS at a reverse proxy (Caddy, nginx, or your cloud's load balancer).
- The **worker** does not accept inbound traffic. It connects to
  Postgres and to the configured runtimes. No public port.
- The **CLI** runs wherever you run it. It connects to Postgres over
  the same DSN as the API and the worker.

## Real harnesses

The `dry_run_local` harness is for development. In production, each
agent declares which harness it uses in `AGENT.md`. The supported
harnesses and their requirements:

| Harness | Requires |
|---|---|
| `opencode_cli` | The OpenCode CLI on the `PATH` of the runtime. |
| `claude_local` | Claude Code on the `PATH` and a `CLAUDE_CODE_OAUTH_TOKEN` (or equivalent). |
| `codex_local` | The Codex CLI and a `OPENAI_API_KEY`. |
| `cursor_local` | Cursor and a Cursor session. |
| `cursor_cloud` | A Cursor Cloud API key. |

aaspai does not store API keys. The harness's own authentication
mechanism is the source of truth. The runtime only needs the
`PATH` and the environment the CLI expects.

## Scaling

The **API** is stateless and scales horizontally. Run as many
replicas as you need behind a load balancer.

The **worker** is stateful (it holds the loop scheduler state and the
active sessions in memory). Run **exactly one** worker per
environment, or use a leader-election lock to allow multiple
replicas with one active scheduler.

Postgres is the source of truth for state. Both the API and the
worker can be restarted freely; in-flight sessions are recovered on
startup.

## Backups

- **Configuration** is in git. Back up the git host.
- **State** is in Postgres. Use your standard Postgres backup
  strategy (logical dump or physical backup).
- **Audit log** is in Postgres. Same strategy.

There is no other state to back up. The runtime `.aaspai/` directory
on the worker is intentionally ephemeral.

## Observability

aaspai exports:

- **Logs** — structured JSON via the `observability` package. Pipe to
  your log aggregator.
- **Metrics** — Prometheus-compatible, served at `/metrics` on the
  API. Includes session counts, token usage, loop fires, gate
  decisions.
- **Traces** — OTLP-compatible, exported from both the API and the
  worker. Wire to your tracing backend.

## Upgrades

aaspai follows semantic versioning. Patch releases are always
backwards-compatible; minor releases may add new config fields;
major releases are rare and will be announced in advance.

The recommended upgrade flow:

1. Read the release notes.
2. Pull the new image / tag.
3. Run the database migrations (`yarn workspace @aaspai/db start
   migrate`).
4. Restart the API, then the worker.
5. Watch the first scheduled loop fire to confirm.

## License

Production deployments of aaspai are subject to the
[AGPL-3.0 license](../LICENSE). If you offer aaspai as a hosted
service to third parties, you must publish your modifications under
the same license.
