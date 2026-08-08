# `@aaspai/sessions`

`@aaspai/sessions` is the durable session façade above the production Harness
V2 adapter. It records session rows and transcript events, composes prompts,
and exposes pause/resume/cancel operations. It does not select a runtime
provider, persist credentials, or spawn a process.

## Production path

```text
SessionRequest
    │
    ├─ load agent, knowledge, and caller-approved skills
    ├─ create/update the durable session row
    ├─ resolve the production `opencode_local` adapter
    ├─ pass the injected Runtime V2 execution boundary
    └─ persist semantic events and the terminal result
```

The execution layer should acquire a Daytona lease (or a Local lease) and pass
its run-bound `AdapterRuntimeExecution` as `runtimeExecution`. For direct local
use, Sessions creates a short-lived Local Runtime V2 lease rooted at `cwd`.
Remote targets fail closed when no caller-owned boundary is supplied; Sessions
never provisions or replaces a remote lease.

## API

```ts
import { Sessions } from "@aaspai/sessions";

const sessions = new Sessions({
  agentSource,
  knowledgeSource,
  skillRegistry,
  // Optional: acquired by the execution layer for this run.
  runtimeExecution,
});

const result = await sessions.execute({
  organizationId: "org/example",
  agentId: "agent/developer",
  adapter: "opencode_local",
  runtime: { kind: "local", envPassthrough: false },
  cwd: "C:/work/example",
  prompt: "Inspect the repository and summarize the current state.",
  config: {},
  skills: [],
  budget: {},
  idempotencyKey: "run/example/1",
});
```

`SessionsOptions.runtimeExecution` is the runtime-owned process boundary. The
adapter receives it through the Harness context and therefore cannot own
processes, signals, filesystem roots, or provider credentials.

## Session lifecycle

- `start()` warms the configured sources and is idempotent.
- `execute()` creates or claims one durable row, streams semantic events, and
  settles the row exactly once.
- `pause()`/`resume()` maintain pending interaction state.
- `cancel()` requests cancellation through the adapter/runtime boundary.
- `get()` and `list()` read persisted session state and transcript references.

The native session identity returned by OpenCode is stored separately from the
aaspai session row. Resume and fork parameters are serialized through the
OpenCode session codec; a missing or stale native session is reported as a
failure instead of silently starting a different conversation.

## Event and result model

Semantic Harness V2 events are persisted in order (`assistant`, `thinking`,
`tool_call`, `tool_result`, `question`, `permission`, `result`, and `error`).
Raw process output remains diagnostic and is bounded by the Runtime V2 stream
limits. The terminal result includes status, usage, cost when available,
native session identity, and a classified error without secrets.

Questions and permissions are distinct interactions. A caller can answer a
pending question from another process through `resume()`. Duplicate answers
are idempotent; an answer is recorded only after the adapter confirms delivery.

## Scope and security

Sessions may materialize caller-approved skill files inside the run workspace,
but never writes OpenCode auth files, global config, provider installations,
skills homes, or MCP administration state. Credentials are supplied only in the
ephemeral runtime process environment. Session rows and lease metadata are
secret-free.

## Verification

```bash
yarn workspace @aaspai/sessions typecheck
yarn workspace @aaspai/sessions test
yarn check:architecture
```

Credentialed end-to-end Local + Daytona + OpenCode verification is the root
smoke command and writes its report under `.aaspai/artifacts/`:

```bash
yarn test:real:production
```
