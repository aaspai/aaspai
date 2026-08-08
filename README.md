# aaspai

**A self-hosted control plane for running governed AI-agent work.**

aaspai separates orchestration from execution infrastructure. The production
foundation is deliberately small and explicit:

```text
@aaspai/contracts
       ├───────────────┐
       ▼               ▼
@aaspai/runtime   @aaspai/harness
       │               │
       ▼               ▼
 Local / Daytona   OpenCode server
```

Runtime owns environments, leases, processes, filesystems, and private service
endpoints. Harness owns adapter lifecycle, native sessions, questions,
permissions, semantic events, raw logs, and per-run results. Persistence and
reuse policy belong to the layers above them.

## Production foundation

### Runtime V2

`@aaspai/runtime` exposes a stateless provider contract and lazy registry. The
release-gated providers are:

- `local`: reference runtime for ordered byte streams, live stdin, bounded
  output, process-group cancellation, timeout escalation, and rooted binary FS.
- `daytona`: reusable cloud leases with sentinel validation, durable process
  identities, separated streams, stdin, cancellation, hibernation, destroy, and
  refreshable private endpoints.

Leases are JSON-serializable and secret-free. A provider object can be discarded
and reconstructed from the persisted lease ID and metadata.

### Harness + OpenCode

`@aaspai/harness` exposes the validated controller and a production registry
containing `opencode_local`. The OpenCode adapter uses one authenticated
`opencode serve` process per isolated runtime/state scope:

1. the runtime starts the server and exposes its private endpoint;
2. the adapter probes the pinned compatibility line;
3. a native session is created or resumed;
4. HTTP/SSE events are reduced into ordered semantic events;
5. question and permission answers are sent through OpenCode's native APIs;
6. abort, fork, reconnect reconciliation, bounded tool output, and usage are
   handled by the same run-bound driver.

CLI/ACP adapters and unverified runtime providers are not production discovery
entries. They are outside this foundation cut and cannot be selected by the
default registries.

## Quick start

```bash
corepack enable
yarn install
yarn verify:production
```

For a credentialed end-to-end run, put the Daytona and OpenCode credentials in
`.env.local` (never commit that file) and run:

```bash
yarn test:real:production
```

The smoke test creates a real Daytona lease, starts OpenCode inside it, checks
conversation/resume/question/permission/fork behavior, hibernates and resumes
the lease, then destroys it. It writes redacted, human-readable results to:

- `.aaspai/artifacts/real-production-smoke/report.json`
- `.aaspai/artifacts/real-production-smoke/report.html`

The report includes phase timings, observed native session IDs, interaction
delivery, endpoint checks, cleanup verification, and a secret-persistence scan.

## Workspace commands

```bash
yarn build                 # build all workspaces
yarn test                  # all package tests
yarn lint                  # Biome
yarn typecheck             # all workspace typechecks
yarn verify:production     # dependency + architecture + foundation gates
yarn test:real:production  # credentialed Daytona/OpenCode smoke
```

## Package map

| Package | Responsibility |
| --- | --- |
| `packages/contracts` | Shared schemas and protocol types |
| `packages/runtime` | Runtime V2 facade, Local, Daytona, process/filesystem core |
| `packages/harness` | Run controller and production adapter registry |
| `packages/harness/opencode` | OpenCode HTTP/SSE server driver and reducer |
| `packages/sessions` | Session continuity and persistence above the foundation |
| `packages/execution` | Orchestration, workspace preparation, and result policy |
| `packages/db` | SQLite/Postgres persistence |
| `apps/api` / `apps/worker` / `apps/web` | Control plane, worker, and UI |

The runtime and harness packages must not import database/session/provider
implementation concerns across their boundaries. The architecture check runs in
CI and locally via `yarn check:architecture`.

## Documentation

- [`packages/runtime/README.md`](packages/runtime/README.md) — Runtime V2 API and lifecycle
- [`packages/harness/README.md`](packages/harness/README.md) — controller and OpenCode boundary
- [`study/harness-runtime-production-plan.md`](study/harness-runtime-production-plan.md) — production plan and release gates
- [`study/development/real-production-smoke-execution.md`](study/development/real-production-smoke-execution.md) — real smoke walkthrough
- [`docs/architecture.md`](docs/architecture.md) — broader application architecture
- [`CHANGELOG.md`](CHANGELOG.md) — release history

The OpenCode protocol implementation is documented in
[`packages/harness/opencode/README.md`](packages/harness/opencode/README.md).

## Security

Credentials are loaded only for an operation, passed through ephemeral process
environment values, and redacted from reports/errors. Do not put provider keys
in leases, generated config, source control, or issue reports. See
[`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## License

[AGPL-3.0](LICENSE). Contributions follow [`CONTRIBUTING.md`](CONTRIBUTING.md).
