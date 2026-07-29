# Managed runtime bypass

## Status

Resolved on `fix/agent-loop-runtime-lifecycle`.

## Evidence

Governed execution supplied a target-routed `execution.run` function, but the
`claude_local` adapter called the host process runner directly. The host runner
also inherited the worker process environment. A plan declaring Docker, SSH,
or Daytona isolation could therefore execute on the worker host with worker
credentials.

## Required outcome

- Managed adapters execute only through the selected runtime target.
- Governed subprocesses receive an allowlisted environment plus their
  attempt-scoped credential.
- Persisted execution fails if the actual runtime identity does not match the
  immutable plan.
- Regression tests cover target routing, environment isolation, and identity
  mismatch.

## Resolution

Managed adapters now route through the selected runtime, governed children use
an environment allowlist, and successful execution requires a matching runtime
identity. Runtime, harness, and execution regression tests cover each boundary.
