# `@aaspai/harness` authoring notes

The production harness has one adapter boundary: a run-bound OpenCode server
driver behind `HarnessController`. Do not add provider-specific runtime logic to
this package.

## Invariants

- Receive a runtime execution boundary; never call `child_process`, spawn a
  diagnostic process, or select a runtime provider from an adapter.
- Keep native session identity separate from AASPAI execution identity.
- Emit semantic events once. Raw logs are observational and may be bounded;
  semantic events may not be silently dropped.
- Track every question and permission by its native request ID. Deliver a
  resolution only after the native HTTP response succeeds; duplicate answers
  are idempotent.
- Abort through the native session API and confirm terminal state. Do not replay
  a prompt after transport loss during an active turn.
- Prepared native config is secret-free. Credentials are ephemeral process
  environment values; never write auth stores, provider files, MCP files, or
  OpenCode database state.
- Never use a git remote as cross-run state. The execution workspace handed to
  the adapter is the persistence boundary.

## Adapter surface

Production discovery uses `getProductionAdapter("opencode_local")` and the
controller. `ServerAdapterModule` is an internal native-transport shape;
`HarnessController` turns it into run-bound operations (`events`, `respond`,
`abort`, `fork`, `wait`, `close`) for callers. New code must not expose
adapter-global maps or aliases.

## Verification

Keep protocol fixtures for the pinned OpenCode compatibility line and run:

```bash
yarn workspace @aaspai/harness verify
yarn workspace @aaspai/opencode verify
yarn check:architecture
```
