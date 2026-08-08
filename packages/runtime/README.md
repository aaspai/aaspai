# `@aaspai/runtime`

`@aaspai/runtime` is the infrastructure boundary for production execution. It
owns environments, leases, rooted filesystems, processes, and private service
endpoints. It does not know about sessions, databases, harnesses, agents, or
OpenCode.

## Supported surface

The root entry point is Runtime V2. The production registry contains only:

| Provider | Lease model | Release-gated capabilities |
| --- | --- | --- |
| `local` | none | ordered stdout/stderr, stdin, cancellation, timeout escalation, rooted binary filesystem |
| `daytona` | reusable | durable lease resume, process sessions, separated streams, stdin, cancellation, hibernation, destroy, private endpoints |

Other provider experiments are kept out of the registry and are not exported
from the production facade. They cannot be selected by `defaultRuntimeRegistry()`.

## Lifecycle

```text
validateConfig → probe → acquireLease → realizeWorkspace
                                      ↓
                             startExecution → wait/cancel/signal
                                      ↓
                              releaseLease → destroyLease
```

The provider is stateless. A `RuntimeLease` is JSON-safe and secret-free, so a
worker can discard the provider instance and later call `resumeLease` using only
the persisted provider ID and metadata. `releaseLease` and `destroyLease` are
different operations and are both idempotent.

## Public API

```ts
import { RuntimeController, defaultRuntimeRegistry } from "@aaspai/runtime";

const registry = defaultRuntimeRegistry();
const provider = await registry.createProvider("local", {
  config: {},
  credentials: {},
});
const controller = new RuntimeController({ provider });
```

The controller is only a convenience facade. Persistence, reuse policy, and
session ownership remain above runtime.

`RuntimeProcessHandle` is the control point for a running process. Output is
delivered as ordered bytes, tails are bounded, stdin is live, and cancellation
does not resolve until the process group is confirmed dead. Shell parsing is
opt-in; command and argument vectors remain separate by default.

`RuntimeFilesystem` is rooted at the realized workspace. Traversal and symlink
escapes are rejected, reads/writes are binary-safe, and writes are atomic where
the provider supports them.

## Provider configuration and credentials

Provider config is validated before probing or acquiring. Credentials are
passed to the factory for the lifetime of an operation only. They are never
written to lease metadata, generated configuration, logs, or structured errors.
Daytona is pinned to SDK `0.171.0` in this release line.

## Tests and release gate

```bash
yarn workspace @aaspai/runtime verify
yarn test:real:production
```

The unit suite covers process ordering/termination, bounded output, filesystem
containment, lease serialization, Local, and deterministic Daytona lifecycle
reconstruction. The real smoke writes a redacted JSON/HTML report under
`.aaspai/artifacts/real-production-smoke/` and is opt-in because it creates a
credentialed Daytona sandbox.

See [`study/harness-runtime-production-plan.md`](../../study/harness-runtime-production-plan.md)
for the architecture decisions and provider conformance requirements.
