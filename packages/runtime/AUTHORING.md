# `@aaspai/runtime` authoring notes

Runtime V2 is a stateless infrastructure contract. It owns environments,
leases, rooted filesystems, process handles, byte streams, and private
endpoints. It does not own sessions, databases, harnesses, agents, or workspace
sync policy.

## Invariants

- Validate provider config before probe or acquisition.
- Persist only JSON-safe, secret-free lease metadata and execution bindings.
- Treat in-memory SDK objects as caches; resume and destroy must work after the
  provider instance is discarded.
- Keep command and argument vectors separate. Shell execution is explicit.
- Validate environment keys and bound stdout/stderr tails by bytes.
- Preserve stdout/stderr ordering and await output delivery before `wait()`.
- Cancellation is idempotent and resolves only after the exact process group is
  confirmed dead. Timeout is TERM → grace → KILL → confirmed death.
- Keep `releaseLease` distinct from `destroyLease`; cleanup failure overrides a
  claimed success.
- Root every filesystem operation at the realized workspace and reject traversal
  and symlink escapes.
- Never import database, session, company, harness, or adapter-provider code.
- Never install or configure OpenCode/Codex/Claude from runtime code.
- Never use a git remote as cross-run state; workspace sync belongs to execution.

## Provider surface

`RuntimeProvider` is the only provider contract. The production registry exposes
Local and Daytona. Other provider implementations are experimental and are not
registered by `defaultRuntimeRegistry()` until their conformance and release
gates pass.

## Verification

```bash
yarn workspace @aaspai/runtime verify
yarn check:architecture
yarn test:real:production
```

Provider tests must cover every declared capability. The real smoke report is
written under `.aaspai/artifacts/real-production-smoke/` and must contain no
credentials or orphaned Daytona resources.
