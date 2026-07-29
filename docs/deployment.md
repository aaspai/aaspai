# Deployment

## Upgrade safety

Stop every API and worker process before upgrading the database, then start
only the new version. The delivery and external-action claim protocols are not
safe with old and new binaries sharing one database. Migration quarantines
legacy commit/PR work that lacks immutable commit evidence; rerun those blocked
work items instead of delivering an unverified branch tip.

The current repository is suitable for local development and controlled
evaluation. It is not yet documented as a production-ready, horizontally
scaled service.

## Verified local topology

Run these processes from the same checked-out workspace:

| Process | Command | Notes |
|---|---|---|
| API | `yarn workspace @aaspai/api start` | Binds to `127.0.0.1:7420` by default. |
| Worker | `yarn workspace @aaspai/worker start` | Polls and executes durable work; no inbound port. |
| Web | `yarn workspace @aaspai/web start` | Requires a prior web build and trusted access to the workspace/database. |
| CLI | `yarn workspace @aaspai/cli start ...` | On-demand administrative and user commands. |

Build and initialize first:

```sh
yarn install
yarn build
yarn workspace @aaspai/cli start init
```

The default local database is `.aaspai/state.db`. Run migrations with:

```sh
yarn workspace @aaspai/cli start db migrate
```

## Files and persistence

Commit:

```text
.aaspai/AGENTS.md
.aaspai/aaspai.config.ts
.aaspai/agents/
.aaspai/knowledge/
.aaspai/loops/
```

Back up but do not commit runtime state:

```text
.aaspai/state.db
.aaspai/backups/
.aaspai/*.log
.aaspai/*.pid
```

Use the CLI backup command before risky local upgrades:

```sh
yarn workspace @aaspai/cli start db backup
```

## Network and security

- Keep the API and web app on a trusted network.
- Do not bind the API publicly unless authentication is configured and every
  exposed route has been reviewed for organization scoping.
- Execution mutations fail closed when the API auth verifier is absent.
- External CLI credentials are managed by those CLIs or the process
  environment, not by definition files.
- Treat the worker as privileged: it can create workspaces and invoke local or
  remote runtimes according to policy.

## Provider and runtime readiness

Before enabling real work:

```sh
yarn workspace @aaspai/cli start provider capabilities
yarn workspace @aaspai/cli start provider doctor
```

Run the relevant opt-in real tests for the selected harness/runtime. A passing
unit suite or `dry_run_local` run is not proof that an external CLI,
authentication flow, remote sandbox, cancellation path, or artifact transfer
works in your environment.

## Production gaps

Do not assume the following until they have dedicated acceptance evidence:

- horizontally scaled API/worker deployment;
- safe multi-worker scheduling across all backends;
- complete worker-loss and in-flight attempt recovery;
- production Postgres parity for every execution/control-plane operation;
- remote artifact durability and backup;
- public web/API hardening and tenant isolation;
- metrics, tracing, alerting, and operational runbooks.

The internal target architecture covers these goals. Public deployment
recipes should be added only after their corresponding real-environment tests
pass.
