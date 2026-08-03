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

Governed maker and checker CLIs may run locally only through the managed
environment and their native sandbox/permission controls. The control plane
persists the CLI session ID so later work can resume the same agentic session.

Independent checkers must end with the structured
`AASPAI_CHECK_RESULT={"verdict":"passed|failed|concerns","summary":"..."}`
line. A zero exit code without this verdict is not verification evidence.

## CLI authentication boundary

The control plane never calls an LLM provider API. Every reasoning run is a
real agentic CLI subprocess:

```text
aaspai worker
  -> codex exec / opencode run
  -> CLI-native authenticated session
  -> CLI-selected model
```

Codex uses its existing `codex login` state. OpenCode uses its existing
`~/.local/share/opencode/auth.json` state. The managed attempt environment
passes the CLI home/path values needed to locate that native state, but it does
not persist credentials in execution plans, workspaces, sessions, or database
records.

## Current Daytona status

The Daytona runtime acquires a sandbox, copies the assigned workspace into it,
streams stdout and stderr, supports timeout and cancellation, and restores the
resulting source changes. A normal release deletes the sandbox. A resumable
release stops it; the next invocation reconnects to the same lease and starts it
before resuming the provider session.

Production runs can select the versioned `aaspai-opencode-1-18-5-v3` Daytona
snapshot through `DAYTONA_SNAPSHOT`. Bootstrap remains as an idempotent fallback
for accounts that have not built the snapshot. The image includes CA
certificates, Git, Chromium, curl, wget, jq, ripgrep, Python, build tools,
archive tools, and a lightweight web-search CLI so agents can use governed web
tools without installing basic operating-system dependencies during each
attempt. Company research agents receive OpenCode web search plus a bounded
`browser_snapshot` tool that accepts only public HTTPS destinations, pins the
resolved address, blocks private address ranges, and caps time and output.

Real Daytona runtime evidence currently covers:

- host input, stdin, and streamed output inside Daytona;
- added, modified, deleted, and binary files restored to the assigned local
  workspace;
- bounded cancellation and timeout of the remote process group;
- public HTTPS fetch, web search, and headless Chromium rendering;
- runtime identity and cleanup of every test lease.

Daytona now advertises resume. Declared artifact collection is worker-owned,
not a runtime-driver capability, so the runtime's generic `artifacts` flag
remains false.

## Real-environment acceptance

The runtime boundary acceptance requires `DAYTONA_API_KEY`:

```sh
yarn workspace @aaspai/runtime test:real:daytona
```

The persisted execution and harness acceptance uses the same environment:

```sh
yarn workspace @aaspai/execution test:real:daytona
```

The complete autonomous-company acceptance uses the authenticated local
OpenCode CLI:

```sh
yarn workspace @aaspai/worker test:real:company:local
yarn workspace @aaspai/worker test:real:zedblock:local
```

Remote CLI execution remains disabled for autonomous-company reasoning until
the selected CLI is authenticated natively inside that remote runtime. Host
authentication files are not copied into Daytona.

## Capability truth

The harness and runtime registries are independent. Check both before a real
run; a ready CLI adapter does not make an unavailable runtime ready, and a
ready runtime does not authenticate the CLI:

```sh
yarn workspace @aaspai/cli start provider capabilities
yarn workspace @aaspai/cli start provider doctor
```

The local company-action broker is attempt-scoped and validated. Remote
company-control execution still needs a secure synchronous bridge; runtime
execution support alone is not remote company-control parity.
