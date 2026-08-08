# `@aaspai/harness`

The harness owns agent-adapter lifecycle and semantics. Runtime owns the
process/environment boundary; the harness receives that boundary through the
execution context and never selects a provider itself.

## Production adapter registry

The production registry is intentionally small:

| Adapter | Transport | Status | Notes |
| --- | --- | --- | --- |
| `opencode_local` | authenticated HTTP/SSE server | ready | one `opencode serve` instance per runtime/state scope |

`getAdapter`, `listAdapters`, and `getAdapterCapabilities` fail closed for
legacy CLI/ACP adapter names. Those names are not production discovery entries.

```ts
import {
  HarnessController,
  getProductionAdapter,
  listProductionAdapters,
} from "@aaspai/harness";

const adapter = getProductionAdapter("opencode_local");
console.log(listProductionAdapters());
```

## Controller boundary

`HarnessController` owns run identity, legal state transitions, interaction
tracking, cancellation, event replay, durable journal ordering, and terminal
retention. Adapter code does not mutate a global session map. Each interaction
has its own ID, and a repeated answer is idempotent.

The controller requires a runtime execution boundary. Listener failures are
isolated. A configured durable journal failure aborts the native run and fails
closed. Terminal results use one of `completed`, `failed`, `cancelled`,
`timed_out`, or `lost`.

## OpenCode server path

The OpenCode adapter starts or attaches to `opencode serve`, verifies the pinned
compatibility line, creates/resumes a native session, consumes its SSE event
stream, and reduces native events into semantic harness events. Questions and
permissions are delivered through OpenCode's HTTP response endpoints. Abort and
fork use native session APIs. Reconnects reconcile session messages and
deduplicate by native message/part identity.

The adapter accepts prepared, secret-free configuration. It does not write
global auth files, install providers, administer skills or MCP, query OpenCode's
database, or spawn diagnostics processes. Caller-prepared MCP tools are
observed through the native event stream; the adapter does not dispatch them.
Credentials are ephemeral process environment values.

CLI batch execution and other adapters are migration/experimental work and are
not exported by this production package surface.

## Verification

```bash
yarn workspace @aaspai/harness verify
yarn workspace @aaspai/opencode verify
yarn check:architecture
```

The OpenCode package has focused tests for configuration safety, native event
decoding/reduction, session policy, and server lifecycle contracts. Credentialed
Daytona + OpenCode coverage is run with:

```bash
yarn test:real:production
```

The protocol package has its own implementation notes in
[`opencode/README.md`](opencode/README.md).

See [`study/harness-runtime-production-plan.md`](../../study/harness-runtime-production-plan.md)
for the complete boundary and release-gate rationale.
