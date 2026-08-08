# `@aaspai/opencode`

This package is the OpenCode server protocol layer used by the production
`opencode_local` harness adapter. It is deliberately narrower than a general
OpenCode administration SDK: the caller supplies a runtime execution
boundary and secret-free configuration, while this package owns server
lifecycle, native sessions, HTTP/SSE transport, event reduction, and native
interaction delivery.

## Runtime flow

```text
RuntimeProcessHandle
        |
        v
  opencode serve  ->  health/version probe  ->  create/resume session
                                                  |
                                                  v
                         SSE -> decode -> accumulate -> HarnessEvent
                                                  |
                       question/permission/abort/fork HTTP APIs
```

`OpenCodeServerAdapter` starts or attaches to one server for an isolated
runtime/state scope. Concurrent sessions share that server; execution turns
are not protected by a process-wide mutex. If the server dies during an
active turn, the run fails as transport-lost and the prompt is not replayed.
Idle servers may be restarted and resumed according to the session resume
policy.

## Public modules

- `config`: validates the small, prepared OpenCode configuration and compiles
  secret-free server settings.
- `drivers/server`: owns process lifecycle, endpoint health, session requests,
  SSE subscription, interactions, abort, and fork.
- `protocol`: parses SSE frames, normalizes native events, accumulates deltas
  by message/part identity, records usage/cost, and classifies failures.
- `session`: serializes native bindings and decides when a session may be
  resumed or must be replaced.

The reducer is idempotent. After reconnect, authoritative session messages
are reconciled before new events are emitted, so repeated SSE deltas do not
duplicate text, tool output, usage, or terminal records.

## Security and ownership

Credentials are passed as ephemeral process environment values. This package
does not write global auth files, install providers, manage skills or MCP,
query the OpenCode database, choose a runtime provider, or dispatch AASPAI
tools through an adapter-side callback. Caller-prepared MCP configuration is
observed through native OpenCode events exactly once.

The compatibility line is pinned to OpenCode `1.18.15` for this release. A
server that does not expose the required API or version is rejected closed.

## Verification

```bash
yarn workspace @aaspai/opencode lint
yarn workspace @aaspai/opencode typecheck
yarn workspace @aaspai/opencode test
yarn verify:production
```

Credentialed Daytona/OpenCode lifecycle coverage is opt-in at the workspace
root:

```bash
yarn test:real:production
```

The smoke writes redacted JSON and HTML reports to
`.aaspai/artifacts/real-production-smoke/`.
