# Harnesses and execution runtimes

aaspai is the control plane for agentic CLIs. The selected CLI runs inside the
selected execution runtime:

```text
aaspai worker
  -> immutable execution plan
  -> harness adapter
  -> local, Docker, SSH, or sandbox runtime
  -> agentic CLI
```

For example, an OpenCode attempt targeting Daytona should run OpenCode inside
the Daytona sandbox, against the repository copied or cloned there. The worker
continues to own scheduling, timeout and cancellation policy, session and event
persistence, result collection, verification, and cleanup.

## Responsibility boundaries

| Component | Responsibility |
|---|---|
| Worker and execution store | Durable work, attempts, plans, budgets, events, logs, cancellation, and recovery |
| Harness adapter | CLI command construction, provider-specific configuration, output parsing, usage, and session IDs |
| Runtime target | Environment lease, workspace transfer, command execution, runtime identity, and cleanup |
| Agentic CLI | Reasoning and native tool use for one attempt |
| Target repository | Durable product changes and commits |

Harness adapters do not own Daytona, Docker, or SSH behavior. Runtime targets
do not interpret OpenCode, Codex, or other provider output. This separation
allows the same harness to run in a local worktree or remote sandbox.

Multiple agents receive separate attempts, workspaces, runtime leases, and
harness sessions. A provider session ID is resumable only with compatible
runtime and workspace identity.

## Credential direction

Runtime images should contain CLIs and development tools, but no credentials.
The production direction is:

```text
CLI in runtime
  -> short-lived aaspai attempt token
  -> aaspai LLM gateway
  -> configured model provider
```

The worker requests one expiring credential from the configured gateway before
execution, injects it only into the runtime process environment, and revokes it
before the attempt becomes terminal. Neither the immutable plan nor the
harness-session config contains the token. The gateway keeps permanent provider
credentials outside execution environments and remains the enforcement point
for provider budgets, usage accounting, revocation, and audit.

## Current Daytona status

The Daytona runtime acquires a sandbox, copies the assigned workspace into it,
streams stdout and stderr, supports timeout and cancellation, and restores the
resulting source changes. A normal release deletes the sandbox. A resumable
release stops it; the next invocation reconnects to the same lease and starts it
before resuming the provider session.

Production runs can select the versioned `aaspai-opencode-1-18-5-v1` Daytona
snapshot through `DAYTONA_SNAPSHOT`. Bootstrap remains as an idempotent fallback
for accounts that have not built the snapshot.

Real acceptance evidence currently covers:

- host input, stdin, and streamed output inside Daytona;
- added, modified, deleted, and binary files restored to the assigned local
  workspace;
- bounded cancellation and timeout of the remote process group;
- an authenticated OpenCode tool edit inside Daytona;
- persisted execution-plan, harness-session, raw-output, and normalized event
  records outside the sandbox;
- a real `WorkerDaemon` claim that built and verified a small webpage;
- selected-skill discovery and an observed OpenCode `skill` tool call;
- a durable attempt branch, binary patch, and declared artifact records with
  verified SHA-256 hashes;
- attempt-token issuance, model proxy use, revocation, and a durable-state leak
  check;
- same-lease and same-OpenCode-session resume across two invocations;
- runtime identity and cleanup of every test lease.

Daytona now advertises resume. Declared artifact collection is worker-owned,
not a runtime-driver capability, so the runtime's generic `artifacts` flag
remains false.

## Real-environment acceptance

The runtime acceptance requires `DAYTONA_API_KEY`. Its direct provider-session
resume probe uses an explicitly selected `AASPAI_HOST_AUTH_PATH`:

```sh
yarn workspace @aaspai/runtime test:real:daytona
```

The persisted execution and harness acceptance uses the same environment:

```sh
yarn workspace @aaspai/execution test:real:daytona
```

The complete worker acceptance uses the prebuilt snapshot and an isolated
temporary gateway. The permanent provider credential is installed only in the
gateway sandbox; the agent sandbox receives an expiring attempt token:

```sh
yarn workspace @aaspai/runtime snapshot:daytona
yarn workspace @aaspai/worker test:real:daytona
```

Production must configure a reachable gateway with
`AASPAI_GATEWAY_CONTROL_URL` and `AASPAI_GATEWAY_CONTROL_TOKEN`; the test gateway
is acceptance infrastructure, not the production gateway deployment.
